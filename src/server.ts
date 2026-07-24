import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch } from "./apply-patch.js";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { LEGACY_SERVICE_NAME, PRODUCT_DISPLAY_NAME } from "./branding.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  classifyHttpRequest,
  logEvent,
  requestIp,
  requestPath,
  loggedCommandFields,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  SoftPauseController,
  SOFT_PAUSE_SERVER_INSTRUCTION,
  SOFT_PAUSE_TOOL_DESCRIPTION,
} from "./soft-pause.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
} from "./mcp-sessions.js";
import {
  redactPathsInText,
  redactPathsInValue,
  workspacePathRedactions,
  type PathRedaction,
} from "./path-redaction.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import {
  WORKSPACE_ACTION_POLICIES,
  WorkspaceActionResolutionError,
  resolveWorkspaceAction,
} from "./workspace-actions.js";
import {
  WORKSPACE_ACTION_STEP_STATUSES,
  pendingWorkspaceActionSteps,
} from "./workspace-action-plans.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import { PACKAGE_VERSION } from "./version.js";
import {
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";

type Transport = StreamableHTTPServerTransport;
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MCP_PRE_USE_IDLE_TIMEOUT_MS = 15 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const MCP_SESSION_WARNING_THRESHOLDS = [128, 512] as const;
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderAvailability[];
  close(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

const WORKSPACE_REUSE_DESCRIPTION =
  "Pass an existing workspaceId. If a workspaceId for this folder is already available in the current conversation, reuse it instead of calling open_workspace again. Call open_workspace only when no workspaceId is available, switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen.";

const WORKSPACE_ID_DESCRIPTION =
  "Workspace identifier returned by open_workspace. Reuse an existing workspaceId for the same folder when available.";

const WORKSPACE_DISPLAY_PATH = "<workspace>";

function displayWorkspacePath(): string {
  return WORKSPACE_DISPLAY_PATH;
}

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  action?: string;
  preset?: string;
  profile?: string;
  dryRun?: boolean;
  affectedFiles?: number;
  additions?: number;
  removals?: number;
  success: boolean;
  durationMs: number;
  error?: string;
  intent?: string;
  retryContext?: string;
  executed?: boolean;
  executionPolicy?: string;
}

function serverInstructions(_config: ServerConfig): string {
  const patchConsolidationInstruction =
    " When modifying files, batch related changes aggressively. For each logical implementation step, prepare all intended file edits first, then call apply_patch once with all related file changes. A single apply_patch may update multiple files and multiple hunks. Do not call apply_patch repeatedly for small adjacent edits or one file at a time. Only split patches when the patch failed, the change set is too large to review safely, or the user explicitly asks for separate checkpoints.";
  const artifactInstruction = isArtifactDownloadSupportedPlatform()
    ? " Use download_artifact when the MCP host supplies a native attached or generated file that must be saved into the workspace."
    : " download_artifact remains visible for a stable tool contract but native file download is unsupported on this host platform.";

  return `Use ${PRODUCT_DISPLAY_NAME} as a local coding workspace with a fixed tool surface. Call ${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for ad hoc inspection, tests, builds, and commands, write_stdin to poll or interact with running processes, run_workspace_action for registered repeatable actions whose implementation and policy are owned by Workbridge, and download_artifact for MCP-host native files.${artifactInstruction}${patchConsolidationInstruction} Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${SOFT_PAUSE_SERVER_INSTRUCTION}`;
}

type AppToolRegistrar = typeof registerAppTool;

function createSoftPauseToolRegistrar(softPause: SoftPauseController): AppToolRegistrar {
  return ((server, name, definition, handler) => {
    const decoratedDefinition = {
      ...definition,
      description: `${definition.description} ${SOFT_PAUSE_TOOL_DESCRIPTION}`,
    };
    return registerAppTool(
      server,
      name,
      decoratedDefinition,
      async (...args: unknown[]) => softPause.decorateToolResult(
        await (handler as (...handlerArgs: unknown[]) => Promise<unknown> | unknown)(...args),
      ),
    );
  }) as AppToolRegistrar;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerAvailable?: boolean;
  providerUnavailableReason?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const thinking = agent.thinking ? `, thinking ${agent.thinking}` : "";
  const availability = agent.providerAvailable === false
    ? `, unavailable: ${agent.providerUnavailableReason ?? "provider unavailable"}`
    : "";
  return `${agent.name} (${agent.provider}${model}${thinking}${availability})`;
}

function formatUnavailableAgentProvider(provider: LocalAgentProviderAvailability): string {
  return `${provider.name} (${provider.reason ?? "unavailable"})`;
}

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  providerAvailable: z.boolean().optional(),
  providerUnavailableReason: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, commandLength, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    ...loggedCommandFields(config.logging, fields.tool, command, commandLength),
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function compactAppliedPatchPath(files: Array<{ path: string }>): string | undefined {
  if (files.length === 0) return undefined;
  const text = files.map((file) => file.path).join(",");
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

const COMMAND_METADATA_INTENTS = ["inspect", "modify", "verify", "run", "git", "other"] as const;
const COMMAND_METADATA_RETRY_CONTEXTS = [
  "none",
  "previous_host_safecheck_self_reported",
  "previous_tool_error",
  "previous_output_too_large",
  "split_large_command",
  "other",
] as const;

function commandMetadataInputSchema(): z.ZodRawShape {
  return {
    intent: z
      .enum(COMMAND_METADATA_INTENTS)
      .optional()
      .describe(
        "Optional experimental command metadata. Set the closest value when the purpose is obvious. If unsure, omit this field; do not guess.",
      ),
    retryContext: z
      .enum(COMMAND_METADATA_RETRY_CONTEXTS)
      .optional()
      .describe(
        "Optional experimental command metadata. Use previous_host_safecheck_self_reported only when retrying after a host-side safety check or blocked tool call. If unsure, omit this field or use none; do not guess. Do not include secrets or sensitive payloads.",
      ),
  };
}

interface ExecCommandInput {
  workspaceId: string;
  cmd: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  workingDirectory?: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  intent?: string;
  retryContext?: string;
}

interface WorkspaceActionToolInput {
  workspaceId: string;
  action: string;
  preset?: string;
  parameters?: Record<string, unknown>;
  dryRun?: boolean;
  tty?: boolean;
  columns?: number;
  rows?: number;
  workingDirectory?: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function redactToolContent(content: ToolContent[], redactions: readonly PathRedaction[]): ToolContent[] {
  if (redactions.length === 0) return content;
  return content.map((item) => {
    if (item.type !== "text") return item;
    return { ...item, text: redactPathsInText(item.text, redactions) };
  });
}

function redactToolResponse<T extends { content: ToolContent[] }>(
  response: T,
  redactions: readonly PathRedaction[],
): T {
  if (redactions.length === 0) return response;
  return {
    ...response,
    content: redactToolContent(response.content, redactions),
    ...(Object.prototype.hasOwnProperty.call(response, "details")
      ? { details: redactPathsInValue((response as T & { details?: unknown }).details, redactions) }
      : {}),
  };
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${PRODUCT_DISPLAY_NAME} Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

const WORKSPACE_ACTION_CONTRACT_VERSION = 2 as const;
const WORKSPACE_ACTION_STATUSES = [
  "dry_run",
  "running",
  "completed",
  "failed",
  "cancelled",
  "rejected",
] as const;

type WorkspaceActionStatus = (typeof WORKSPACE_ACTION_STATUSES)[number];

function processOutputFields(): z.ZodRawShape {
  return {
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
    outputSuppressed: z.boolean().optional(),
  };
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema(processOutputFields());
}

function workspaceActionCatalogSchema() {
  return z.array(z.object({
    action: z.string(),
    description: z.string(),
    defaultPreset: z.string(),
    presets: z.array(z.object({
      name: z.string(),
      description: z.string(),
    })),
    policy: z.array(z.enum(WORKSPACE_ACTION_POLICIES)),
  }));
}

function workspaceActionErrorSchema() {
  return z.object({
    code: z.string(),
    message: z.string(),
  });
}

function workspaceActionStepSchema() {
  return z.object({
    id: z.string(),
    label: z.string(),
    status: z.enum(WORKSPACE_ACTION_STEP_STATUSES),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
  });
}

function workspaceActionArtifactSchema() {
  return z.object({
    path: z.string(),
    kind: z.enum(["file", "directory", "report"]),
    description: z.string().optional(),
  });
}

function workspaceActionOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    ...processOutputFields(),
    contractVersion: z.literal(WORKSPACE_ACTION_CONTRACT_VERSION),
    status: z.enum(WORKSPACE_ACTION_STATUSES),
    action: z.string(),
    preset: z.string().optional(),
    profile: z.string().optional(),
    executed: z.boolean(),
    policy: z.array(z.enum(WORKSPACE_ACTION_POLICIES)),
    commandPreview: z.string().optional(),
    steps: z.array(workspaceActionStepSchema()),
    profileEvidence: z.array(z.string()),
    warnings: z.array(z.string()),
    artifacts: z.array(workspaceActionArtifactSchema()),
    error: workspaceActionErrorSchema().optional(),
    catalog: workspaceActionCatalogSchema().optional(),
  });
}

function processOrWorkspaceActionOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    ...processOutputFields(),
    contractVersion: z.literal(WORKSPACE_ACTION_CONTRACT_VERSION).optional(),
    status: z.enum(WORKSPACE_ACTION_STATUSES).optional(),
    action: z.string().optional(),
    preset: z.string().optional(),
    profile: z.string().optional(),
    executed: z.boolean().optional(),
    policy: z.array(z.enum(WORKSPACE_ACTION_POLICIES)).optional(),
    commandPreview: z.string().optional(),
    steps: z.array(workspaceActionStepSchema()).optional(),
    profileEvidence: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
    artifacts: z.array(workspaceActionArtifactSchema()).optional(),
    error: workspaceActionErrorSchema().optional(),
  });
}

