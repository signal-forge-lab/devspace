import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { git } from "./git.js";
import { attachSerenaMonitorLogging } from "./serena-observability.js";

export const SERENA_SEMANTIC_TOOL_NAMES = [
  "find_symbol",
  "find_declaration",
  "find_implementations",
  "find_referencing_symbols",
  "get_symbols_overview",
  "get_diagnostics_for_file",
  "search_for_pattern",
] as const;

export const SERENA_SEMANTIC_ACTIONS = ["health", ...SERENA_SEMANTIC_TOOL_NAMES] as const;
export const SERENA_REQUIRED_VERSION = "v1.7.0";
export const SERENA_REQUIRED_REVISION = "949a27ef1e5fda1a6e7b561e777bcece345c6ffd";
export const SERENA_STARTUP_TIMEOUT_MSEC = 60_000;
const MAX_SERENA_SESSIONS = 6;

export type SerenaSemanticToolName = (typeof SERENA_SEMANTIC_TOOL_NAMES)[number];
export type SerenaSemanticAction = (typeof SERENA_SEMANTIC_ACTIONS)[number];

export interface SerenaSemanticParameters {
  namePathPattern?: string;
  namePath?: string;
  relativePath?: string;
  regex?: string;
  containingSymbolNamePath?: string;
  substringPattern?: string;
  depth?: number;
  includeBody?: boolean;
  includeInfo?: boolean;
  includeKinds?: number[];
  excludeKinds?: number[];
  substringMatching?: boolean;
  maxMatches?: number;
  maxAnswerChars?: number;
  startLine?: number;
  endLine?: number;
  minSeverity?: number;
  contextLinesBefore?: number;
  contextLinesAfter?: number;
  pathsIncludeGlob?: string;
  pathsExcludeGlob?: string;
  restrictSearchToCodeFiles?: boolean;
  multiline?: boolean;
}

export interface SerenaSemanticClient {
  listTools(): Promise<Array<{ name: string }>>;
  callTool(input: {
    name: SerenaSemanticToolName;
    arguments?: Record<string, unknown>;
  }): Promise<{
    isError?: boolean;
    content?: unknown[];
  }>;
  close(): Promise<void>;
}

export interface SerenaSemanticConnectorInput {
  workspaceId: string;
  workspaceRoot: string;
  serenaHome: string;
  serenaDir: string;
}

export type SerenaSemanticConnector = (
  input: SerenaSemanticConnectorInput,
) => Promise<SerenaSemanticClient>;

export interface SerenaSemanticManagerOptions {
  stateDir: string;
  serenaDir?: string;
  connector?: SerenaSemanticConnector;
}

