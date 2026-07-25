import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { PRODUCT_DISPLAY_NAME } from "./branding.js";
import type { ServerConfig } from "./config.js";
import type { IncomingArtifactAdapter } from "./incoming-artifacts.js";
import { logEvent, loggedCommandFields } from "./logger.js";
import { redactPathsInText, workspacePathRedactions } from "./path-redaction.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
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
import type { WorkspaceRegistry } from "./workspaces.js";
import {
  WORKSPACE_ACTION_POLICIES,
  WorkspaceActionResolutionError,
  resolveWorkspaceAction,
} from "./workspace-actions.js";
import {
  WORKSPACE_ACTION_STEP_STATUSES,
  pendingWorkspaceActionSteps,
} from "./workspace-action-plans.js";

export const WORKBRIDGE_FIXED_PUBLIC_TOOL_NAMES = [
  "open_workspace",
  "read",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "run_workspace_action",
  "download_artifact",
] as const;

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
  | { type: "image"; data: string; mimeType: string };

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
  durationMs: number;
  error?: string;
  intent?: string;
  retryContext?: string;
  executed?: boolean;
  executionPolicy?: string;
}

export interface WorkbridgeToolRegistrars {
  registerTool: AppToolRegistrar;
  artifactRegisterTool: AppToolRegistrar;
}

export interface ToolRegistrationMeta extends Record<string, unknown> {
  _meta: Record<string, unknown>;
}

export interface CreateWorkbridgeToolRegistrarsOptions {
  softPause: SoftPauseController;
  workspaces: WorkspaceRegistry;
  monitorContext?: SessionMonitorContext;
}

export interface RegisterWorkbridgeExtensionToolsOptions {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
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

const COMMAND_METADATA_INTENTS = ["inspect", "modify", "verify", "run", "git", "other"] as const;
const COMMAND_METADATA_RETRY_CONTEXTS = [
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

  return `Use ${PRODUCT_DISPLAY_NAME} as a local coding workspace with a fixed tool surface. Call open_workspace once per project folder or worktree and reuse its workspaceId. Use read for direct file reads, apply_patch for all file modifications, exec_command for ad hoc inspection, tests, builds, and commands, write_stdin to poll or interact with running processes, run_workspace_action for registered repeatable actions whose implementation and policy are owned by Workbridge, and download_artifact for MCP-host native files.${artifactInstruction}${patchConsolidationInstruction} Follow instructions returned by open_workspace; read applicable instruction and skill files before working in their scope.${SOFT_PAUSE_SERVER_INSTRUCTION}`;
}

export function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, commandLength, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
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
  softPause,
  workspaces,
  monitorContext,
}: CreateWorkbridgeToolRegistrarsOptions): WorkbridgeToolRegistrars {
  const softPauseRegisterTool = createSoftPauseToolRegistrar(softPause);
  return {
    registerTool: monitorContext
      ? createSessionMonitorToolRegistrar(softPauseRegisterTool, monitorContext, workspaces)
      : softPauseRegisterTool,
    artifactRegisterTool: monitorContext
      ? createSessionMonitorToolRegistrar(registerAppTool, monitorContext, workspaces)
      : registerAppTool,
  };
}

export function registerWorkbridgeExtensionTools({
  server,
  config,
  workspaces,
  processSessions,
  incomingArtifactAdapters,
  registerTool,
  artifactRegisterTool,
  shellToolMeta,
}: RegisterWorkbridgeExtensionToolsOptions): void {
  if (config.toolMode === "codex") {
    registerCodexProcessTools({
      server,
      config,
      workspaces,
      processSessions,
      registerTool,
      shellToolMeta,
    });
  }

  registerWorkspaceActionTool({
    server,
    config,
    workspaces,
    processSessions,
    registerTool,
    shellToolMeta,
  });

  registerArtifactTools(server, {
    config,
    workspaces,
    incomingArtifactAdapters,
    registerTool: artifactRegisterTool,
  });
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
  const execCommandInputSchema: z.ZodRawShape = {
    workspaceId: z.string().describe(WORKSPACE_ID_DESCRIPTION),
    cmd: z.string().min(1).describe("Shell command to execute."),
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
        `Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes. ${WORKSPACE_REUSE_DESCRIPTION}`,
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
      },
      outputSchema: workspaceActionOutputSchema(),
      ...shellToolMeta,
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
        cwd = await workspaces.resolveWorkingDirectory(workspace, workingDirectory);
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
        });
      } catch (error) {
        if (!(error instanceof WorkspaceActionResolutionError)) throw error;

        const result = [
          error.message,
          `Resolution status: ${error.kind}.`,
          "Available workspace actions:",
          JSON.stringify(error.catalog, null, 2),
        ].join("\n");
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
        return rejectedWorkspaceActionResponse({
          action,
          preset,
          result,
          code: error.kind,
          message: error.message,
          catalog: error.catalog,
        });
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
          plannedArtifacts: resolved.artifacts,
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
            artifacts: [],
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
}

function commandMetadataInputSchema(): z.ZodRawShape {
  return {
    intent: z.enum(COMMAND_METADATA_INTENTS).optional().describe(
      "Optional experimental command metadata. Set the closest value when the purpose is obvious. If unsure, omit this field; do not guess.",
    ),
    retryContext: z.enum(COMMAND_METADATA_RETRY_CONTEXTS).optional().describe(
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