function workspaceActionStatus(snapshot: ProcessSnapshot): WorkspaceActionStatus {
  if (snapshot.running) return "running";
  if (snapshot.cancelled) return "cancelled";
  if (snapshot.exitCode === 0 && !snapshot.signal) return "completed";
  return "failed";
}

function workspaceActionProcessFields(snapshot: ProcessSnapshot): Record<string, unknown> {
  const context = snapshot.context;
  if (context?.kind !== "workspace_action") return {};

  const status = workspaceActionStatus(snapshot);
  const failedStep = context.steps.find((step) => step.status === "failed");
  const error = status === "failed"
    ? {
        code: failedStep ? "step_failed" : snapshot.signal ? "process_signalled" : "process_failed",
        message: failedStep
          ? `Workspace action step failed: ${failedStep.id}.`
          : snapshot.signal
            ? `Workspace action process exited after signal ${snapshot.signal}.`
            : `Workspace action process exited with code ${snapshot.exitCode ?? "unknown"}.`,
      }
    : undefined;

  return {
    contractVersion: context.contractVersion,
    status,
    action: context.action,
    preset: context.preset,
    profile: context.profile,
    executed: true,
    policy: context.policy,
    commandPreview: context.commandPreview,
    steps: context.steps,
    profileEvidence: context.profileEvidence,
    warnings: context.warnings,
    artifacts: context.artifacts,
    error,
  };
}