export function toSerenaSemanticArguments(
  action: SerenaSemanticAction,
  parameters: SerenaSemanticParameters,
): Record<string, unknown> {
  switch (action) {
    case "health":
      return {};
    case "find_symbol":
      return compact({
        name_path_pattern: requiredString(parameters.namePathPattern, "namePathPattern"),
        depth: parameters.depth,
        relative_path: parameters.relativePath,
        include_body: parameters.includeBody,
        include_info: parameters.includeInfo,
        include_kinds: parameters.includeKinds,
        exclude_kinds: parameters.excludeKinds,
        substring_matching: parameters.substringMatching,
        max_matches: parameters.maxMatches,
        max_answer_chars: parameters.maxAnswerChars,
      });
    case "find_declaration":
      return compact({
        relative_path: requiredString(parameters.relativePath, "relativePath"),
        regex: requiredString(parameters.regex, "regex"),
        containing_symbol_name_path: parameters.containingSymbolNamePath,
        include_body: parameters.includeBody,
        include_info: parameters.includeInfo,
      });
    case "find_implementations":
      return compact({
        name_path: requiredString(parameters.namePath, "namePath"),
        relative_path: requiredString(parameters.relativePath, "relativePath"),
        include_info: parameters.includeInfo,
        include_kinds: parameters.includeKinds,
        exclude_kinds: parameters.excludeKinds,
        max_answer_chars: parameters.maxAnswerChars,
      });
    case "find_referencing_symbols":
      return compact({
        name_path: requiredString(parameters.namePath, "namePath"),
        relative_path: requiredString(parameters.relativePath, "relativePath"),
        include_kinds: parameters.includeKinds,
        exclude_kinds: parameters.excludeKinds,
        max_answer_chars: parameters.maxAnswerChars,
      });
    case "get_symbols_overview":
      return compact({
        relative_path: requiredString(parameters.relativePath, "relativePath"),
        depth: parameters.depth,
        max_answer_chars: parameters.maxAnswerChars,
      });
    case "get_diagnostics_for_file":
      return compact({
        relative_path: requiredString(parameters.relativePath, "relativePath"),
        start_line: parameters.startLine,
        end_line: parameters.endLine,
        min_severity: parameters.minSeverity,
        max_answer_chars: parameters.maxAnswerChars,
      });
    case "search_for_pattern":
      return compact({
        substring_pattern: requiredString(parameters.substringPattern, "substringPattern"),
        context_lines_before: parameters.contextLinesBefore,
        context_lines_after: parameters.contextLinesAfter,
        paths_include_glob: parameters.pathsIncludeGlob,
        paths_exclude_glob: parameters.pathsExcludeGlob,
        relative_path: parameters.relativePath,
        restrict_search_to_code_files: parameters.restrictSearchToCodeFiles,
        multiline: parameters.multiline,
        max_answer_chars: parameters.maxAnswerChars,
      });
  }
}

interface BoundSession {
  root: string;
  client: SerenaSemanticClient;
}

export class SerenaSemanticManager {
  private readonly stateDir: string;
  private readonly serenaDir: string;
  private readonly connector: SerenaSemanticConnector;
  private readonly roots = new Map<string, string>();
  private readonly sessions = new Map<string, Promise<BoundSession>>();
  private readonly activeCalls = new Map<string, number>();

  constructor(options: SerenaSemanticManagerOptions) {
    this.stateDir = resolve(options.stateDir);
    this.serenaDir = options.serenaDir ?? defaultSerenaDirectory();
    this.connector = options.connector ?? connectSerena;
  }

  async run(
    workspaceId: string,
    workspaceRoot: string,
    action: SerenaSemanticAction,
    parameters: Record<string, unknown>,
  ): Promise<string> {
    const root = resolve(workspaceRoot);
    this.assertWorkspaceBinding(workspaceId, root);
    this.activeCalls.set(workspaceId, (this.activeCalls.get(workspaceId) ?? 0) + 1);

    try {
      const session = await this.getSession(workspaceId, root);

      if (action === "health") {
        return `ready: ${SERENA_SEMANTIC_TOOL_NAMES.join(", ")}`;
      }

      let response: Awaited<ReturnType<SerenaSemanticClient["callTool"]>>;
      try {
        response = await session.client.callTool({ name: action, arguments: parameters });
      } catch (error) {
        await this.dropSession(workspaceId, session);
        throw error;
      }

      const text = toolResultText(response.content);
      if (response.isError) {
        throw new Error(text || `Serena action ${action} failed.`);
      }
      return text;
    } finally {
      const remainingCalls = Math.max(0, (this.activeCalls.get(workspaceId) ?? 1) - 1);
      if (remainingCalls > 0) {
        this.activeCalls.set(workspaceId, remainingCalls);
      } else {
        this.activeCalls.delete(workspaceId);
        const pending = this.sessions.get(workspaceId);
        if (pending) {
          this.sessions.delete(workspaceId);
          this.sessions.set(workspaceId, pending);
        }
      }
      await this.pruneSessions(workspaceId);
    }
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.activeCalls.clear();
    this.roots.clear();
    const settled = await Promise.allSettled(sessions);
    await Promise.allSettled(
      settled.flatMap((result) => result.status === "fulfilled" ? [result.value.client.close()] : []),
    );
  }

