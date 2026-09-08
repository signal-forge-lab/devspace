import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute, resolve } from "node:path";
import * as z from "zod/v4";
import { launchDetachedWorkspaceAction } from "./detached-workspace-action.js";
import {
  AO_OPENAI_CREDENTIAL_NAME,
  loadAoOpenAiApiKeyFromSops,
} from "./ao-sops-credential.js";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { PRODUCT_DISPLAY_NAME } from "./branding.js";
import type { ServerConfig } from "./config.js";
import {
  CODEBASE_MEMORY_ACTIONS,
  CodebaseMemoryManager,
  type CodebaseMemoryAction,
  type CodebaseMemoryParameters,
} from "./codebase-memory-code-intelligence.js";
import type { IncomingArtifactAdapter } from "./incoming-artifacts.js";
import {
  GRAFT_ACTIONS,
  createGraftActionPlan,
  type GraftAction,
  type GraftActionParameters,
} from "./graft-code-intelligence.js";
import { logEvent, loggedCommandFields } from "./logger.js";
import { redactPathsInText, workspacePathRedactions } from "./path-redaction.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { resolveShellCommand } from "./process-platform.js";
import {
  SERENA_SEMANTIC_ACTIONS,
  SerenaSemanticManager,
  toSerenaSemanticArguments,
  type SerenaSemanticAction,
  type SerenaSemanticParameters,
} from "./serena-semantic.js";
import { captureMonitorToolLog } from "./monitor-operation-context.js";
import {
  createSessionMonitorToolRegistrar,
  type AppToolRegistrar,
  type SessionMonitorContext,
} from "./session-monitor-integration.js";
import {
  SoftPauseController,
  SOFT_PAUSE_SERVER_INSTRUCTION,
  SOFT_PAUSE_TOOL_DESCRIPTION,
} from "./soft-pause.js";
import { commandUsageFields, writeWorkbridgeToolUsageLog } from "./workbridge-logging.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import {
  inspectWorkspaceZip,
  publishWorkspaceZip,
  WorkspaceArtifactPublishError,
  type PublishedWorkspaceZip,
  type WorkspaceZipArtifact,
} from "./workspace-artifact-publish.js";
import {
  WORKSPACE_ACTION_POLICIES,
  WorkspaceActionResolutionError,
  resolveWorkspaceAction,
} from "./workspace-actions.js";
import {
  WORKSPACE_ACTION_STEP_STATUSES,
  pendingWorkspaceActionSteps,
} from "./workspace-action-plans.js";
import {
  WORKBRIDGE_EXTENSION_TOOL_NAMES,
  WORKBRIDGE_REVIEW_TOOL_NAME,
} from "./workbridge-tool-policy.js";

export { WORKBRIDGE_EXTENSION_TOOL_NAMES } from "./workbridge-tool-policy.js";

export const WORKSPACE_REUSE_DESCRIPTION =
  "Pass an existing workspaceId. If a workspaceId for this folder is already available in the current conversation, reuse it instead of calling open_workspace again. Call open_workspace only when no workspaceId is available, switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen.";

export const WORKSPACE_ID_DESCRIPTION =
  "Workspace identifier returned by open_workspace. Reuse an existing workspaceId for the same folder when available.";

export const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: {
        uri: string;
        mimeType: "application/zip";
        blob: string;
      };
      annotations: {
        audience: ["assistant", "user"];
        priority: 1;
      };
    };

export interface ToolLogFields {
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
  running?: boolean;
  exitCode?: number;
  signal?: string;
  durationMs: number;
  error?: string;
  instructionDiscoveryStatus?: "complete" | "incomplete";
  instructionDiscoveryReason?: "deadline_exceeded" | "result_limit_exceeded";
  instructionDiscoveryFinder?: "fd" | "node";
  intent?: string;
  retryContext?: string;
  executed?: boolean;
  executionPolicy?: string;
  sessionId?: number;
  outputTruncated?: boolean;
  cancelled?: boolean;
  tty?: boolean;
  shell?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface WorkbridgeToolRegistrars {
  registerTool: AppToolRegistrar;
  artifactRegisterTool: AppToolRegistrar;
}

export interface ToolRegistrationMeta extends Record<string, unknown> {
  _meta: Record<string, unknown>;
}

export interface CreateWorkbridgeToolRegistrarsOptions {
  config: ServerConfig;
  softPause: SoftPauseController;
  workspaces: WorkspaceRegistry;
  monitorContext?: SessionMonitorContext;
  baseRegisterTool?: AppToolRegistrar;
}

export interface RegisterWorkbridgeExtensionToolsOptions {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
  semanticManager: SerenaSemanticManager;
  codebaseMemoryManager: CodebaseMemoryManager;
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[];
  registerTool: AppToolRegistrar;
  artifactRegisterTool: AppToolRegistrar;
  shellToolMeta: ToolRegistrationMeta;
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
  intent?: string;
  retryContext?: string;
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

export const WORKBRIDGE_WINDOWS_SHELL_GUIDANCE = "On Windows, commands run through cmd.exe, not PowerShell. Do not pass PowerShell syntax such as Select-Object, Where-Object, Get-ChildItem, $env:, or [pscustomobject] directly. When PowerShell is required, prefer PowerShell 7 with pwsh -NoProfile -Command \"<PowerShell command>\"; use powershell.exe only when pwsh is unavailable.";
export const WORKBRIDGE_COMMAND_METADATA_INTENTS = ["inspect", "modify", "verify", "run", "git", "other"] as const;
export const WORKBRIDGE_COMMAND_METADATA_RETRY_CONTEXTS = [
  "none",
  "previous_host_safecheck_self_reported",
  "previous_tool_error",
  "previous_output_too_large",
  "split_large_command",
  "other",
] as const;

export function workbridgeServerInstructions(): string {
  const patchConsolidationInstruction =
    " When modifying files, batch related changes aggressively. For each logical implementation step, prepare all intended file edits first, then call apply_patch once with all related file changes. A single apply_patch may update multiple files and multiple hunks. Do not call apply_patch repeatedly for small adjacent edits or one file at a time. Only split patches when the patch failed, the change set is too large to review safely, or the user explicitly asks for separate checkpoints.";
  const artifactInstruction = isArtifactDownloadSupportedPlatform()
    ? " Use download_artifact when the MCP host supplies a native attached or generated file that must be saved into the workspace."
    : " download_artifact remains visible for a stable tool contract but native file download is unsupported on this host platform.";

  const outgoingArtifactInstruction =
    " To return an existing workspace ZIP to the user, call run_workspace_action with action=publish_artifact, preset=embedded_zip, and parameters.path. Never print ZIP or binary Base64 through exec_command.";

  return `Use ${PRODUCT_DISPLAY_NAME} as a local coding workspace. The public tool surface follows the upstream Codex profile, adds Workbridge-owned extensions, and keeps explicitly disabled capabilities out of the runtime. Call open_workspace once per project folder or worktree and reuse its workspaceId. Use read for direct file reads, run_semantic_action for precise read-only symbol/reference/implementation/declaration/diagnostics queries, run_graft_action for lightweight read-only repository orientation and graph lookup, run_codebase_memory_action for persistent architecture/impact/semantic/deep-graph analysis, apply_patch for all file modifications, ${WORKBRIDGE_REVIEW_TOOL_NAME} once after the final related file change for the combined change review, exec_command for ad hoc inspection, tests, builds, and commands, write_stdin to poll or interact with running processes, run_workspace_action for registered repeatable actions whose implementation and policy are owned by Workbridge, and download_artifact for MCP-host native files.${artifactInstruction}${outgoingArtifactInstruction}${patchConsolidationInstruction} Follow instructions returned by open_workspace; read applicable instruction and skill files before working in their scope.${SOFT_PAUSE_SERVER_INSTRUCTION}`;
}

export function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  const operationId = captureMonitorToolLog(fields);
  if (!config.logging.toolCalls) return;