function processToolResponse(
  tool: "exec_command" | "write_stdin" | "run_workspace_action",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  const actionFields = workspaceActionProcessFields(snapshot);
  const actionSummary = Object.keys(actionFields).length > 0
    ? {
        contractVersion: actionFields.contractVersion,
        status: actionFields.status,
        action: actionFields.action,
        preset: actionFields.preset,
        profile: actionFields.profile,
        executed: actionFields.executed,
        steps: Array.isArray(actionFields.steps)
          ? actionFields.steps.map((step) => {
              if (!step || typeof step !== "object") return step;
              const value = step as Record<string, unknown>;
              return { id: value.id, status: value.status };
            })
          : undefined,
        warnings: actionFields.warnings,
      }
    : {};
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...actionSummary, ...outputSummary },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
      outputSuppressed: snapshot.outputSuppressed,
      ...actionFields,
    },
  };
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  registerTool: AppToolRegistrar,
): void {
  const execCommandInputSchema: z.ZodRawShape = {
    workspaceId: z.string().describe(WORKSPACE_ID_DESCRIPTION),
    cmd: z.string().min(1).describe("Shell command to execute."),
    tty: z
      .boolean()
      .optional()
      .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
    columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
    rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
    workingDirectory: z
      .string()
      .optional()
      .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
    yieldTimeMs: z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .optional()
      .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
    maxOutputTokens: z
      .number()
      .int()
      .positive()
      .max(100_000)
      .optional()
      .describe("Approximate output token budget. Defaults to 10000."),
  };
  Object.assign(execCommandInputSchema, commandMetadataInputSchema());

  registerTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        `Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes. ${WORKSPACE_REUSE_DESCRIPTION}`,
      inputSchema: execCommandInputSchema,
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async (input) => {
      const typedInput = input as unknown as ExecCommandInput;
      const {
        workspaceId,
        cmd,
        tty,
        columns,
        rows,
        workingDirectory,
        yieldTimeMs,
        maxOutputTokens,
        intent,
        retryContext,
      } = typedInput;
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const redactions = workspacePathRedactions(workspace.root);
      const displayCommand = redactPathsInText(cmd, redactions);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const snapshot = await processSessions.start({
        workspaceId,
        command: cmd,
        cwd,
        workspaceRoot: workspace.root,
        outputRedactions: redactions,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: displayCommand,
        commandLength: displayCommand.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        intent,
        retryContext,
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: displayCommand,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command or run_workspace_action. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command or run_workspace_action."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOrWorkspaceActionOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  localAgentProviders: LocalAgentProviderAvailability[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  softPause = new SoftPauseController(config.stateDir),
): McpServer {
  const registerTool = createSoftPauseToolRegistrar(softPause);
  const server = new McpServer(
    {
      name: LEGACY_SERVICE_NAME,
      title: PRODUCT_DISPLAY_NAME,
      version: PACKAGE_VERSION,
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: serverInstructions(config),
    },
  );

  registerTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a local project directory as a coding workspace only when no valid workspaceId is available, switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. Do not use this tool when a valid workspaceId for the same folder is already available in the current conversation; reuse that workspaceId instead. By default this opens the actual checkout; set mode=\"worktree\" when the user asks for an isolated or parallel coding session. Returns a workspaceId, loaded root project instructions, nested instruction file paths, and available skills.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
        skills: z.array(workspaceSkillOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }) => {
      const startedAt = performance.now();
      const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef });
      const redactions = workspacePathRedactions(workspace.root);
      if (config.widgets === "changes") {
        void reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }
      const visibleSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: redactPathsInText(formatPathForPrompt(skill.filePath), redactions),
        }));
      const visibleSkillDiagnostics = redactPathsInValue(workspace.skillDiagnostics, redactions);
      const loadedAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const instruction = "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding.";
      const displayRoot = displayWorkspacePath();
      const displayWorktree = workspace.worktree
        ? { ...workspace.worktree, path: displayRoot }
        : undefined;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `Opened workspace ${workspace.id}`,
            `Root: ${displayRoot}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: displayRoot,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: displayRoot,
            path: displayRoot,
            summary: {
              mode: workspace.mode,
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              skills: visibleSkills.length,
              skillDiagnostics: workspace.skillDiagnostics.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: displayRoot,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot ? displayRoot : undefined,
          worktree: displayWorktree,
          agentsFiles: loadedAgentsFiles,
          availableAgentsFiles: availableAgentsFileOutputs,
          skills: visibleSkills,
          skillDiagnostics: visibleSkillDiagnostics,
          instruction,
        },
      };
    },
  );

  registerTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          `Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. ${WORKSPACE_REUSE_DESCRIPTION}`,
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe(WORKSPACE_ID_DESCRIPTION),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  if (config.toolMode !== "codex") {
  registerTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. ${WORKSPACE_REUSE_DESCRIPTION}`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(WORKSPACE_ID_DESCRIPTION),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. ${WORKSPACE_REUSE_DESCRIPTION}`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(WORKSPACE_ID_DESCRIPTION),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          `Apply one Codex-style patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace. ${WORKSPACE_REUSE_DESCRIPTION} Prefer one apply_patch call for the whole current logical change set: a single patch may contain multiple Add File, Update File, Delete File, and Move File sections. Batch related edits instead of making repeated apply_patch calls for small adjacent edits or one file at a time; split only when a patch failed, the change set is too large to review safely, or the user asks for separate checkpoints.`,
        inputSchema: {
          workspaceId: z
            .string()
            .describe(WORKSPACE_ID_DESCRIPTION),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, patch }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const applied = await applyPatch(workspace.root, patch);
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          path: compactAppliedPatchPath(applied.files),
          affectedFiles: applied.files.length,
          additions: applied.additions,
          removals: applied.removals,
        });

        return {
          content,
          _meta: {
            tool: "apply_patch",
            card: {
              workspaceId,
              path: displayPath,
              summary: {
                files: applied.files.length,
                additions: applied.additions,
                removals: applied.removals,
              },
              files: applied.files,
              payload: { patch: applied.patch },
            },
          },
          structuredContent: {
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        };
      },
    );
  }

  if (config.widgets === "changes") {
    registerTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show aggregate file changes for an open workspace. If the current turn successfully modified files, call this exactly once after the final related file change and before your final response so the user can inspect the combined diff for the turn. Do not call it after every individual file change, and do not skip it because prior file-change tools already displayed per-tool diffs.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(WORKSPACE_ID_DESCRIPTION),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          since: "last_shown",
          markReviewed: true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );
  }

  if (config.toolMode === "full") {
    registerTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          `Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. ${WORKSPACE_REUSE_DESCRIPTION}`,
        inputSchema: {
          workspaceId: z
            .string()
            .describe(WORKSPACE_ID_DESCRIPTION),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description:
          `Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. ${WORKSPACE_REUSE_DESCRIPTION}`,
        inputSchema: {
          workspaceId: z
            .string()
            .describe(WORKSPACE_ID_DESCRIPTION),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          `List a directory inside an open workspace. Use this for directory inspection before reading files. ${WORKSPACE_REUSE_DESCRIPTION}`,
        inputSchema: {
          workspaceId: z
            .string()
            .describe(WORKSPACE_ID_DESCRIPTION),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex") {
  registerTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: config.toolMode === "minimal"
        ? `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. ${WORKSPACE_REUSE_DESCRIPTION} This is powerful local execution and should only be exposed behind strong authentication.`
        : `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. ${WORKSPACE_REUSE_DESCRIPTION} This is powerful local execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(WORKSPACE_ID_DESCRIPTION),
        command: z
          .string()
          .describe(
            `Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const redactions = workspacePathRedactions(workspace.root);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const response = redactToolResponse(await runShellTool(input, {
        cwd,
        root: workspace.root,
      }), redactions);
      const displayCommand = redactPathsInText(input.command, redactions);

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: displayCommand,
          commandLength: displayCommand.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: displayCommand,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: displayCommand,
        commandLength: displayCommand.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.shell,
          card: {
            workspaceId,
            path: workingDirectory,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerCodexProcessTools(
      server,
      config,
      workspaces,
      processSessions,
      registerTool,
    );
  }

  registerTool(
    server,
    "run_workspace_action",
    {
      title: "Run workspace action",
      description:
        `Resolve, validate, and run a registered workspace action. Workbridge owns the concrete command, parameter validation, and policy. Use dryRun to inspect the resolved action without executing it. Unsupported actions return the current registry catalog. ${WORKSPACE_REUSE_DESCRIPTION}`,
      inputSchema: {
        workspaceId: z.string().describe(WORKSPACE_ID_DESCRIPTION),
        action: z.string().min(1).describe("Registered workspace action name. Runtime validation keeps future action additions schema-stable."),
        preset: z.string().optional().describe("Optional named preset. The action default is used when omitted."),
        parameters: z.record(z.string(), z.unknown()).optional().describe("Structured action parameters. Each action validates its own allowlisted fields."),
        dryRun: z.boolean().optional().describe("Resolve and return the concrete command and policy without executing it."),
        tty: z.boolean().optional().describe("Allocate a pseudo-terminal when supported. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z.string().optional().describe("Working directory relative to the workspace root. Defaults to the workspace root and becomes the project root for profile-based actions."),
        yieldTimeMs: z.number().int().min(0).max(30_000).optional().describe("Milliseconds to wait before returning a running session."),
        maxOutputTokens: z.number().int().positive().max(100_000).optional().describe("Approximate output token budget."),
      },
      outputSchema: workspaceActionOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async (rawInput) => {
      const {
        workspaceId, action, preset, parameters, dryRun, tty, columns, rows,
        workingDirectory, yieldTimeMs, maxOutputTokens,
      } = rawInput as WorkspaceActionToolInput;
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      let cwd: string;
      try {
        cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
        if (action === "workspace_verify" && cwd !== workspace.root) {
          throw new Error(
            "workspace_verify is restricted to the workspace root. Use project_verify for a nested workingDirectory.",
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result = `Workspace action working directory was rejected: ${message}`;
        const content = [textBlock(result)];
        logToolCall(config, {
          tool: "run_workspace_action",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          action,
          preset,
          dryRun: Boolean(dryRun),
          success: false,
          executed: false,
          executionPolicy: "invalid_working_directory",
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          content,
          structuredContent: {
            contractVersion: WORKSPACE_ACTION_CONTRACT_VERSION,
            status: "rejected",
            action,
            preset: preset?.trim() || undefined,
            executed: false,
            policy: [],
            steps: [],
            profileEvidence: [],
            warnings: [],
            artifacts: [],
            result,
            running: false,
            wallTimeMs: 0,
            outputTruncated: false,
            error: {
              code: "invalid_working_directory",
              message,
            },
          },
        };
      }
      let resolved: Awaited<ReturnType<typeof resolveWorkspaceAction>>;
      try {
        resolved = await resolveWorkspaceAction({
          workspaceRoot: cwd,
          action,
          preset,
          parameters,
        });
      } catch (error) {
        if (!(error instanceof WorkspaceActionResolutionError)) throw error;

        const result = [
          error.message,
          `Resolution status: ${error.kind}.`,
          "Available workspace actions:",
          JSON.stringify(error.catalog, null, 2),
        ].join("\n");
        const content = [textBlock(result)];
        logToolCall(config, {
          tool: "run_workspace_action",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          action,
          preset,
          dryRun: Boolean(dryRun),
          success: false,
          executed: false,
          executionPolicy: error.kind,
          durationMs: Math.round(performance.now() - startedAt),
          error: error.message,
        });
        return {
          content,
          structuredContent: {
            contractVersion: WORKSPACE_ACTION_CONTRACT_VERSION,
            status: "rejected",
            action,
            preset: preset?.trim() || undefined,
            executed: false,
            policy: [],
            steps: [],
            profileEvidence: [],
            warnings: [],
            artifacts: [],
            result,
            running: false,
            wallTimeMs: 0,
            outputTruncated: false,
            error: {
              code: error.kind,
              message: error.message,
            },
            catalog: error.catalog,
          },
        };
      }
      if (dryRun) {
        const result = [
          `Dry run action: ${resolved.action}/${resolved.preset}`,
          resolved.profile ? `Profile: ${resolved.profile}` : undefined,
          `Command: ${resolved.displayCommand}`,
          `Policy: ${resolved.policy.join(", ")}`,
        ].filter(Boolean).join("\n");
        const content = [textBlock(result)];
        logToolCall(config, {
          tool: "run_workspace_action",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: resolved.displayCommand,
          commandLength: resolved.displayCommand.length,
          action: resolved.action,
          preset: resolved.preset,
          dryRun: true,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content,
          _meta: {
            tool: "run_workspace_action",
            card: {
              workspaceId,
              summary: {
                action: resolved.action,
                preset: resolved.preset,
                profile: resolved.profile,
                dryRun: true,
                command: resolved.displayCommand,
                policy: resolved.policy,
              },
              payload: { content },
            },
          },
          structuredContent: {
            contractVersion: WORKSPACE_ACTION_CONTRACT_VERSION,
            status: "dry_run",
            action: resolved.action,
            preset: resolved.preset,
            profile: resolved.profile,
            executed: false,
            policy: resolved.policy,
            commandPreview: resolved.displayCommand,
            steps: pendingWorkspaceActionSteps(resolved.plan),
            profileEvidence: resolved.profileEvidence,
            warnings: resolved.warnings,
            artifacts: resolved.artifacts,
            result,
            running: false,
            wallTimeMs: 0,
            outputTruncated: false,
          },
        };
      }

      let snapshot: ProcessSnapshot;
      try {
        snapshot = await processSessions.startPlan({
          workspaceId,
          plan: resolved.plan,
          cwd,
          workspaceRoot: cwd,
          outputMode: "full",
          tty,
          columns,
          rows,
          yieldTimeMs,
          maxOutputTokens,
          context: {
            kind: "workspace_action",
            contractVersion: WORKSPACE_ACTION_CONTRACT_VERSION,
            action: resolved.action,
            preset: resolved.preset,
            profile: resolved.profile,
            policy: resolved.policy,
            commandPreview: resolved.displayCommand,
            profileEvidence: resolved.profileEvidence,
            warnings: resolved.warnings,
            artifacts: resolved.artifacts,
            steps: pendingWorkspaceActionSteps(resolved.plan),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result = `Workspace action process failed to start: ${message}`;
        const content = [textBlock(result)];
        logToolCall(config, {
          tool: "run_workspace_action",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: resolved.displayCommand,
          commandLength: resolved.displayCommand.length,
          action: resolved.action,
          preset: resolved.preset,
          dryRun: false,
          success: false,
          executed: false,
          executionPolicy: "process_start_failed",
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          content,
          structuredContent: {
            contractVersion: WORKSPACE_ACTION_CONTRACT_VERSION,
            status: "failed",
            action: resolved.action,
            preset: resolved.preset,
            profile: resolved.profile,
            executed: false,
            policy: resolved.policy,
            commandPreview: resolved.displayCommand,
            steps: pendingWorkspaceActionSteps(resolved.plan),
            profileEvidence: resolved.profileEvidence,
            warnings: resolved.warnings,
            artifacts: resolved.artifacts,
            result,
            running: false,
            wallTimeMs: 0,
            outputTruncated: false,
            error: {
              code: "process_start_failed",
              message,
            },
          },
        };
      }

      logToolCall(config, {
        tool: "run_workspace_action",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: resolved.displayCommand,
        commandLength: resolved.displayCommand.length,
        action: resolved.action,
        preset: resolved.preset,
        profile: resolved.profile,
        dryRun: false,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("run_workspace_action", workspaceId, snapshot, {
        action: resolved.action,
        preset: resolved.preset,
        profile: resolved.profile,
        parameters: resolved.parameters,
        command: resolved.displayCommand,
        policy: resolved.policy,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerArtifactTools(server, {
    config,
    workspaces,
    incomingArtifactAdapters,
  });

  return server;
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpSessionRegistry<Transport>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir, config.workspaceSessionMaxAgeMs);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const softPause = new SoftPauseController(config.stateDir);
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot()
    : [];
  const warnedSessionThresholds = new Set<number>();

  const warnSessionPressureIfNeeded = (
    stats = transports.stats(),
    memory = process.memoryUsage(),
  ) => {
    for (const threshold of MCP_SESSION_WARNING_THRESHOLDS) {
      if (stats.active < threshold) {
        warnedSessionThresholds.delete(threshold);
        continue;
      }
      if (warnedSessionThresholds.has(threshold)) continue;
      warnedSessionThresholds.add(threshold);
      logEvent(config.logging, "warn", "mcp_session_pressure", {
        threshold,
        ...stats,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      });
    }
  };

  const logSessionMetrics = (event = "mcp_session_metrics") => {
    const stats = transports.stats();
    const memory = process.memoryUsage();
    logEvent(config.logging, "info", event, {
      ...stats,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      uptimeSeconds: Math.round(process.uptime()),
    });
    warnSessionPressureIfNeeded(stats, memory);
  };

  const logSessionCloseResults = (
    reason: "pre_use_timeout" | "idle_timeout" | "server_shutdown",
    results: McpSessionCloseResult[],
  ) => {
    for (const result of results) {
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_session_close_failed", {
          reason,
          sessionIdPrefix: sessionIdPrefix(result.sessionId),
          error:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
        });
        continue;
      }

      logEvent(config.logging, "info", "mcp_session_closed", {
        reason,
        sessionIdPrefix: sessionIdPrefix(result.sessionId),
        activeSessionCount: transports.size,
      });
    }
  };

  let sessionCleanupRunning = false;
  const sessionCleanupTimer = setInterval(() => {
    if (sessionCleanupRunning) return;
    sessionCleanupRunning = true;
    void (async () => {
      const preUseResults = await transports.closePreUse(
        MCP_PRE_USE_IDLE_TIMEOUT_MS,
      );
      logSessionCloseResults("pre_use_timeout", preUseResults);
      const idleResults = await transports.closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS);
      logSessionCloseResults("idle_timeout", idleResults);
      logSessionMetrics();
    })().catch((error) => {
      logEvent(config.logging, "warn", "mcp_session_cleanup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      sessionCleanupRunning = false;
    });
  }, MCP_SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();
  logSessionMetrics("mcp_session_metrics_startup");

  if (config.logging.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        classification: classifyHttpRequest(path, res.statusCode),
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: PRODUCT_DISPLAY_NAME,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: LEGACY_SERVICE_NAME });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    const requestMethods = mcpRequestMethods(req.method, req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      requestMethods,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId, requestMethods);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            const metadata = mcpInitializeMetadata(req);
            if (transport) transports.register(newSessionId, transport, metadata);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              activeSessionCount: transports.size,
              clientName: metadata.clientName,
              clientVersion: metadata.clientVersion,
              protocolVersion: metadata.protocolVersion,
              ...requestLogFields(req, config),
            });
            warnSessionPressureIfNeeded();
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId && transports.remove(closedSessionId)) {
            logEvent(config.logging, "info", "mcp_session_closed", {
              reason: "transport_close",
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
              activeSessionCount: transports.size,
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          localAgentProviders,
          incomingArtifactAdapters,
          softPause,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(sessionCleanupTimer);
        const results = await transports.closeAll();
        logSessionCloseResults("server_shutdown", results);
        processSessions.shutdown();
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

function mcpRequestMethods(httpMethod: string, body: unknown): string[] {
  if (httpMethod !== "POST") return [`http/${httpMethod.toLowerCase()}`];
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const method = (message as { method?: unknown }).method;
    return typeof method === "string" && method ? [method] : [];
  });
}

function mcpInitializeMetadata(req: Request): {
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  userAgent?: string;
} {
  const body = req.body;
  const message = Array.isArray(body) ? body.find((entry) => isInitializeRequest(entry)) : body;
  if (!message || typeof message !== "object") {
    return { userAgent: req.get("user-agent") };
  }
  const params = (message as { params?: unknown }).params;
  if (!params || typeof params !== "object") {
    return { userAgent: req.get("user-agent") };
  }
  const clientInfo = (params as { clientInfo?: unknown }).clientInfo;
  return {
    clientName: stringProperty(clientInfo, "name"),
    clientVersion: stringProperty(clientInfo, "version"),
    protocolVersion: stringProperty(params, "protocolVersion"),
    userAgent: req.get("user-agent"),
  };
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim().slice(0, 160) : undefined;
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `${PRODUCT_DISPLAY_NAME} listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    console.log(
      `native artifact download: ${isArtifactDownloadSupportedPlatform() ? "enabled" : `unsupported on ${process.platform}`}`,
    );
    if (config.subagents) {
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