  private assertWorkspaceBinding(workspaceId: string, root: string): void {
    const existingRoot = this.roots.get(workspaceId);
    if (existingRoot && existingRoot !== root) {
      throw new Error(`Workspace ${workspaceId} is already bound to a different root.`);
    }
    this.roots.set(workspaceId, root);
  }

  private async getSession(workspaceId: string, root: string): Promise<BoundSession> {
    const existing = this.sessions.get(workspaceId);
    if (existing) return existing;

    const pending = this.createSession(workspaceId, root);
    this.sessions.set(workspaceId, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.sessions.get(workspaceId) === pending) this.sessions.delete(workspaceId);
      throw error;
    }
  }

  private async createSession(workspaceId: string, root: string): Promise<BoundSession> {
    const serenaHome = join(
      this.stateDir,
      "serena",
      "workspaces",
      createHash("sha256").update(`${workspaceId}\0${root}`).digest("hex").slice(0, 24),
    );
    await writeSerenaConfig(serenaHome);
    const client = await this.connector({
      workspaceId,
      workspaceRoot: root,
      serenaHome,
      serenaDir: this.serenaDir,
    });
    try {
      await assertSemanticToolSurface(client);
      return { root, client };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async dropSession(workspaceId: string, session: BoundSession): Promise<void> {
    const pending = this.sessions.get(workspaceId);
    if (pending && await pending.catch(() => undefined) === session) {
      this.sessions.delete(workspaceId);
      await session.client.close().catch(() => undefined);
    }
  }

  private async pruneSessions(excludedWorkspaceId: string): Promise<void> {
    while (this.sessions.size > MAX_SERENA_SESSIONS) {
      const candidate = [...this.sessions.entries()].find(([workspaceId]) => (
        workspaceId !== excludedWorkspaceId && !this.activeCalls.has(workspaceId)
      ));
      if (!candidate) return;

      const [workspaceId, pending] = candidate;
      this.sessions.delete(workspaceId);
      const session = await pending.catch(() => undefined);
      await session?.client.close().catch(() => undefined);
    }
  }
}

async function writeSerenaConfig(serenaHome: string): Promise<void> {
  const projectData = join(serenaHome, "project-data", ".serena");
  await mkdir(projectData, { recursive: true });
  const config = {
    projects: [],
    gui_log_window: false,
    web_dashboard: false,
    web_dashboard_open_on_launch: false,
    fixed_tools: [...SERENA_SEMANTIC_TOOL_NAMES],
    base_modes: [],
    default_modes: [],
    trusted_project_path_patterns: [],
    project_serena_folder_location: projectData,
  };
  await writeFile(join(serenaHome, "serena_config.yml"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function connectSerena(input: SerenaSemanticConnectorInput): Promise<SerenaSemanticClient> {
  await assertSerenaCheckoutVersion(input.serenaDir);
  const transport = new StdioClientTransport({
    command: "uv",
    args: serenaLaunchArguments(input.serenaDir, input.workspaceRoot),
    env: serenaLaunchEnvironment(input.serenaHome),
    stderr: "pipe",
  });
  const detachLogging = attachSerenaMonitorLogging(transport.stderr, {
    workspaceId: input.workspaceId,
  });
  let startupStderr = "";
  const captureStartupStderr = (chunk: unknown) => {
    startupStderr = `${startupStderr}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`.slice(-8_192);
  };
  transport.stderr?.on("data", captureStartupStderr);
  const client = new Client(
    { name: "workbridge-serena-semantic", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport, { timeout: SERENA_STARTUP_TIMEOUT_MSEC });
  } catch (error) {
    await client.close().catch(() => undefined);
    transport.stderr?.off("data", captureStartupStderr);
    detachLogging();
    throw diagnoseSerenaStartupError(error, startupStderr);
  }
  transport.stderr?.off("data", captureStartupStderr);

  return {
    async listTools() {
      const response = await client.listTools();
      return response.tools.map((tool) => ({ name: tool.name }));
    },
    async callTool(call) {
      const response = await client.callTool({
        name: call.name,
        arguments: call.arguments,
      });
      return {
        isError: response.isError === true,
        content: Array.isArray(response.content) ? response.content : [],
      };
    },
    async close() {
      try {
        await client.close();
      } finally {
        detachLogging();
      }
    },
  };
}

export function diagnoseSerenaStartupError(error: unknown, stderr: string): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const detail = stderr.toLowerCase();
  const accessDenied = detail.includes("access is denied") || detail.includes("os error 5");
  const generatedEnvironment = detail.includes(".venv")
    && (detail.includes("failed to remove") || detail.includes("dist-info"));
  if (!accessDenied || !generatedEnvironment) return original;
  return new Error(
    `Serena environment update failed because its generated .venv could not be replaced (Windows access denied). `
    + `Close Serena/Python processes using the checkout, clear read-only attributes if present, delete/recreate the generated .venv, then retry. `
    + `Original: ${original.message}`,
  );
}

export async function assertSerenaCheckoutVersion(serenaDir: string): Promise<void> {
  let head: string;
  try {
    head = (await git(serenaDir, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  } catch (error) {
    throw new Error(
      `Serena checkout must be a Git repository at ${SERENA_REQUIRED_VERSION}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertSerenaRevision(head);
}

export function assertSerenaRevision(head: string): void {
  if (head.trim() !== SERENA_REQUIRED_REVISION) {
    throw new Error(
      `Serena checkout revision mismatch. Expected ${SERENA_REQUIRED_VERSION} (${SERENA_REQUIRED_REVISION}), got ${head.trim()}.`,
    );
  }
}

export function serenaLaunchEnvironment(serenaHome: string): Record<string, string> {
  return {
    SERENA_HOME: serenaHome,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

export function serenaLaunchArguments(serenaDir: string, workspaceRoot: string): string[] {
  return [
    "run",
    "--python",
    "3.13",
    "--directory",
    serenaDir,
    "serena",
    "start-mcp-server",
    "--project",
    workspaceRoot,
    "--context",
    "ide",
    "--mode",
    "no-memories",
    "--enable-web-dashboard",
    "false",
    "--open-web-dashboard",
    "false",
  ];
}

async function assertSemanticToolSurface(client: SerenaSemanticClient): Promise<void> {
  const tools = await client.listTools();
  const actual = tools.map((tool) => tool.name).sort();
  const expected = [...SERENA_SEMANTIC_TOOL_NAMES].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(
      `Serena semantic tool surface mismatch. Expected exactly: ${expected.join(", ")}; got: ${actual.join(", ")}`,
    );
  }
}

function toolResultText(content: unknown[] | undefined): string {
  if (!content) return "";
  return content
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const block = entry as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n");
}

function requiredString(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export function defaultSerenaDirectory(
  moduleDirectory = dirname(fileURLToPath(import.meta.url)),
  env: NodeJS.ProcessEnv = process.env,
  gitCommonDirectory: (cwd: string) => string | undefined = readGitCommonDirectory,
): string {
  const explicit = env.WORKBRIDGE_SERENA_DIR?.trim();
  if (explicit) return resolve(explicit);

  const workbridgeRoot = resolve(moduleDirectory, "..");
  const sibling = resolve(workbridgeRoot, "..", "serena");
  if (existsSync(sibling)) return sibling;

  const commonDirectory = gitCommonDirectory(workbridgeRoot);
  if (!commonDirectory) return sibling;
  const canonicalSibling = resolve(dirname(resolve(workbridgeRoot, commonDirectory)), "..", "serena");
  return existsSync(canonicalSibling) ? canonicalSibling : sibling;
}

function readGitCommonDirectory(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}
