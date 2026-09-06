import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const CODEBASE_MEMORY_ACTIONS = [
  "architecture",
  "search",
  "trace",
  "impact",
  "snippet",
  "coverage",
  "query",
] as const;

export type CodebaseMemoryAction = (typeof CODEBASE_MEMORY_ACTIONS)[number];

export interface CodebaseMemoryParameters {
  path?: string;
  aspects?: string[];
  query?: string;
  semanticQuery?: string[];
  namePattern?: string;
  label?: string;
  filePattern?: string;
  relationship?: string;
  limit?: number;
  functionName?: string;
  direction?: "inbound" | "outbound" | "both";
  depth?: number;
  mode?: "calls" | "data_flow" | "cross_service";
  qualifiedName?: string;
  paths?: string[];
  scopes?: string[];
  cypher?: string;
}

type CodebaseMemoryToolName =
  | "index_repository"
  | "get_architecture"
  | "search_graph"
  | "trace_path"
  | "detect_changes"
  | "get_code_snippet"
  | "check_index_coverage"
  | "query_graph";

export interface CodebaseMemoryClient {
  listTools(): Promise<Array<{ name: string }>>;
  callTool(input: {
    name: CodebaseMemoryToolName;
    arguments?: Record<string, unknown>;
  }): Promise<{
    isError?: boolean;
    content?: unknown[];
  }>;
  close(): Promise<void>;
}

export interface CodebaseMemoryConnectorInput {
  workspaceRoot: string;
  binaryPath: string;
  cacheDir: string;
  runtimeDir: string;
}

export type CodebaseMemoryConnector = (
  input: CodebaseMemoryConnectorInput,
) => Promise<CodebaseMemoryClient>;

export interface CodebaseMemoryManagerOptions {
  stateDir: string;
  connector?: CodebaseMemoryConnector;
  binaryPath?: string;
}

interface BoundSession {
  root: string;
  project: string;
  client: CodebaseMemoryClient;
}

const CODEBASE_MEMORY_VERSION = "0.10.8";
const CODEBASE_MEMORY_WINDOWS_AMD64_SHA256 =
  "b4b403b1d7c4def3785f148b93f345ce8427858f4f5489ce28580c4387a336a6";
const CODEBASE_MEMORY_STARTUP_TIMEOUT_MSEC = 120_000;
const CODEBASE_MEMORY_INDEX_TIMEOUT_MSEC = 10 * 60_000;
const MAX_CODEBASE_MEMORY_SESSIONS = 4;
const REQUIRED_QUERY_TOOLS: readonly CodebaseMemoryToolName[] = [
  "get_architecture",
  "search_graph",
  "trace_path",
  "detect_changes",
  "get_code_snippet",
  "check_index_coverage",
  "query_graph",
];

const verifiedManagedBinaries = new Map<string, Promise<void>>();

export function toCodebaseMemoryCall(
  action: CodebaseMemoryAction,
  parameters: CodebaseMemoryParameters,
  project: string,
): { name: CodebaseMemoryToolName; arguments: Record<string, unknown> } {
  switch (action) {
    case "architecture":
      return {
        name: "get_architecture",
        arguments: compact({ project, path: parameters.path, aspects: parameters.aspects }),
      };
    case "search":
      if (!parameters.query && !parameters.semanticQuery?.length && !parameters.namePattern) {
        throw new Error("Codebase Memory search requires query, semanticQuery, or namePattern.");
      }
      return {
        name: "search_graph",
        arguments: compact({
          project,
          query: parameters.query,
          semantic_query: parameters.semanticQuery,
          name_pattern: parameters.namePattern,
          label: parameters.label,
          file_pattern: parameters.filePattern,
          relationship: parameters.relationship,
          limit: parameters.limit,
        }),
      };
    case "trace":
      return {
        name: "trace_path",
        arguments: compact({
          project,
          function_name: requiredText(parameters.functionName, "functionName"),
          direction: parameters.direction,
          depth: parameters.depth,
          mode: parameters.mode,
        }),
      };
    case "impact":
      return {
        name: "detect_changes",
        arguments: compact({
          project,
          scope: "impact",
          direction: parameters.direction,
          depth: parameters.depth,
        }),
      };
    case "snippet":
      return {
        name: "get_code_snippet",
        arguments: {
          project,
          qualified_name: requiredText(parameters.qualifiedName, "qualifiedName"),
        },
      };
    case "coverage": {
      const paths = parameters.paths?.filter(Boolean);
      const scopes = parameters.scopes?.filter(Boolean);
      if (!paths?.length && !scopes?.length) {
        throw new Error("Codebase Memory coverage paths or scopes is required.");
      }
      return {
        name: "check_index_coverage",
        arguments: compact({ project, paths, scopes }),
      };
    }
    case "query":
      return {
        name: "query_graph",
        arguments: { project, query: requiredText(parameters.cypher, "cypher") },
      };
  }
}