  const { command, commandLength, ...safeFields } = fields;
  writeWorkbridgeToolUsageLog(config.logging, {
    tool: fields.tool,
    workspaceId: fields.workspaceId,
    operationId,
    success: fields.success,
    durationMs: fields.durationMs,
    action: fields.action,
    ...commandUsageFields(fields.tool, command),
  });
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    operationId,
    ...loggedCommandFields(config.logging, fields.tool, command, commandLength),
  });
}

export function createSoftPauseToolRegistrar(
  softPause: SoftPauseController,
  baseRegisterTool: AppToolRegistrar = registerAppTool,
): AppToolRegistrar {
  return ((server, name, definition, handler) => {
    const decoratedDefinition = {
      ...definition,
      description: `${definition.description} ${SOFT_PAUSE_TOOL_DESCRIPTION}`,
    };
    return baseRegisterTool(
      server,
      name,
      decoratedDefinition,
      async (...args: unknown[]) => softPause.decorateToolResult(
        await (handler as (...handlerArgs: unknown[]) => Promise<unknown> | unknown)(...args),
      ),
    );
  }) as AppToolRegistrar;
}

export function createWorkbridgeToolRegistrars({
  config,
  softPause,
  workspaces,
  monitorContext,
  baseRegisterTool = registerAppTool,
}: CreateWorkbridgeToolRegistrarsOptions): WorkbridgeToolRegistrars {
  const softPauseRegisterTool = suppressToolCardsWhenDisabled(
    config,
    createSoftPauseToolRegistrar(softPause, baseRegisterTool),
  );
  const artifactRegisterTool = suppressToolCardsWhenDisabled(config, baseRegisterTool);
  return {
    registerTool: monitorContext
      ? createSessionMonitorToolRegistrar(softPauseRegisterTool, monitorContext, workspaces)
      : softPauseRegisterTool,
    artifactRegisterTool: monitorContext
      ? createSessionMonitorToolRegistrar(artifactRegisterTool, monitorContext, workspaces)
      : artifactRegisterTool,
  };
}

function suppressToolCardsWhenDisabled(
  config: Pick<ServerConfig, "widgets">,
  baseRegisterTool: AppToolRegistrar,
): AppToolRegistrar {
  if (config.widgets !== "off") return baseRegisterTool;
  return ((server, name, definition, handler) => {
    const wrappedHandler = (async (...args: unknown[]) => stripToolCard(
      await (handler as (...handlerArgs: unknown[]) => Promise<unknown> | unknown)(...args),
    )) as typeof handler;
    return baseRegisterTool(server, name, definition, wrappedHandler);
  }) as AppToolRegistrar;
}

function stripToolCard(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  const meta = result._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || !("card" in meta)) return value;
  const { card: _card, ...remainingMeta } = meta as Record<string, unknown>;
  return { ...result, _meta: remainingMeta };
}

export function registerWorkbridgeExtensionTools({
  server,
  config,
  workspaces,
  processSessions,
  semanticManager,
  codebaseMemoryManager,
  incomingArtifactAdapters,
  registerTool,
  artifactRegisterTool,
  shellToolMeta,
}: RegisterWorkbridgeExtensionToolsOptions): void {
  registerWorkspaceActionTool({
    server,
    config,
    workspaces,
    processSessions,
    registerTool,
    shellToolMeta,
  });

  registerAoCredentialStatusTool({
    server,
    config,
    workspaces,
    registerTool,
  });

  registerSemanticActionTool({
    server,
    config,
    workspaces,
    semanticManager,
    registerTool,
  });

  registerGraftActionTool({
    server,
    config,
    workspaces,
    processSessions,
    registerTool,
  });

  registerCodebaseMemoryActionTool({
    server,
    config,
    workspaces,
    codebaseMemoryManager,
    registerTool,
  });

  registerArtifactTools(server, {
    config,
    workspaces,
    incomingArtifactAdapters,
    registerTool: artifactRegisterTool,
  });
}

interface RegisterAoCredentialStatusToolOptions {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  registerTool: AppToolRegistrar;
}

function registerAoCredentialStatusTool({
  server,
  config,
  workspaces,
  registerTool,
}: RegisterAoCredentialStatusToolOptions): void {
  registerTool(
    server,
    "check_ao_credential_status",
    {
      title: "Check AO credential status",
      description:
        `Check whether the canonical AO SOPS credential can be resolved for an open workspace. Returns status only; the credential value is never returned, logged, hashed, or persisted. This tool does not run a workspace command or modify scientific state. ${WORKSPACE_REUSE_DESCRIPTION}`,
      inputSchema: {
        workspaceId: z.string().describe(WORKSPACE_ID_DESCRIPTION),
      },
      outputSchema: {
        workspaceId: z.string(),
        credentialPresent: z.boolean(),
        credentialSource: z.enum(["sops_canonical_store", "none"]),
        secretValueObserved: z.literal(false),
        result: z.string(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        let credential = await loadAoOpenAiApiKeyFromSops({ cwd: workspace.root });
        const credentialPresent = Boolean(credential);
        credential = undefined;
        const credentialSource = credentialPresent ? "sops_canonical_store" : "none";
        const result = [
          `credential_present=${String(credentialPresent).toLowerCase()}`,
          `credential_source=${credentialSource}`,
          "secret_value_observed=false",
        ].join("\n");
        logToolCall(config, {
          tool: "check_ao_credential_status",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          structuredContent: {
            workspaceId,
            credentialPresent,
            credentialSource,
            secretValueObserved: false as const,
            result,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall(config, {
          tool: "check_ao_credential_status",
          workspaceId,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          isError: true,
          content: [textBlock(message)],
          structuredContent: {
            workspaceId,
            credentialPresent: false,
            credentialSource: "none" as const,
            secretValueObserved: false as const,
            result: message,
          },
        };
      }
    },
  );
}

interface RegisterSemanticActionToolOptions {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  semanticManager: SerenaSemanticManager;
  registerTool: AppToolRegistrar;
}

function registerSemanticActionTool({
  server,
  config,
  workspaces,
  semanticManager,
  registerTool,
}: RegisterSemanticActionToolOptions): void {
  registerTool(
    server,
    "run_semantic_action",
    {
      title: "Run semantic action",
      description:
        `Run one read-only Serena semantic query against the exact root of an open workspace. Use this for symbol, declaration, implementation, reference, diagnostics, or semantic pattern queries; use Workbridge read/apply_patch/exec_command for ordinary file access, modifications, and processes. ${WORKSPACE_REUSE_DESCRIPTION}`,
      inputSchema: {
        workspaceId: z.string().describe(WORKSPACE_ID_DESCRIPTION),
        action: z.enum(SERENA_SEMANTIC_ACTIONS).describe(
          "Semantic action. health validates the Serena subprocess and fixed read-only tool surface without changing files.",
        ),
        parameters: z.object(semanticActionParametersSchema()).optional().describe(
          "Action-specific semantic parameters. Only the documented allowlisted fields are forwarded to Serena.",
        ),
      },
      outputSchema: {
        workspaceId: z.string(),
        action: z.enum(SERENA_SEMANTIC_ACTIONS),
        result: z.string(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, action, parameters }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const redactions = workspacePathRedactions(workspace.root);
      const typedAction = action as SerenaSemanticAction;

      try {
        const argumentsForSerena = toSerenaSemanticArguments(
          typedAction,
          (parameters ?? {}) as SerenaSemanticParameters,
        );
        const rawResult = await semanticManager.run(
          workspaceId,
          workspace.root,
          typedAction,
          argumentsForSerena,
        );
        const result = redactPathsInText(rawResult, redactions);
        logToolCall(config, {
          tool: "run_semantic_action",
          workspaceId,
          action: typedAction,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          structuredContent: { workspaceId, action: typedAction, result },
        };
      } catch (error) {
        const message = redactPathsInText(
          error instanceof Error ? error.message : String(error),
          redactions,
        );
        logToolCall(config, {
          tool: "run_semantic_action",
          workspaceId,
          action: typedAction,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          isError: true,
          content: [textBlock(message)],
          structuredContent: { workspaceId, action: typedAction, result: message },
        };
      }
    },
  );
}

function semanticActionParametersSchema(): z.ZodRawShape {
  const maxAnswerChars = z.number().int().min(-1).optional().describe("Maximum Serena result characters. -1 uses Serena's configured default.");
  const symbolKinds = z.array(z.number().int().positive()).optional().describe("Optional LSP symbol-kind integers.");
  return {
    namePathPattern: z.string().min(1).optional().describe("find_symbol name-path pattern."),
    namePath: z.string().min(1).optional().describe("Symbol name path for reference or implementation queries."),
    relativePath: z.string().optional().describe("Workspace-relative file or directory path used by the selected action."),
    regex: z.string().min(1).optional().describe("find_declaration regex containing exactly one capture group around the target symbol."),
    containingSymbolNamePath: z.string().min(1).optional().describe("Optional containing symbol for find_declaration."),
    substringPattern: z.string().min(1).optional().describe("Regular expression for search_for_pattern."),
    depth: z.number().int().min(-1).optional().describe("Symbol descendant depth. -1 lets Serena choose its default where supported."),
    includeBody: z.boolean().optional().describe("Include the matched symbol body where supported."),
    includeInfo: z.boolean().optional().describe("Include hover-like symbol information where supported."),
    includeKinds: symbolKinds,
    excludeKinds: symbolKinds,
    substringMatching: z.boolean().optional().describe("Allow substring matching for the last find_symbol name-path component."),
    maxMatches: z.number().int().refine((value) => value === -1 || value > 0, "maxMatches must be -1 or greater than 0").optional(),
    maxAnswerChars,
    startLine: z.number().int().min(0).optional().describe("First 0-based diagnostics line."),
    endLine: z.number().int().min(-1).optional().describe("Last 0-based diagnostics line; -1 means end of file."),
    minSeverity: z.number().int().min(1).max(4).optional().describe("Minimum LSP severity: 1 error through 4 hint."),
    contextLinesBefore: z.number().int().min(0).optional(),
    contextLinesAfter: z.number().int().min(0).optional(),
    pathsIncludeGlob: z.string().optional(),
    pathsExcludeGlob: z.string().optional(),
    restrictSearchToCodeFiles: z.boolean().optional(),
    multiline: z.boolean().optional(),
  };
}

interface RegisterGraftActionToolOptions {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
  registerTool: AppToolRegistrar;
}

function registerGraftActionTool({
  server,
  config,
  workspaces,
  processSessions,
  registerTool,
}: RegisterGraftActionToolOptions): void {
  registerTool(
    server,
    "run_graft_action",
    {
      title: "Run Graft action",
      description:
        `Run one read-only Graft repository-graph query against the exact root of an open workspace. Use map for unfamiliar-repository orientation and hotspots, ask for conceptual candidate discovery, callers for compressed caller/callee or blast-radius views, skeleton for a file's API surface, grep for indexed exhaustive search, and check for graph freshness. Prefer Serena for precise symbol/declaration/implementation/reference/diagnostics queries and normal read/rg when the location is already known. Workbridge keeps the Graft graph outside the repository and builds it automatically on first query. ${WORKSPACE_REUSE_DESCRIPTION}`,
      inputSchema: {
        workspaceId: z.string().describe(WORKSPACE_ID_DESCRIPTION),
        action: z.enum(GRAFT_ACTIONS).describe("Graft repository-graph action."),
        parameters: z.object(graftActionParametersSchema()).optional().describe(
          "Action-specific parameters. Only the documented allowlisted fields are forwarded to Graft.",
        ),
        yieldTimeMs: z.number().int().min(0).max(30_000).optional().describe(
          "Milliseconds to wait before returning a running session. Defaults to 30000 for Graft.",
        ),
        maxOutputTokens: z.number().int().positive().max(100_000).optional().describe(
          "Approximate output token budget. Defaults to 10000.",
        ),
      },
      outputSchema: processOrWorkspaceActionOutputSchema(),
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, action, parameters, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const typedAction = action as GraftAction;

      try {
        const { graphDir, plan } = createGraftActionPlan({
          action: typedAction,
          parameters: (parameters ?? {}) as GraftActionParameters,
          workspaceRoot: workspace.root,
          stateDir: config.stateDir,
        });
        const redactions = [
          ...workspacePathRedactions(workspace.root),
          { path: graphDir, replacement: "<graft-cache>" },
        ];
        const snapshot = await processSessions.startPlan({
          workspaceId,
          plan,
          cwd: workspace.root,
          workspaceRoot: workspace.root,
          outputRedactions: redactions,
          yieldTimeMs: yieldTimeMs ?? 30_000,
          maxOutputTokens,
          context: {
            kind: "workspace_action",
            contractVersion: WORKSPACE_ACTION_CONTRACT_VERSION,
            action: typedAction,
            preset: "graft",
            policy: ["read_only"],
            profileEvidence: [],
            warnings: [],
            artifacts: [],
            steps: pendingWorkspaceActionSteps(plan),
          },
        });
        logToolCall(config, {
          tool: "run_graft_action",
          workspaceId,
          action: typedAction,
          ...processLogOutcome(snapshot),
          durationMs: Math.round(performance.now() - startedAt),
        });
        return processToolResponse("run_graft_action", workspaceId, snapshot, {
          action: typedAction,
          graphCache: "managed",
        });
      } catch (error) {
        const message = redactPathsInText(
          error instanceof Error ? error.message : String(error),
          workspacePathRedactions(workspace.root),
        );
        const elapsed = Math.round(performance.now() - startedAt);
        logToolCall(config, {
          tool: "run_graft_action",
          workspaceId,
          action: typedAction,
          success: false,
          durationMs: elapsed,
          error: message,
        });
        return {
          ...processToolResponse("run_graft_action", workspaceId, {
            output: message,
            outputTruncated: false,
            running: false,
            exitCode: 1,
            wallTimeMs: elapsed,
          }, { action: typedAction }),
          isError: true,
        };
      }
    },
  );
}

function graftActionParametersSchema(): z.ZodRawShape {
  return {
    query: z.string().min(1).max(4_000).optional().describe("ask query in plain language."),
    symbol: z.string().min(1).max(1_000).optional().describe("callers symbol name; bare, qualified, or package-qualified."),
    file: z.string().min(1).max(2_000).optional().describe("skeleton workspace-relative file path or unique basename."),
    pattern: z.string().min(1).max(4_000).optional().describe("grep regex or literal pattern."),
    scopePath: z.string().min(1).max(2_000).optional().describe("Optional workspace-relative path prefix used by ask/callers/grep."),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum ask results."),
    direction: z.enum(["in", "out"]).optional().describe("callers direction: in for callers, out for callees."),
    depth: z.union([z.number().int().min(1).max(100), z.literal("all")]).optional().describe("callers traversal depth or all."),
    ignoreCase: z.boolean().optional().describe("Case-insensitive grep."),
    fixed: z.boolean().optional().describe("Treat grep pattern as a literal string."),
    maxDirs: z.number().int().min(1).max(100).optional().describe("Maximum directory entries in map output."),
  };
}

interface RegisterCodebaseMemoryActionToolOptions {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  codebaseMemoryManager: CodebaseMemoryManager;
  registerTool: AppToolRegistrar;
}

function registerCodebaseMemoryActionTool({
  server,
  config,
  workspaces,
  codebaseMemoryManager,
  registerTool,
}: RegisterCodebaseMemoryActionToolOptions): void {
  registerTool(
    server,
    "run_codebase_memory_action",
    {
      title: "Run Codebase Memory action",
      description:
        `Run one read-only Codebase Memory persistent-graph query against the exact root of an open workspace. Use architecture for repository structure and boundaries, search for structural/BM25/semantic discovery, trace for caller/callee paths, impact for Git-diff blast radius, snippet for indexed source retrieval, coverage for best-effort index coverage, and query for read-only Cypher-style graph analysis. Prefer Serena when exact symbol/reference/implementation/diagnostics evidence matters; prefer Graft for lightweight repository orientation and quick graph lookup. Workbridge owns the initial moderate index and ongoing local cache outside the repository. Coverage freshness is best-effort on Windows v0.10.8 and must not replace direct source verification for negative or completeness claims. ${WORKSPACE_REUSE_DESCRIPTION}`,
      inputSchema: {
        workspaceId: z.string().describe(WORKSPACE_ID_DESCRIPTION),
        action: z.enum(CODEBASE_MEMORY_ACTIONS).describe("Codebase Memory read-only graph action."),
        parameters: z.object(codebaseMemoryActionParametersSchema()).optional().describe(
          "Action-specific parameters. Only the documented allowlisted fields are forwarded to Codebase Memory.",
        ),
      },
      outputSchema: {
        workspaceId: z.string(),
        action: z.enum(CODEBASE_MEMORY_ACTIONS),
        result: z.string(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, action, parameters }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const redactions = workspacePathRedactions(workspace.root);
      const typedAction = action as CodebaseMemoryAction;
      try {
        const rawResult = await codebaseMemoryManager.run(
          workspaceId,
          workspace.root,
          typedAction,
          (parameters ?? {}) as CodebaseMemoryParameters,
        );
        const result = redactPathsInText(rawResult, redactions);
        logToolCall(config, {
          tool: "run_codebase_memory_action",
          workspaceId,
          action: typedAction,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          structuredContent: { workspaceId, action: typedAction, result },
        };
      } catch (error) {
        const message = redactPathsInText(
          error instanceof Error ? error.message : String(error),
          redactions,
        );
        logToolCall(config, {
          tool: "run_codebase_memory_action",
          workspaceId,
          action: typedAction,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          isError: true,
          content: [textBlock(message)],
          structuredContent: { workspaceId, action: typedAction, result: message },
        };
      }
    },
  );
}

function codebaseMemoryActionParametersSchema(): z.ZodRawShape {
  return {
    path: z.string().min(1).max(2_000).optional().describe("architecture workspace-relative directory prefix."),
    aspects: z.array(z.string().min(1).max(100)).max(20).optional().describe("architecture aspects such as overview, dependencies, hotspots, layers, clusters, or cycles."),
    query: z.string().min(1).max(4_000).optional().describe("search BM25/natural-language query."),
    semanticQuery: z.array(z.string().min(1).max(500)).min(1).max(20).optional().describe("search semantic keywords; moderate indexing is enabled."),
    namePattern: z.string().min(1).max(4_000).optional().describe("search symbol-name regex."),
    label: z.string().min(1).max(200).optional().describe("search graph node label."),
    filePattern: z.string().min(1).max(2_000).optional().describe("search file-path pattern."),
    relationship: z.string().min(1).max(200).optional().describe("search relationship filter."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum search rows."),
    functionName: z.string().min(1).max(2_000).optional().describe("trace function name or qualified name."),
    direction: z.enum(["inbound", "outbound", "both"]).optional().describe("trace/impact traversal direction."),
    depth: z.number().int().min(1).max(15).optional().describe("trace/impact traversal depth."),
    mode: z.enum(["calls", "data_flow", "cross_service"]).optional().describe("trace relationship mode."),
    qualifiedName: z.string().min(1).max(4_000).optional().describe("snippet qualified symbol name from Codebase Memory search."),
    paths: z.array(z.string().min(1).max(2_000)).min(1).max(128).optional().describe("coverage exact workspace-relative file paths."),
    scopes: z.array(z.string().min(1).max(2_000)).min(1).max(32).optional().describe("coverage workspace-relative scope prefixes."),
    cypher: z.string().min(1).max(20_000).optional().describe("Read-only Codebase Memory Cypher-subset query."),
  };
}

interface RegisterProcessToolsOptions {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
  registerTool: AppToolRegistrar;
  shellToolMeta: ToolRegistrationMeta;
}

function registerCodexProcessTools({
  server,
  config,
  workspaces,
  processSessions,
  registerTool,
  shellToolMeta,
}: RegisterProcessToolsOptions): void {
  const windowsShellGuidance = WORKBRIDGE_WINDOWS_SHELL_GUIDANCE;
  const execCommandInputSchema: z.ZodRawShape = {
    workspaceId: z.string().describe(WORKSPACE_ID_DESCRIPTION),
    cmd: z.string().min(1).describe(`Shell command to execute. ${windowsShellGuidance}`),
    tty: z.boolean().optional().describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
    columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
    rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
    workingDirectory: z.string().optional().describe("Working directory relative to the workspace root. Defaults to the workspace root."),
    yieldTimeMs: z.number().int().min(0).max(30_000).optional().describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
    maxOutputTokens: z.number().int().positive().max(100_000).optional().describe("Approximate output token budget. Defaults to 10000."),
    ...commandMetadataInputSchema(),
  };

  registerTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        `Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes. ${windowsShellGuidance} ${WORKSPACE_REUSE_DESCRIPTION}`,
      inputSchema: execCommandInputSchema,
      outputSchema: processOutputSchema(),
      ...shellToolMeta,
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
      const displayWorkingDirectory = redactPathsInText(workingDirectory ?? ".", redactions);
      const cwd = await workspaces.resolveWorkingDirectory(workspace, workingDirectory);
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
        workingDirectory: displayWorkingDirectory,
        command: displayCommand,
        commandLength: displayCommand.length,
        shell: redactPathsInText(resolveShellCommand(cmd).executable, redactions),
        tty: Boolean(tty),
        ...processLogOutcome(snapshot),
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
        "Poll or write characters to a process returned by exec_command, run_workspace_action, or run_graft_action. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command or run_workspace_action."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z.number().int().min(0).max(30_000).optional().describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        maxOutputTokens: z.number().int().positive().max(100_000).optional().describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOrWorkspaceActionOutputSchema(),
      ...shellToolMeta,
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
        ...processLogOutcome(snapshot),
        sessionId,
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

function registerWorkspaceActionTool({
  server,
  config,
  workspaces,
  processSessions,
  registerTool,
  shellToolMeta,
}: RegisterProcessToolsOptions): void {
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
        ...commandMetadataInputSchema(),
      },
      outputSchema: workspaceActionOutputSchema(),
      ...shellToolMeta,
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async (rawInput) => {
      const {
        workspaceId, action, preset, parameters, dryRun, tty, columns, rows,
        workingDirectory, yieldTimeMs, maxOutputTokens, intent, retryContext,
      } = rawInput as WorkspaceActionToolInput;
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const workspaceRedactions = workspaceActionInputRedactions(
        workspace.root,
        workingDirectory,
        parameters,
      );
      const monitorWorkingDirectory = redactPathsInText(
        workingDirectory ?? ".",
        workspaceRedactions,
      );
      let cwd: string;
      try {
        cwd = await workspaces.resolveWorkingDirectory(workspace, workingDirectory);
        if (action === "workspace_verify" && cwd !== workspace.root) {
          throw new Error(
            "workspace_verify is restricted to the workspace root. Use project_verify for a nested workingDirectory.",
          );
        }
      } catch (error) {
        const message = redactPathsInText(
          error instanceof Error ? error.message : String(error),
          workspaceRedactions,
        );
        const result = `Workspace action working directory was rejected: ${message}`;
        const content = [textBlock(result)];
        logToolCall(config, {
          tool: "run_workspace_action",
          workspaceId,
          workingDirectory: monitorWorkingDirectory,
          action,
          preset,
          dryRun: Boolean(dryRun),
          success: false,
          executed: false,
          executionPolicy: "invalid_working_directory",
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
          intent,
          retryContext,
        });
        return rejectedWorkspaceActionResponse({
          action,
          preset,
          result,
          code: "invalid_working_directory",
          message,
        });
      }

      let resolved: Awaited<ReturnType<typeof resolveWorkspaceAction>>;
      try {
        resolved = await resolveWorkspaceAction({
          workspaceRoot: cwd,
          action,
          preset,
          parameters,
          allowedRoots: config.allowedRoots,
        });
      } catch (error) {
        if (!(error instanceof WorkspaceActionResolutionError)) throw error;

        const message = redactPathsInText(error.message, workspaceRedactions);

        const result = [
          message,
          `Resolution status: ${error.kind}.`,
          "Available workspace actions:",
          JSON.stringify(error.catalog, null, 2),
        ].join("\n");
        logToolCall(config, {
          tool: "run_workspace_action",
          workspaceId,
          workingDirectory: monitorWorkingDirectory,
          action,
          preset,
          dryRun: Boolean(dryRun),
          success: false,
          executed: false,
          executionPolicy: error.kind,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
          intent,
          retryContext,
        });
        return rejectedWorkspaceActionResponse({
          action,
          preset,
          result,
          code: error.kind,
          message,
          catalog: error.catalog,
        });
      }

      if (resolved.action === "publish_artifact") {
        return await publishArtifactActionResponse({
          config,
          workspaceId,
          cwd,
          workingDirectory: monitorWorkingDirectory,
          resolved,
          dryRun: Boolean(dryRun),
          startedAt,
        });
      }

      const actionPlan = requiredWorkspaceActionPlan(resolved);

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
          workingDirectory: monitorWorkingDirectory,
          command: resolved.displayCommand,
          commandLength: resolved.displayCommand.length,
          shell: redactPathsInText(
            resolveShellCommand(resolved.displayCommand).executable,
            resolved.outputRedactions ?? workspaceRedactions,
          ),
          tty: Boolean(tty),
          action: resolved.action,
          preset: resolved.preset,
          dryRun: true,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          intent,
          retryContext,
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
            steps: pendingWorkspaceActionSteps(actionPlan),
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

      if (resolved.action === "aegis_runner") {
        try {
          const launchStartedAt = performance.now();
          const launched = await launchDetachedWorkspaceAction({
            workspaceId,
            workspaceRoot: cwd,
            cwd,
            plan: actionPlan,
          });
          const launchDurationMs = Math.round(performance.now() - launchStartedAt);
          const steps = pendingWorkspaceActionSteps(actionPlan);
          if (steps[0]) {
            steps[0].status = "completed";
            steps[0].durationMs = launchDurationMs;
          }
          return completedWorkspaceActionResponse({
            config,
            workspaceId,
            resolved,
            startedAt,
            result: `Detached Aegis Runner launched${launched.pid ? ` with PID ${launched.pid}` : ""}. Observe state/runner_heartbeat.json for runtime health.`,
            steps,
          });
        } catch (error) {
          const message = redactPathsInText(
            error instanceof Error ? error.message : String(error),
            resolved.outputRedactions ?? workspaceRedactions,
          );
          return completedWorkspaceActionResponse({
            config,
            workspaceId,
            resolved,
            startedAt,
            result: `Detached Aegis Runner failed to launch: ${message}`,
            status: "failed",
            executed: false,
            error: { code: "detached_process_start_failed", message },
          });
        }
      }

      let snapshot: ProcessSnapshot;
      try {
        let environmentOverrides: NodeJS.ProcessEnv | undefined;
        if (resolved.action === "ao_registered_python" && resolved.preset !== "help") {
          const credential = await loadAoOpenAiApiKeyFromSops({ cwd });
          if (!credential && resolved.preset !== "credential_presence") {
            throw new Error("The designated AO credential is absent from the canonical SOPS store.");
          }
          if (credential) environmentOverrides = { [AO_OPENAI_CREDENTIAL_NAME]: credential };
        }
        snapshot = await processSessions.startPlan({
          workspaceId,
          plan: actionPlan,
          plannedArtifacts: resolved.artifacts,
          cwd,
          workspaceRoot: cwd,
          environmentOverrides,
          outputRedactions: resolved.outputRedactions,
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
            artifacts: [],
            steps: pendingWorkspaceActionSteps(actionPlan),
          },
        });
      } catch (error) {
        const message = redactPathsInText(
          error instanceof Error ? error.message : String(error),
          resolved.outputRedactions ?? workspaceRedactions,
        );
        const result = `Workspace action process failed to start: ${message}`;
        const content = [textBlock(result)];
        logToolCall(config, {
          tool: "run_workspace_action",
          workspaceId,
          workingDirectory: monitorWorkingDirectory,
          command: resolved.displayCommand,
          commandLength: resolved.displayCommand.length,
          shell: redactPathsInText(
            resolveShellCommand(resolved.displayCommand).executable,
            resolved.outputRedactions ?? workspaceRedactions,
          ),
          tty: Boolean(tty),
          action: resolved.action,
          preset: resolved.preset,
          dryRun: false,
          success: false,
          executed: false,
          executionPolicy: "process_start_failed",
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
          intent,
          retryContext,
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
            steps: pendingWorkspaceActionSteps(actionPlan),
            profileEvidence: resolved.profileEvidence,
            warnings: resolved.warnings,
            artifacts: [],
            result,
            running: false,
            wallTimeMs: 0,
            outputTruncated: false,
            error: { code: "process_start_failed", message },
          },
        };
      }

      logToolCall(config, {
        tool: "run_workspace_action",
        workspaceId,
        workingDirectory: monitorWorkingDirectory,
        command: resolved.displayCommand,
        commandLength: resolved.displayCommand.length,
        shell: redactPathsInText(
          resolveShellCommand(resolved.displayCommand).executable,
          resolved.outputRedactions ?? workspaceRedactions,
        ),
        tty: Boolean(tty),
        action: resolved.action,
        preset: resolved.preset,
        profile: resolved.profile,
        dryRun: false,
        ...processLogOutcome(snapshot),
        durationMs: Math.round(performance.now() - startedAt),
        intent,
        retryContext,
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
}

function completedWorkspaceActionResponse({
  config,
  workspaceId,
  resolved,
  startedAt,
  result,
  content = [textBlock(result)],
  status = "completed",
  executed = true,
  error,
  logFields = {},
  steps = [],
}: {
  config: ServerConfig;
  workspaceId: string;
  resolved: Awaited<ReturnType<typeof resolveWorkspaceAction>>;
  startedAt: number;
  result: string;
  content?: ToolContent[];
  status?: "dry_run" | "completed" | "failed";
  executed?: boolean;
  error?: { code: string; message: string };
  logFields?: Partial<ToolLogFields>;
  steps?: ReturnType<typeof pendingWorkspaceActionSteps>;
}) {
  const elapsed = Math.round(performance.now() - startedAt);
  logToolCall(config, {
    tool: "run_workspace_action",
    workspaceId,
    command: resolved.displayCommand,
    commandLength: resolved.displayCommand.length,
    action: resolved.action,
    preset: resolved.preset,
    dryRun: status === "dry_run",
    success: status !== "failed",
    executed,
    durationMs: elapsed,
    ...logFields,
  });
  return {
    content,
    structuredContent: {
      contractVersion: WORKSPACE_ACTION_CONTRACT_VERSION,
      status,
      action: resolved.action,
      preset: resolved.preset,
      executed,
      policy: resolved.policy,
      commandPreview: resolved.displayCommand,
      steps,
      profileEvidence: resolved.profileEvidence,
      warnings: resolved.warnings,
      artifacts: [],
      result,
      running: false,
      wallTimeMs: elapsed,
      outputTruncated: false,
      error,
    },
  };
}

function workspaceActionInputRedactions(
  workspaceRoot: string,
  workingDirectory: string | undefined,
  parameters: Record<string, unknown> | undefined,
) {
  const redactions = workspacePathRedactions(workspaceRoot);
  if (workingDirectory) {
    const candidate = isAbsolute(workingDirectory)
      ? workingDirectory
      : resolve(workspaceRoot, workingDirectory);
    if (resolve(candidate) !== resolve(workspaceRoot)) {
      redactions.push({ path: candidate, replacement: "<workingDirectory>" });
    }
  }
  for (const [name, value] of Object.entries(parameters ?? {})) {
    if (typeof value === "string" && isAbsolute(value)) {
      redactions.push({ path: value, replacement: `<${name}>` });
    }
  }
  return redactions;
}

export function processLogOutcome(snapshot: ProcessSnapshot): Pick<
  ToolLogFields,
  "success" | "running" | "exitCode" | "signal" | "sessionId" | "outputTruncated" | "cancelled"
> {
  const outcome: Pick<
    ToolLogFields,
    "success" | "running" | "exitCode" | "signal" | "sessionId" | "outputTruncated" | "cancelled"
  > = {
    success: snapshot.running || (
      snapshot.exitCode === 0
      && snapshot.signal === undefined
      && snapshot.cancelled !== true
    ),
    running: snapshot.running,
    exitCode: snapshot.exitCode,
    signal: snapshot.signal,
  };
  if (snapshot.sessionId !== undefined) outcome.sessionId = snapshot.sessionId;
  if (snapshot.outputTruncated) outcome.outputTruncated = true;
  if (snapshot.cancelled) outcome.cancelled = true;
  return outcome;
}

async function publishArtifactActionResponse({
  config,
  workspaceId,
  cwd,
  workingDirectory,
  resolved,
  dryRun,
  startedAt,
}: {
  config: ServerConfig;
  workspaceId: string;
  cwd: string;
  workingDirectory: string;
  resolved: Awaited<ReturnType<typeof resolveWorkspaceAction>>;
  dryRun: boolean;
  startedAt: number;
}) {
  const path = String(resolved.parameters.path ?? "");
  let artifact: WorkspaceZipArtifact | PublishedWorkspaceZip;
  try {
    artifact = dryRun
      ? await inspectWorkspaceZip({ workspaceRoot: cwd, path })
      : await publishWorkspaceZip({ workspaceRoot: cwd, path });
  } catch (error) {
    const code = error instanceof WorkspaceArtifactPublishError
      ? error.code
      : "artifact_publish_failed";
    const message = redactPathsInText(
      error instanceof Error ? error.message : String(error),
      resolved.outputRedactions ?? workspacePathRedactions(cwd),
    );
    const result = `Workspace ZIP publication was rejected: ${message}`;
    logToolCall(config, {
      tool: "run_workspace_action",
      workspaceId,
      command: resolved.displayCommand,
      commandLength: resolved.displayCommand.length,
      workingDirectory,
      action: resolved.action,
      preset: resolved.preset,
      dryRun,
      success: false,
      executed: false,
      executionPolicy: code,
      durationMs: Math.round(performance.now() - startedAt),
      error: message,
    });
    return rejectedWorkspaceActionResponse({
      action: resolved.action,
      preset: resolved.preset,
      result,
      code,
      message,
    });
  }

  const elapsed = Math.round(performance.now() - startedAt);
  const artifactDescription = [
    "Embedded ZIP for MCP-host download.",
    `${artifact.sizeBytes} bytes.`,
    artifact.sha256,
  ].join(" ");
  const artifacts = [{
    path: artifact.path,
    kind: "file" as const,
    description: artifactDescription,
  }];
  const result = dryRun
    ? [
        `Dry run action: ${resolved.action}/${resolved.preset}`,
        `ZIP: ${artifact.path}`,
        `Size: ${artifact.sizeBytes} bytes`,
        `SHA-256: ${artifact.sha256}`,
        `Policy: ${resolved.policy.join(", ")}`,
      ].join("\n")
    : [
        `Published ZIP artifact: ${artifact.fileName}`,
        `Path: ${artifact.path}`,
        `Size: ${artifact.sizeBytes} bytes`,
        `SHA-256: ${artifact.sha256}`,
      ].join("\n");
  const textContent = [textBlock(result)];
  const content: ToolContent[] = dryRun
    ? textContent
    : [
        ...textContent,
        {
          type: "resource",
          resource: {
            uri: artifact.resourceUri,
            mimeType: "application/zip",
            blob: (artifact as PublishedWorkspaceZip).blob,
          },
          annotations: {
            audience: ["assistant", "user"],
            priority: 1,
          },
        },
      ];

  logToolCall(config, {
    tool: "run_workspace_action",
    workspaceId,
    command: resolved.displayCommand,
    commandLength: resolved.displayCommand.length,
    path: artifact.path,
    workingDirectory,
    action: resolved.action,
    preset: resolved.preset,
    dryRun,
    success: true,
    executed: !dryRun,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    durationMs: elapsed,
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
          dryRun,
          path: artifact.path,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
        },
        payload: { content: textContent },
      },
    },
    structuredContent: {
      contractVersion: WORKSPACE_ACTION_CONTRACT_VERSION,
      status: dryRun ? "dry_run" as const : "completed" as const,
      action: resolved.action,
      preset: resolved.preset,
      executed: !dryRun,
      policy: resolved.policy,
      commandPreview: resolved.displayCommand,
      steps: [],
      profileEvidence: resolved.profileEvidence,
      warnings: resolved.warnings,
      artifacts,
      result,
      running: false,
      wallTimeMs: elapsed,
      outputTruncated: false,
    },
  };
}

function requiredWorkspaceActionPlan(
  resolved: Awaited<ReturnType<typeof resolveWorkspaceAction>>,
) {
  if (!resolved.plan) {
    throw new Error(`Workspace action has no process execution plan: ${resolved.action}/${resolved.preset}`);
  }
  return resolved.plan;
}

function commandMetadataInputSchema(): z.ZodRawShape {
  return {
    intent: z.enum(WORKBRIDGE_COMMAND_METADATA_INTENTS).optional().describe(
      "Optional experimental command metadata. Set the closest value when the purpose is obvious. If unsure, omit this field; do not guess.",
    ),
    retryContext: z.enum(WORKBRIDGE_COMMAND_METADATA_RETRY_CONTEXTS).optional().describe(
      "Optional experimental command metadata. Use previous_host_safecheck_self_reported only when retrying after a host-side safety check or blocked tool call. If unsure, omit this field or use none; do not guess. Do not include secrets or sensitive payloads.",
    ),
  };
}

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z.string().describe("Model-readable result text for follow-up reasoning and plain MCP hosts."),
    ...extra,
  };
}

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
    presets: z.array(z.object({ name: z.string(), description: z.string() })),
    policy: z.array(z.enum(WORKSPACE_ACTION_POLICIES)),
  }));
}

function workspaceActionErrorSchema() {
  return z.object({ code: z.string(), message: z.string() });
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

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function processToolResponse(
  tool: "exec_command" | "write_stdin" | "run_workspace_action" | "run_graft_action",
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

function rejectedWorkspaceActionResponse({
  action,
  preset,
  result,
  code,
  message,
  catalog,
}: {
  action: string;
  preset?: string;
  result: string;
  code: string;
  message: string;
  catalog?: unknown;
}) {
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      contractVersion: WORKSPACE_ACTION_CONTRACT_VERSION,
      status: "rejected" as const,
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
      error: { code, message },
      ...(catalog === undefined ? {} : { catalog }),
    },
  };
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function contentText(content: ToolContent[]): string {
  return content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function textSummary(content: ToolContent[]): { lines: number; characters: number } {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}