export class CodebaseMemoryManager {
  private readonly stateDir: string;
  private readonly connector: CodebaseMemoryConnector;
  private readonly binaryPath: string;
  private readonly sessions = new Map<string, Promise<BoundSession>>();
  private readonly roots = new Map<string, string>();

  constructor(options: CodebaseMemoryManagerOptions) {
    this.stateDir = resolve(options.stateDir);
    this.binaryPath = options.binaryPath ?? defaultCodebaseMemoryBinary(this.stateDir);
    this.connector = options.connector ?? connectCodebaseMemory;
  }

  async run(
    workspaceId: string,
    workspaceRoot: string,
    action: CodebaseMemoryAction,
    parameters: CodebaseMemoryParameters,
  ): Promise<string> {
    const root = resolve(workspaceRoot);
    this.assertWorkspaceBinding(workspaceId, root);
    const session = await this.getSession(workspaceId, root);
    const call = toCodebaseMemoryCall(action, parameters, session.project);
    try {
      const response = await session.client.callTool(call);
      const text = toolResultText(response.content);
      if (response.isError) throw new Error(text || `Codebase Memory action ${action} failed.`);
      return text;
    } catch (error) {
      await this.dropSession(workspaceId, session);
      throw error;
    }
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.roots.clear();
    const settled = await Promise.allSettled(sessions);
    await Promise.allSettled(
      settled.flatMap((result) => result.status === "fulfilled" ? [result.value.client.close()] : []),
    );
  }

  private assertWorkspaceBinding(workspaceId: string, root: string): void {
    const existing = this.roots.get(workspaceId);
    if (existing && existing !== root) {
      throw new Error(`Workspace ${workspaceId} is already bound to a different root.`);
    }
    this.roots.set(workspaceId, root);
  }

  private async getSession(workspaceId: string, root: string): Promise<BoundSession> {
    const existing = this.sessions.get(workspaceId);
    if (existing) return existing;
    const pending = this.createSession(root);
    this.sessions.set(workspaceId, pending);
    try {
      const session = await pending;
      await this.pruneSessions(workspaceId);
      return session;
    } catch (error) {
      if (this.sessions.get(workspaceId) === pending) this.sessions.delete(workspaceId);
      throw error;
    }
  }

  private async createSession(root: string): Promise<BoundSession> {
    const cacheDir = join(this.stateDir, "codebase-memory", "cache");
    const runtimeDir = join(this.stateDir, "codebase-memory", "runtime");
    await Promise.all([
      mkdir(cacheDir, { recursive: true, mode: 0o700 }),
      mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
    ]);
    if (this.connector === connectCodebaseMemory) await verifyManagedBinary(this.binaryPath);

    const connection = { workspaceRoot: root, binaryPath: this.binaryPath, cacheDir, runtimeDir };
    const bootstrap = await this.connector(connection);
    let project: string;
    try {
      await assertToolSurface(bootstrap, true);
      const indexed = await bootstrap.callTool({
        name: "index_repository",
        arguments: { repo_path: root, mode: "moderate", persistence: false },
      });
      const text = toolResultText(indexed.content);
      if (indexed.isError) throw new Error(text || "Codebase Memory index bootstrap failed.");
      project = parseIndexedProject(text);
    } finally {
      await bootstrap.close().catch(() => undefined);
    }

    const client = await this.connector(connection);
    try {
      await assertToolSurface(client, false);
      return { root, project, client };
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
    while (this.sessions.size > MAX_CODEBASE_MEMORY_SESSIONS) {
      const candidate = [...this.sessions.entries()].find(([workspaceId]) => workspaceId !== excludedWorkspaceId);
      if (!candidate) return;
      const [workspaceId, pending] = candidate;
      this.sessions.delete(workspaceId);
      const session = await pending.catch(() => undefined);
      await session?.client.close().catch(() => undefined);
    }
  }
}

async function connectCodebaseMemory(input: CodebaseMemoryConnectorInput): Promise<CodebaseMemoryClient> {
  const transport = new StdioClientTransport({
    command: input.binaryPath,
    args: [],
    cwd: input.workspaceRoot,
    env: {
      ...getDefaultEnvironment(),
      CBM_CACHE_DIR: input.cacheDir,
      CBM_RUNTIME_DIR: input.runtimeDir,
      CBM_ALLOWED_ROOT: input.workspaceRoot,
      CBM_LOG_LEVEL: "warn",
    },
    stderr: "pipe",
  });
  const drainStderr = () => undefined;
  transport.stderr?.on("data", drainStderr);
  const client = new Client(
    { name: "workbridge-codebase-memory", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport, { timeout: CODEBASE_MEMORY_STARTUP_TIMEOUT_MSEC });
  } catch (error) {
    await client.close().catch(() => undefined);
    transport.stderr?.off("data", drainStderr);
    throw error;
  }
  return {
    async listTools() {
      const response = await client.listTools();
      return response.tools.map(({ name }) => ({ name }));
    },
    async callTool(call) {
      const timeout = call.name === "index_repository"
        ? CODEBASE_MEMORY_INDEX_TIMEOUT_MSEC
        : CODEBASE_MEMORY_STARTUP_TIMEOUT_MSEC;
      const response = await client.callTool(
        { name: call.name, arguments: call.arguments },
        undefined,
        { timeout },
      );
      return {
        isError: response.isError === true,
        content: Array.isArray(response.content) ? response.content : [],
      };
    },
    async close() {
      try {
        await client.close();
      } finally {
        transport.stderr?.off("data", drainStderr);
      }
    },
  };
}

async function assertToolSurface(client: CodebaseMemoryClient, includeIndex: boolean): Promise<void> {
  const names = new Set((await client.listTools()).map(({ name }) => name));
  const required = includeIndex ? ["index_repository", ...REQUIRED_QUERY_TOOLS] : REQUIRED_QUERY_TOOLS;
  const missing = required.filter((name) => !names.has(name));
  if (missing.length) throw new Error(`Codebase Memory tool surface is missing: ${missing.join(", ")}`);
}

function parseIndexedProject(text: string): string {
  try {
    const parsed = JSON.parse(text) as { project?: unknown; status?: unknown };
    if (typeof parsed.project === "string" && parsed.project) return parsed.project;
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error("Codebase Memory index bootstrap did not return a project identity.");
}

function defaultCodebaseMemoryBinary(stateDir: string): string {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Codebase Memory pilot currently requires the provisioned Windows x64 v0.10.8 binary.");
  }
  return join(stateDir, "codebase-memory", `v${CODEBASE_MEMORY_VERSION}`, "portable", "codebase-memory-mcp.exe");
}

async function verifyManagedBinary(binaryPath: string): Promise<void> {
  const key = resolve(binaryPath);
  let verification = verifiedManagedBinaries.get(key);
  if (!verification) {
    verification = (async () => {
      if (!existsSync(key)) {
        throw new Error(`Codebase Memory v${CODEBASE_MEMORY_VERSION} portable binary is not provisioned.`);
      }
      const digest = await sha256File(key);
      if (digest !== CODEBASE_MEMORY_WINDOWS_AMD64_SHA256) {
        throw new Error("Codebase Memory portable binary checksum mismatch.");
      }
    })().catch((error) => {
      if (verifiedManagedBinaries.get(key) === verification) verifiedManagedBinaries.delete(key);
      throw error;
    });
    verifiedManagedBinaries.set(key, verification);
  }
  return verification;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function toolResultText(content: unknown[] | undefined): string {
  if (!content) return "";
  return content.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const block = entry as { type?: unknown; text?: unknown };
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

function requiredText(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Codebase Memory ${field} is required.`);
  return normalized;
}

function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
