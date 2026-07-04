import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
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
import {
  CODEX_CLI_RUNNER_TOOL_NAME,
  CODEX_RUNNER_ERROR_KIND_VALUES,
  CODEX_RUNNER_MODE_VALUES,
  CODEX_RUNNER_NEXT_ACTION_VALUES,
  CODEX_RUNNER_REASONING_EFFORT_VALUES,
  CODEX_RUNNER_SERVICE_TIER_VALUES,
  CODEX_RUNNER_STATUS_VALUES,
  CODEX_SANDBOX_VALUES,
  runCodexCliRunner,
} from "./codex-cli-runner.js";
import { applyPatch } from "./apply-patch.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  gitCommitFilesTool,
  gitCommitStagedTool,
  gitDiffRangesTool,
  gitRecentCommitsTool,
  gitStageFilesTool,
  gitStageHunksTool,
  gitStatusTool,
  MAX_GIT_DIFF_RANGE_FILES,
  MAX_GIT_DIFF_RANGE_HUNKS,
  MAX_GIT_DIFF_RANGE_LINES,
  MAX_GIT_RECENT_COMMITS,
  MAX_GIT_STAGE_HUNK_EDITS_PER_FILE,
  MAX_GIT_STAGE_HUNK_FILES,
  MAX_GIT_TOOL_FILES,
} from "./git-tools.js";
import {
  closeLogFiles,
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  requestCorrelationFields,
  sessionIdPrefix,
  type RequestCorrelationFields,
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
import {
  editManyFiles,
  MAX_EDIT_MANY_EDITS_PER_FILE,
  MAX_EDIT_MANY_FILES,
} from "./edit-many.js";
import {
  DEFAULT_MAX_TOTAL_CHARACTERS,
  MAX_READ_MANY_FILES,
  readManyFiles,
} from "./read-many.js";
import { analyzeEfficiencyLedger, appendEfficiencyEvent, type EfficiencyClientKind } from "./efficiency-ledger.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import type { OAuthDiagnosticEvent } from "./oauth-store.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { registerSafetyTools } from "./safety-tools-registration.js";
import { bashPreflight, editPreflightIndex } from "./safe-editing.js";
import { WorkspaceIndexStore } from "./workspace-index.js";
import { registerWorkspaceIndexTools } from "./workspace-index-registration.js";
import { registerWorkflowTools } from "./workflow-tools-registration.js";
import { WorkspaceZipExportStore } from "./workspace-zip-export.js";
import { WorkspaceZipImportStore } from "./workspace-zip-import.js";
import { registerZipExportTools } from "./zip-export-registration.js";
import { registerZipImportTools } from "./zip-import-registration.js";
import { registerZipTransferTools } from "./zip-transfer-registration.js";
import { resolveWorkspaceTask, WORKSPACE_TASK_NAMES, workspaceTaskCatalog } from "./workspace-tasks.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { workspaceSnapshot } from "./workspace-snapshot.js";
import {
  DEFAULT_GREP_CONTEXT_LINES,
  DEFAULT_GREP_MAX_FILE_BYTES,
  DEFAULT_GREP_MAX_FILES,
  DEFAULT_GREP_MAX_MATCHES,
  DEFAULT_OUTLINE_MAX_SYMBOLS,
  fileOutline,
  grepContext,
  MAX_GREP_CONTEXT_LINES,
  MAX_GREP_MAX_FILE_BYTES,
  MAX_GREP_MAX_FILES,
  MAX_GREP_MAX_MATCHES,
  MAX_OUTLINE_MAX_SYMBOLS,
} from "./structured-inspection.js";
import { createToolTraceManager } from "./tool-trace.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";

type Transport = StreamableHTTPServerTransport;
const WORKSPACE_APP_URI = "ui://workbridge/workspace-app.html";
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
const toolTraces = createToolTraceManager();
const requestCorrelationStore = new AsyncLocalStorage<RequestCorrelationFields>();
const workspaceIndexes = new WorkspaceIndexStore();
const zipExports = new WorkspaceZipExportStore();
const zipImports = new WorkspaceZipImportStore();
const LEGACY_READ_TOOLS_ENABLED = process.env.DEVSPACE_ENABLE_LEGACY_READ_TOOLS === "1";
const EDIT_MANY_ENABLED = process.env.DEVSPACE_ENABLE_EDIT_MANY === "1";
const ZIP_IMPORT_TOOLS_ENABLED = process.env.DEVSPACE_ENABLE_ZIP_IMPORT_TOOLS === "1";
const ZIP_IMPORT_PROBE_TOOLS_ENABLED = ZIP_IMPORT_TOOLS_ENABLED && process.env.DEVSPACE_ENABLE_ZIP_IMPORT_PROBE_TOOLS === "1";
const ZIP_EXPORT_TOOLS_ENABLED = process.env.DEVSPACE_ENABLE_ZIP_EXPORT_TOOLS === "1";
const CODEX_CLI_ENABLED = process.env.DEVSPACE_ENABLE_CODEX_CLI === "1";
const TASK_TOOLS_ENABLED = process.env.DEVSPACE_ENABLE_TASK_TOOLS === "1";
const WORKFLOW_TOOLS_ENABLED = process.env.DEVSPACE_ENABLE_WORKFLOW_TOOLS === "1";

function workspaceTasksEnabled(): boolean {
  return process.env.WORKBRIDGE_ENABLE_WORKSPACE_TASKS === "1" || process.env.DEVSPACE_ENABLE_WORKSPACE_TASKS === "1";
}

function processToolsEnabled(): boolean {
  return process.env.WORKBRIDGE_ENABLE_PROCESS_TOOLS === "1" || process.env.DEVSPACE_ENABLE_PROCESS_TOOLS === "1";
}

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  close(): void;
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

export interface ToolNames {
  workbridgeGuide: "workbridge_guide";
  workbridgeEfficiencyReport: "workbridge_efficiency_report";
  openWorkspace: "open_workspace";
  workspaceSnapshot: "workspace_snapshot";
  createWorkspaceIndex: "create_workspace_index";
  readIndexRanges: "read_index_ranges";
  readMany: "read_many";
  grepContext: "grep_context";
  fileOutline: "file_outline";
  editMany: "edit_many";
  editPlanPreflight: "edit_plan_preflight";
  editPreflightIndex: "edit_preflight_index";
  editByLineRange: "edit_by_line_range";
  insertByAnchor: "insert_by_anchor";
  replaceSymbol: "replace_symbol";
  safeOperationRouter: "safe_operation_router";
  taskCheckpoint: "task_checkpoint";
  taskResume: "task_resume";
  applyUnifiedPatch: "apply_unified_patch";
  resolveLocator: "resolve_locator";
  applyStructuredEdit: "apply_structured_edit";
  checkWorkspaceInvariants: "check_workspace_invariants";
  recordWorkflowEvent: "record_workflow_event";
  workbridgeRouter: "workbridge_router";
  workbridgeVerify: "workbridge_verify";
  exportWorkspaceZip: "export_workspace_zip";
  createZipDownloadUrl: "create_zip_download_url";
  probeImportFileArgShape: "probe_import_file_arg_shape";
  probeImportFile: "probe_import_file";
  importZipFile: "import_zip_file";
  importZipFromUrl: "import_zip_from_url";
  extractImportedZip: "extract_imported_zip";
  gitStatus: "git_status";
  gitDiffRanges: "git_diff_ranges";
  gitRecentCommits: "git_recent_commits";
  gitStageFiles: "git_stage_files";
  gitCommitFiles: "git_commit_files";
  gitCommitStaged: "git_commit_staged";
  gitStageHunks: "git_stage_hunks";
  recordToolEvent: "record_tool_event";
  bashPreflight: "bash_preflight";
  read: "read";
  write: "write";
  edit: "edit";
  grep: "grep";
  glob: "glob";
  ls: "ls";
  shell: "bash";
  applyPatch: "apply_patch";
  execCommand: "exec_command";
  writeStdin: "write_stdin";
  launchWorkspaceTask: "launch_workspace_task";
}

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  operation?: string;
  fileCount?: number;
  commitMessageLength?: number;
  stagedFiles?: number;
  unstagedFiles?: number;
  untrackedFiles?: number;
  eventCategory?: string;
  eventTool?: string;
  traceId?: string;
  traceSequence?: number;
  requestedFiles?: number;
  succeededFiles?: number;
  failedFiles?: number;
  editCount?: number;
  additions?: number;
  removals?: number;
  resultFiles?: number;
  resultLines?: number;
  resultCharacters?: number;
  returnedCharacters?: number;
  truncated?: boolean;
  limited?: boolean;
  maxTotalCharacters?: number;
  gitStatusLines?: number;
  gitStatusTruncated?: boolean;
  testCommandCandidates?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  sandbox?: string;
  dryRun?: boolean;
  success: boolean;
  durationMs: number;
  error?: string;
}
export function toolNamesFor(_config: ServerConfig): ToolNames {
  return {
    workbridgeGuide: "workbridge_guide",
    workbridgeEfficiencyReport: "workbridge_efficiency_report",
    openWorkspace: "open_workspace",
    workspaceSnapshot: "workspace_snapshot",
    createWorkspaceIndex: "create_workspace_index",
    readIndexRanges: "read_index_ranges",
    readMany: "read_many",
    grepContext: "grep_context",
    fileOutline: "file_outline",
    editMany: "edit_many",
    editPlanPreflight: "edit_plan_preflight",
    editPreflightIndex: "edit_preflight_index",
    editByLineRange: "edit_by_line_range",
    insertByAnchor: "insert_by_anchor",
    replaceSymbol: "replace_symbol",
    safeOperationRouter: "safe_operation_router",
    taskCheckpoint: "task_checkpoint",
    taskResume: "task_resume",
    applyUnifiedPatch: "apply_unified_patch",
    resolveLocator: "resolve_locator",
    applyStructuredEdit: "apply_structured_edit",
    checkWorkspaceInvariants: "check_workspace_invariants",
    recordWorkflowEvent: "record_workflow_event",
    workbridgeRouter: "workbridge_router",
    workbridgeVerify: "workbridge_verify",
    exportWorkspaceZip: "export_workspace_zip",
    createZipDownloadUrl: "create_zip_download_url",
    probeImportFileArgShape: "probe_import_file_arg_shape",
    probeImportFile: "probe_import_file",
    importZipFile: "import_zip_file",
    importZipFromUrl: "import_zip_from_url",
    extractImportedZip: "extract_imported_zip",
    gitStatus: "git_status",
    gitDiffRanges: "git_diff_ranges",
    gitRecentCommits: "git_recent_commits",
    gitStageFiles: "git_stage_files",
    gitCommitFiles: "git_commit_files",
    gitCommitStaged: "git_commit_staged",
    gitStageHunks: "git_stage_hunks",
    recordToolEvent: "record_tool_event",
    bashPreflight: "bash_preflight",
    read: "read",
    write: "write",
    edit: "edit",
    grep: "grep",
    glob: "glob",
    ls: "ls",
    shell: "bash",
    applyPatch: "apply_patch",
    execCommand: "exec_command",
    writeStdin: "write_stdin",
    launchWorkspaceTask: "launch_workspace_task",
  };
}

function serverInstructions(config: ServerConfig, toolNames: ToolNames): string {
  const showChanges = "";
  const legacyRead = LEGACY_READ_TOOLS_ENABLED
    ? " Legacy direct read tools are enabled by env flag."
    : "";
  const editMany = EDIT_MANY_ENABLED
    ? " Multi-file exact replacement is enabled by env flag."
    : "";
  const zipExport = ZIP_EXPORT_TOOLS_ENABLED
    ? " ZIP export/download tools are enabled by env flag."
    : "";
  const processTools = processToolsEnabled()
    ? " Process session tools are enabled by env flag."
    : "";
  const workspaceTasks = workspaceTasksEnabled()
    ? ` Registered workspace task launch is enabled by env flag; use ${toolNames.launchWorkspaceTask} for allowlisted local task entrypoints instead of raw shell commands when a matching task exists.`
    : "";

  if (config.toolMode === "codex") {
    return `Use Workbridge as a local AI workbridge for coding workspaces. Workbridge is the public display name; Workbridge is the legacy internal name kept for compatibility. Call ${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. Codex mode exposes main tools plus ${toolNames.applyPatch}, ${toolNames.execCommand}, and ${toolNames.writeStdin}; fork-origin Workbridge helpers remain hidden. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${workspaceTasks}${showChanges}`;
  }

  if (config.toolMode === "main") {
    return `Use Workbridge as a local AI workbridge for coding workspaces. Main mode exposes upstream-style tools only: ${toolNames.openWorkspace}, ${toolNames.read}, ${toolNames.write}, ${toolNames.edit}, ${toolNames.grep}, ${toolNames.glob}, ${toolNames.ls}, and ${toolNames.shell}. Fork-origin Workbridge helpers remain hidden. Reuse the workspaceId returned by ${toolNames.openWorkspace}.${processTools}${workspaceTasks}${showChanges}`;
  }

  const inspection = isForkToolMode(config)
    ? (config.toolMode !== "full"
      ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are hidden; prefer ${toolNames.workspaceSnapshot}, ${toolNames.fileOutline}, ${toolNames.grepContext}, ${toolNames.createWorkspaceIndex}, and ${toolNames.readIndexRanges} before broad shell commands. `
      : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, ${toolNames.ls}, ${toolNames.workspaceSnapshot}, ${toolNames.grepContext}, and ${toolNames.fileOutline} for file inspection. `)
    : `Use ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, ${toolNames.ls}, and ${toolNames.shell} for inspection. `;
  return `Use Workbridge as a local AI workbridge for coding workspaces. Workbridge is the public display name; Workbridge is the legacy internal name kept for compatibility. Open one workspace, reuse its workspaceId, keep outputs small, and follow AGENTS.md plus project docs for detailed workflow rules. ${inspection}Do not use shell commands to modify project files when an editing tool fits.${legacyRead}${editMany}${zipExport}${processTools}${workspaceTasks}${showChanges}`;}

function isForkToolMode(config: ServerConfig): boolean {
  return config.toolMode === "minimal" || config.toolMode === "full";
}

function isMainExpandedToolMode(config: ServerConfig): boolean {
  return config.toolMode === "main" || config.toolMode === "full" || config.toolMode === "codex";
}

function minimalHiddenToolNames(toolNames: ToolNames): string[] {
  return [
    toolNames.insertByAnchor,
    toolNames.replaceSymbol,
    toolNames.gitRecentCommits,
    toolNames.gitStageFiles,
    toolNames.gitStageHunks,
    toolNames.gitCommitStaged,
    toolNames.write,
    toolNames.grep,
    toolNames.glob,
    toolNames.ls,
  ];
}

function forkToolNames(toolNames: ToolNames): string[] {
  return [
    toolNames.workspaceSnapshot,
    toolNames.editByLineRange,
    toolNames.editPreflightIndex,
    toolNames.createWorkspaceIndex,
    toolNames.readIndexRanges,
    toolNames.gitStatus,
    toolNames.gitDiffRanges,
    toolNames.gitCommitFiles,
    toolNames.grepContext,
    toolNames.fileOutline,
    toolNames.insertByAnchor,
    toolNames.replaceSymbol,
    toolNames.gitRecentCommits,
    toolNames.gitStageFiles,
    toolNames.gitStageHunks,
    toolNames.gitCommitStaged,
    toolNames.workbridgeRouter,
    toolNames.workbridgeVerify,
    toolNames.applyUnifiedPatch,
    toolNames.resolveLocator,
    toolNames.applyStructuredEdit,
    toolNames.checkWorkspaceInvariants,
    toolNames.readMany,
    toolNames.editMany,
  ];
}

export function expectedRegisteredToolNames(config: ServerConfig, toolNames: ToolNames): string[] {
  const names: string[] = [
    toolNames.openWorkspace,
    toolNames.read,
    toolNames.edit,
    toolNames.shell,
  ];

  if (isMainExpandedToolMode(config)) {
    names.push(toolNames.write, toolNames.grep, toolNames.glob, toolNames.ls);
  }

  if (isForkToolMode(config)) {
    names.push(
      toolNames.workspaceSnapshot,
      toolNames.editByLineRange,
      toolNames.editPreflightIndex,
      toolNames.createWorkspaceIndex,
      toolNames.readIndexRanges,
      toolNames.gitStatus,
      toolNames.gitDiffRanges,
      toolNames.gitCommitFiles,
      toolNames.grepContext,
      toolNames.fileOutline,
    );
    if (config.toolMode === "full") {
      names.push(
        toolNames.insertByAnchor,
        toolNames.replaceSymbol,
        toolNames.gitRecentCommits,
        toolNames.gitStageFiles,
        toolNames.gitStageHunks,
        toolNames.gitCommitStaged,
      );
    }
    if (WORKFLOW_TOOLS_ENABLED) names.push(toolNames.workbridgeRouter, toolNames.workbridgeVerify, toolNames.applyUnifiedPatch, toolNames.resolveLocator, toolNames.applyStructuredEdit, toolNames.checkWorkspaceInvariants);
    if (LEGACY_READ_TOOLS_ENABLED) names.push(toolNames.readMany);
    if (EDIT_MANY_ENABLED) names.push(toolNames.editMany);
  }

  if (config.toolMode === "codex") names.push(toolNames.applyPatch, toolNames.execCommand, toolNames.writeStdin);
  else if (processToolsEnabled()) names.push(toolNames.execCommand, toolNames.writeStdin);

  if (CODEX_CLI_ENABLED) names.push(CODEX_CLI_RUNNER_TOOL_NAME);
  if (ZIP_EXPORT_TOOLS_ENABLED) names.push(toolNames.exportWorkspaceZip, toolNames.createZipDownloadUrl);
  if (ZIP_IMPORT_TOOLS_ENABLED) names.push(toolNames.importZipFromUrl, toolNames.extractImportedZip);
  if (ZIP_IMPORT_PROBE_TOOLS_ENABLED) names.push(toolNames.probeImportFileArgShape, toolNames.probeImportFile, toolNames.importZipFile);
  if (workspaceTasksEnabled()) names.push(toolNames.launchWorkspaceTask);
  return Array.from(new Set(names));
}


export function hiddenRegisteredToolNames(config: ServerConfig, toolNames: ToolNames): string[] {
  const hidden: string[] = [
    toolNames.workbridgeGuide,
    toolNames.workbridgeEfficiencyReport,
    toolNames.recordToolEvent,
    toolNames.editPlanPreflight,
    toolNames.safeOperationRouter,
    toolNames.bashPreflight,
    toolNames.taskCheckpoint,
    toolNames.taskResume,
    toolNames.recordWorkflowEvent,
    "show_changes",
  ];

  if (!isForkToolMode(config)) hidden.push(...forkToolNames(toolNames));
  else if (config.toolMode !== "full") hidden.push(...minimalHiddenToolNames(toolNames));

  if (config.toolMode !== "codex") hidden.push(toolNames.applyPatch);
  if (config.toolMode !== "codex" && !processToolsEnabled()) hidden.push(toolNames.execCommand, toolNames.writeStdin);
  if (!isMainExpandedToolMode(config)) hidden.push(toolNames.write, toolNames.grep, toolNames.glob, toolNames.ls);

  if (!CODEX_CLI_ENABLED) hidden.push(CODEX_CLI_RUNNER_TOOL_NAME);
  if (isForkToolMode(config) && !WORKFLOW_TOOLS_ENABLED) hidden.push(toolNames.workbridgeRouter, toolNames.workbridgeVerify, toolNames.applyUnifiedPatch, toolNames.resolveLocator, toolNames.applyStructuredEdit, toolNames.checkWorkspaceInvariants);
  if (!ZIP_EXPORT_TOOLS_ENABLED) hidden.push(toolNames.exportWorkspaceZip, toolNames.createZipDownloadUrl);
  if (!ZIP_IMPORT_TOOLS_ENABLED) hidden.push(toolNames.importZipFromUrl, toolNames.extractImportedZip);
  if (!ZIP_IMPORT_PROBE_TOOLS_ENABLED) hidden.push(toolNames.probeImportFileArgShape, toolNames.probeImportFile, toolNames.importZipFile);
  if (isForkToolMode(config) && !LEGACY_READ_TOOLS_ENABLED) hidden.push(toolNames.readMany);
  if (isForkToolMode(config) && !EDIT_MANY_ENABLED) hidden.push(toolNames.editMany);
  if (!workspaceTasksEnabled()) hidden.push(toolNames.launchWorkspaceTask);

  return Array.from(new Set(hidden)).sort();
}

export function enabledToolProfiles(config: ServerConfig): string[] {
  const profiles = [`tool_mode_${config.toolMode}`, `widgets_${config.widgets}`];
  if (CODEX_CLI_ENABLED) profiles.push("codex_cli");
  if (TASK_TOOLS_ENABLED) profiles.push("task_tools");
  if (WORKFLOW_TOOLS_ENABLED) profiles.push("workflow_tools");
  if (ZIP_EXPORT_TOOLS_ENABLED) profiles.push("zip_export_tools");
  if (ZIP_IMPORT_TOOLS_ENABLED) profiles.push("zip_import_tools");
  if (ZIP_IMPORT_PROBE_TOOLS_ENABLED) profiles.push("zip_import_probe_tools");
  if (processToolsEnabled()) profiles.push("process_tools");
  if (workspaceTasksEnabled()) profiles.push("workspace_tasks");
  if (LEGACY_READ_TOOLS_ENABLED) profiles.push("legacy_read_tools");
  if (EDIT_MANY_ENABLED) profiles.push("edit_many");
  return profiles;
}

function logToolRegistrySummary(config: ServerConfig, toolNames: ToolNames): void {
  const tools = expectedRegisteredToolNames(config, toolNames).sort();
  const hiddenTools = hiddenRegisteredToolNames(config, toolNames);
  const registryHash = createHash("sha256").update(JSON.stringify({ tools, hiddenTools })).digest("hex").slice(0, 16);
  const featureFlags = {
    legacyReadTools: LEGACY_READ_TOOLS_ENABLED,
    editMany: EDIT_MANY_ENABLED,
    zipImportTools: ZIP_IMPORT_TOOLS_ENABLED,
    zipImportProbeTools: ZIP_IMPORT_PROBE_TOOLS_ENABLED,
    zipExportTools: ZIP_EXPORT_TOOLS_ENABLED,
    processTools: processToolsEnabled(),
    workspaceTasks: workspaceTasksEnabled(),
    codexCli: CODEX_CLI_ENABLED,
    taskTools: TASK_TOOLS_ENABLED,
    workflowTools: WORKFLOW_TOOLS_ENABLED,
    toolMode: config.toolMode,
    widgets: config.widgets,
  };
  logEvent(config.logging, "info", "tool_registry_summary", {
    toolCount: tools.length,
    hiddenToolCount: hiddenTools.length,
    enabledProfiles: enabledToolProfiles(config),
    featureFlags,
    registryHash,
    detail: false,
  });
  if (process.env.DEVSPACE_LOG_TOOL_REGISTRY_DETAIL === "1") {
    logEvent(config.logging, "debug", "tool_registry_summary_detail", {
      toolCount: tools.length,
      tools,
      hiddenToolCount: hiddenTools.length,
      hiddenTools,
      enabledProfiles: enabledToolProfiles(config),
      featureFlags,
      registryHash,
      detail: true,
    });
  }
}

function optionalFeatureHints(): Array<{ feature: string; enabled: boolean; enableWith: string; tools: string[] }> {
  return [
    {
      feature: "workspace_tasks",
      enabled: workspaceTasksEnabled(),
      enableWith: "WORKBRIDGE_ENABLE_WORKSPACE_TASKS=1",
      tools: ["launch_workspace_task"],
    },
    {
      feature: "process_tools",
      enabled: processToolsEnabled(),
      enableWith: "WORKBRIDGE_ENABLE_PROCESS_TOOLS=1",
      tools: ["exec_command", "write_stdin"],
    },
    {
      feature: "workflow_tools",
      enabled: WORKFLOW_TOOLS_ENABLED,
      enableWith: "DEVSPACE_ENABLE_WORKFLOW_TOOLS=1",
      tools: ["workbridge_verify", "workbridge_router", "apply_unified_patch", "apply_structured_edit"],
    },
    {
      feature: "zip_export_tools",
      enabled: ZIP_EXPORT_TOOLS_ENABLED,
      enableWith: "DEVSPACE_ENABLE_ZIP_EXPORT_TOOLS=1",
      tools: ["export_workspace_zip", "create_zip_download_url"],
    },
  ];
}

function openWorkspaceToolSurface(config: ServerConfig, toolNames: ToolNames): Record<string, unknown> {
  const optionalFeatures = optionalFeatureHints();
  return {
    toolMode: config.toolMode,
    widgets: config.widgets,
    enabledProfiles: enabledToolProfiles(config),
    enabledOptionalFeatures: optionalFeatures.filter((feature) => feature.enabled),
    disabledOptionalFeatures: optionalFeatures.filter((feature) => !feature.enabled),
    visibleTools: expectedRegisteredToolNames(config, toolNames),
    hiddenTools: hiddenRegisteredToolNames(config, toolNames),
  };
}

function openWorkspaceRecommendedWorkflow(config: ServerConfig): Record<string, unknown> {
  return {
    inspect: ["workspace_snapshot", "grep_context", "file_outline", "create_workspace_index", "read_index_ranges"],
    edit: config.toolMode === "codex"
      ? ["apply_patch", "read"]
      : ["edit_by_line_range", "edit", "apply_patch when codex mode"],
    verify: WORKFLOW_TOOLS_ENABLED
      ? ["workbridge_verify", "git_diff_check", "typecheck_only", "build"]
      : ["bash for bounded verification", "enable DEVSPACE_ENABLE_WORKFLOW_TOOLS=1 for workbridge_verify"],
    command: [
      workspaceTasksEnabled() ? "launch_workspace_task for registered local tasks" : "enable WORKBRIDGE_ENABLE_WORKSPACE_TASKS=1 for registered local tasks",
      processToolsEnabled() || config.toolMode === "codex" ? "exec_command + write_stdin for long-running or interactive commands" : "bash for short bounded commands",
    ],
    git: ["git_status", "git_diff_ranges", "git_commit_files"],
    nextRecommendedCalls: ["workspace_snapshot"],
  };
}

function openWorkspaceStrategies(config: ServerConfig): Record<string, unknown> {
  return {
    edit: {
      codexPatch: "apply_patch",
      hashGuardedUnifiedDiff: WORKFLOW_TOOLS_ENABLED ? "apply_unified_patch" : "enable DEVSPACE_ENABLE_WORKFLOW_TOOLS=1",
      smallTargetedEdit: "edit_by_line_range or edit",
      structuredSensitiveEdit: WORKFLOW_TOOLS_ENABLED ? "apply_structured_edit" : "enable DEVSPACE_ENABLE_WORKFLOW_TOOLS=1",
      avoid: ["shell redirection", "tee", "sed -i", "ad-hoc scripts for file mutation"],
    },
    command: {
      registeredLocalTask: workspaceTasksEnabled() ? "launch_workspace_task" : "enable WORKBRIDGE_ENABLE_WORKSPACE_TASKS=1",
      fixedVerification: WORKFLOW_TOOLS_ENABLED ? "workbridge_verify" : "enable DEVSPACE_ENABLE_WORKFLOW_TOOLS=1",
      shortBoundedCommand: "bash",
      longRunningOrInteractive: processToolsEnabled() || config.toolMode === "codex" ? "exec_command + write_stdin" : "enable WORKBRIDGE_ENABLE_PROCESS_TOOLS=1 or use codex mode",
      avoid: ["raw shell command when a registered workspace task exists", "repeating blocked command shapes"],
    },
    git: {
      inspectStatus: "git_status",
      inspectDiff: "git_diff_ranges",
      commitSelectedFiles: "git_commit_files",
      avoid: ["git add && git commit as raw shell when git_commit_files fits"],
    },
  };
}

function openWorkspaceVerificationProfiles(): Record<string, unknown> {
  return {
    enabled: WORKFLOW_TOOLS_ENABLED,
    enableWith: "DEVSPACE_ENABLE_WORKFLOW_TOOLS=1",
    profiles: [
      "typecheck_only",
      "related_tests",
      "workflow_tools_test",
      "safe_editing_test",
      "npm_test",
      "build",
      "git_diff_check",
      "git_diff_cached_check",
      "git_status_check",
    ],
    recommended: ["typecheck_only", "related_tests", "build", "git_diff_check", "git_status_check"],
  };
}
function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Plain text summary for MCP hosts.",
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

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const readManyFileOutputSchema = z.object({
  path: z.string(),
  ok: z.boolean(),
  content: z.string().optional(),
  error: z.string().optional(),
  offset: z.number().int().positive(),
  limited: z.boolean(),
  characters: z.number().int().nonnegative().optional(),
  lines: z.number().int().nonnegative().optional(),
});

const readManySummaryOutputSchema = z.object({
  requested: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const grepContextLineOutputSchema = z.object({
  line: z.number().int().positive(),
  text: z.string(),
  match: z.boolean(),
});

const grepContextMatchOutputSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  text: z.string(),
  context: z.array(grepContextLineOutputSchema),
});

const grepContextSummaryOutputSchema = z.object({
  searchedFiles: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  matches: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const fileOutlineSymbolOutputSchema = z.object({
  line: z.number().int().positive(),
  kind: z.string(),
  name: z.string(),
  text: z.string(),
  exported: z.boolean(),
  indent: z.number().int().nonnegative(),
  filePath: z.string().optional(),
});

const fileOutlineSummaryOutputSchema = z.object({
  symbols: z.number().int().nonnegative(),
  truncated: z.boolean(),
  lines: z.number().int().nonnegative(),
});

const fileOutlineFileOutputSchema = z.object({
  path: z.string(),
  symbols: z.array(fileOutlineSymbolOutputSchema),
  summary: fileOutlineSummaryOutputSchema,
});

const editManyFileOutputSchema = z.object({
  path: z.string(),
  status: z.enum(["validated", "applied"]),
  editCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  removals: z.number().int().nonnegative(),
});

const editManySummaryOutputSchema = z.object({
  requestedFiles: z.number().int().nonnegative(),
  editCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  removals: z.number().int().nonnegative(),
  dryRun: z.boolean(),
});

const gitStatusOutputSchema = z.object({
  branch: z.string().nullable(),
  gitRoot: z.string(),
  status: z.array(z.string()),
  statusTruncated: z.boolean(),
  stagedFiles: z.array(z.string()),
  unstagedFiles: z.array(z.string()),
  untrackedFiles: z.array(z.string()),
});

const gitRecentCommitsOutputSchema = z.object({
  commits: z.array(z.string()),
});

const gitCommitOutputSchema = z.object({
  committed: z.boolean(),
  commit: z.string().optional(),
  subject: z.string().optional(),
  stagedFiles: z.array(z.string()),
  dryRun: z.boolean(),
});

const gitStageHunksFileOutputSchema = z.object({
  path: z.string(),
  editCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  removals: z.number().int().nonnegative(),
});

const gitStageHunksSummaryOutputSchema = z.object({
  requestedFiles: z.number().int().nonnegative(),
  editCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  removals: z.number().int().nonnegative(),
  dryRun: z.boolean(),
});

const gitDiffRangeHunkOutputSchema = z.object({
  header: z.string(),
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});

const gitDiffRangeFileOutputSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.string(),
  additions: z.number().int().nonnegative(),
  removals: z.number().int().nonnegative(),
  hunks: z.array(gitDiffRangeHunkOutputSchema),
  truncated: z.boolean(),
});

const gitDiffRangeSummaryOutputSchema = z.object({
  fileCount: z.number().int().nonnegative(),
  hunkCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  removals: z.number().int().nonnegative(),
  truncated: z.boolean(),
  staged: z.boolean(),
});

const editPreflightIndexOutputSchema = z.object({
  path: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  lineCount: z.number().int().nonnegative(),
  selectedHash: z.string().optional(),
  selectedLines: z.number().int().nonnegative().optional(),
  oldTextMatches: z.number().int().nonnegative().optional(),
  anchorMatches: z.number().int().nonnegative().optional(),
  symbolMatches: z.number().int().nonnegative().optional(),
  additions: z.number().int().nonnegative(),
  removals: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  recommendedStrategy: z.string(),
});

const bashPreflightOutputSchema = z.object({
  risk: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.string()),
  saferTools: z.array(z.string()),
  recommendedStrategy: z.string(),
});

const workspaceSnapshotGitOutputSchema = z.object({
  isGitRepo: z.boolean(),
  branch: z.string().nullable(),
  status: z.array(z.string()),
  statusTruncated: z.boolean(),
  error: z.string().optional(),
});

const workspaceSnapshotPackageOutputSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  type: z.string().optional(),
  scripts: z.record(z.string(), z.string()),
  dependencies: z.array(z.string()),
  devDependencies: z.array(z.string()),
  error: z.string().optional(),
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

const codexCliRunnerOutputSchema = {
  status: z.enum(CODEX_RUNNER_STATUS_VALUES),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  errorKind: z.enum(CODEX_RUNNER_ERROR_KIND_VALUES),
  nextAction: z.enum(CODEX_RUNNER_NEXT_ACTION_VALUES),
  fallbackRecommended: z.boolean(),
  fallbackPrompt: z.string().optional(),
  fallbackPromptSource: z.string().optional(),
  fallbackPromptTruncated: z.boolean().optional(),
  projectDir: z.string(),
  instructionFile: z.string(),
  runnerPath: z.string(),
  sandbox: z.enum(CODEX_SANDBOX_VALUES),
  mode: z.enum(CODEX_RUNNER_MODE_VALUES),
  model: z.string(),
  serviceTier: z.enum(CODEX_RUNNER_SERVICE_TIER_VALUES),
  reasoningEffort: z.enum(CODEX_RUNNER_REASONING_EFFORT_VALUES),
  dryRun: z.boolean(),
  json: z.boolean(),
  jobId: z.string().optional(),
  earlyWaitSeconds: z.number().int().positive().optional(),
  outputFile: z.string().optional(),
  logFile: z.string().optional(),
  instructionCopyFile: z.string().optional(),
  statusFile: z.string().optional(),
  combinedLogFile: z.string().optional(),
  launcherFile: z.string().optional(),
  stdout: z.string(),
  stderr: z.string(),
  command: z.array(z.string()),
  launchCommand: z.array(z.string()).optional(),
};

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

function requestLogFields(
  req: Request,
  config: ServerConfig,
  input: { requestId?: string; sessionId?: string } = {},
): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
    ...requestCorrelationFields(req, input),
  };
}

function safeOAuthDiagnosticFields(req: Request): OAuthDiagnosticEvent | undefined {
  const path = requestPath(req);
  if (!["/authorize", "/register", "/token", "/revoke"].includes(path)) return undefined;
  const query = req.query as Record<string, unknown>;
  return {
    event: `oauth_${path.slice(1)}_request`,
    clientId: safeQueryString(query.client_id),
    redirectUri: safeQueryString(query.redirect_uri),
    scope: safeQueryString(query.scope),
    status: "received",
  };
}

function safeQueryString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) return value[0];
  return undefined;
}

function logOAuthDiagnostic(config: ServerConfig, fields: OAuthDiagnosticEvent): void {
  if (!config.oauth.safeDiagnosticLogging) return;
  logEvent(config.logging, "info", "oauth_diagnostic", fields);
}

function currentRequestCorrelationFields(workspaceId?: string): Record<string, unknown> {
  const fields = requestCorrelationStore.getStore();
  if (fields?.conversationIdHash) return fields;
  if (!workspaceId) return fields ?? {};
  return {
    ...(fields ?? {}),
    autoThreadId: `workspace:${workspaceId}`,
  };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  const traceFields = toolTraces.recordToolCall(fields, {
    includeCommandShapes: config.logging.shellCommands,
  });
  const correlationFields = currentRequestCorrelationFields(fields.workspaceId);
  const logFields = {
    ...safeFields,
    ...correlationFields,
    ...traceFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  };
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", logFields);
  appendEfficiencyEvent({
    event: "tool_call",
    ...safeFields,
    ...correlationFields,
    clientKind: efficiencyClientKind(correlationFields.clientKind),
  });
}

function efficiencyClientKind(value: unknown): EfficiencyClientKind {
  return value === "chatgpt" || value === "claude" || value === "unknown" ? value : "unknown";
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

function textBlock(text: string): ToolContent {
  return { type: "text", text };
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
    <title>Workbridge Workspace</title>
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

interface WorkbridgeGuideResult {
  result: string;
  displayName: string;
  legacyName: string;
  purpose: string;
  firstSteps: string[];
  inspectionWorkflow: string[];
  editWorkflow: string[];
  verificationWorkflow: string[];
  modeSelection: string[];
  patchToolGuide: string[];
  processToolGuide: string[];
  codexGuide: string[];
  safetyRules: string[];
  toolHints: Record<string, string>;
}

function workbridgeGuide(): WorkbridgeGuideResult {
  const toolHints = {
    open_workspace: "Open one allowed local project folder and reuse the returned workspaceId.",
    workspace_snapshot: "Get bounded project context, git status, package metadata, and top-level files.",
    grep_context: "Search narrowly with bounded context before reading whole files.",
    file_outline: "Inspect symbols or structure before editing code files.",
    create_workspace_index: "Create an index when repeated focused reads are needed.",
    read_index_ranges: "Read exact indexed ranges instead of broad files when possible.",
    edit_by_line_range: "Make small targeted edits using verified line ranges.",
    apply_patch: "Use Codex patch format for add/update/delete/move changes in codex mode.",
    apply_unified_patch: "Use hash-guarded unified diffs when expectedBase/sha256 safety is required.",
    apply_structured_edit: "Use locator-based structured edits after resolve_locator/dry-run planning.",
    exec_command: "Use codex-mode process sessions for commands that may need polling, input, PTY, or Ctrl-C.",
    write_stdin: "Use with an exec_command sessionId to poll output, send input, resize PTY, or interrupt.",
    bash: "Use in minimal/full Workbridge modes for bounded tests/builds/inspection; avoid file mutation through shell.",
    workbridge_router: "Workbridge planner for bounded inspection, patch routing, and verification planning.",
    workbridge_verify: "Workbridge fixed verification runner; prefer it over ad-hoc bash for standard checks.",
    run_codex_cli: "Optional local Codex CLI wrapper; this is separate from DEVSPACE_TOOL_MODE=codex.",
    git_status: "Check working-tree state before and after edits.",
    git_commit_files: "Commit explicitly selected changed files after tests and user approval or instruction.",
  };
  const firstSteps = [
    "Call workbridge_guide if this connector is unfamiliar.",
    "Call open_workspace with the target project path once and reuse the returned workspaceId.",
    "Read AGENTS.md, nested instruction files, and relevant skill files surfaced by open_workspace before changing files.",
    "Use workspace_snapshot, grep_context, file_outline, create_workspace_index, or read_index_ranges to narrow context before broad reads.",
  ];
  const inspectionWorkflow = [
    "Prefer workspace_snapshot for initial context.",
    "Prefer grep_context, file_outline, create_workspace_index, and read_index_ranges over broad reads.",
    "Keep max output limits small and request only the paths needed for the current task.",
  ];
  const editWorkflow = [
    "Inspect exact target ranges or locators before editing.",
    "Use apply_patch for Codex patch format add/update/delete/move operations in codex mode.",
    "Use apply_unified_patch when hash-guarded unified diffs and expectedBase checks are required.",
    "Use edit_by_line_range, apply_structured_edit, insert_by_anchor, or replace_symbol for targeted Workbridge edits.",
    "After edits, inspect git diff and verify only the relevant tests first.",
  ];
  const verificationWorkflow = [
    "Run fixed verification profiles such as typecheck_only, related_tests, npm_test, build, git_diff_check, and git_status_check when available.",
    "Use bash for bounded minimal/full-mode project-specific commands when no fixed verification profile fits.",
    "Use exec_command/write_stdin in codex mode for long-running or interactive process sessions.",
    "Summarize changed files, tests run, results, and any remaining uncertainty.",
  ];
  const modeSelection = [
    "minimal: default Workbridge mode; safest compact surface with bounded inspection, targeted edits, git, bash, guide, and efficiency report.",
    "full: advanced Workbridge mode; adds dedicated grep/glob/ls and advanced edit/git helpers.",
    "codex: Codex-compatible mode plus Workbridge guide/diagnostics/bounded workflow helpers; use apply_patch and exec_command/write_stdin instead of bash for mutations/process sessions.",
  ];
  const patchToolGuide = [
    "apply_patch: Codex patch format; best for add/update/delete/move patches, especially when a Codex-style patch is already provided.",
    "apply_unified_patch: guarded unified diff; best when expectedBase sha256 checks and tracked-file safety are required.",
    "apply_structured_edit/edit_by_line_range: best for locator/range-based targeted edits after inspection.",
  ];
  const processToolGuide = [
    "bash: bounded command tool in minimal/full modes; use for tests/builds/inspection and avoid shell file mutation.",
    "exec_command: codex-mode process session command; use when a command may outlive the yield window or need PTY/input/interrupt.",
    "write_stdin: follow-up tool for exec_command sessions; use to poll, send input, resize PTY, or send Ctrl-C.",
  ];
  const codexGuide = [
    "DEVSPACE_TOOL_MODE=codex changes the MCP tool surface; run_codex_cli launches the local Codex CLI. They are different features.",
    "In Workbridge codex mode, guide/efficiency/bounded workflow helpers may still be visible by design.",
    "Prefer apply_patch for file mutations in codex mode; prefer exec_command/write_stdin for command sessions.",
  ];
  const safetyRules = [
    "Do not read or print secrets, tokens, cookies, session files, private keys, or live credentials.",
    "Do not perform external side effects, notifications, posting, deploys, or destructive git operations unless explicitly requested.",
    "Do not use broad shell commands to modify project files; prefer Workbridge editing tools.",
    "When a host/client safety filter blocks a request, do not repeat the same command shape; choose a safer bounded tool or record the event when available.",
  ];
  const purpose = "Workbridge connects AI clients such as ChatGPT or Claude to allowed local workspaces for safe inspection, editing, verification, git status, and commits. DevSpace remains the legacy internal name for compatibility.";
  const result = [
    "Workbridge guide",
    purpose,
    "First steps:",
    ...firstSteps.map((step, index) => `${index + 1}. ${step}`),
    "Mode selection:",
    ...modeSelection.map((item) => `- ${item}`),
    "Patch tools:",
    ...patchToolGuide.map((item) => `- ${item}`),
    "Process tools:",
    ...processToolGuide.map((item) => `- ${item}`),
    "Codex notes:",
    ...codexGuide.map((item) => `- ${item}`),
    "Safety:",
    ...safetyRules.map((rule) => `- ${rule}`),
  ].join("\n");
  return {
    result,
    displayName: "Workbridge",
    legacyName: "DevSpace",
    purpose,
    firstSteps,
    inspectionWorkflow,
    editWorkflow,
    verificationWorkflow,
    modeSelection,
    patchToolGuide,
    processToolGuide,
    codexGuide,
    safetyRules,
    toolHints,
  };
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

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function processToolResponse(
  tool: "exec_command" | "write_stdin" | "launch_workspace_task",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...outputSummary },
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
    },
  };
}

function workspaceTaskOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    task: z.string().optional(),
    template: z.string().optional(),
    command: z.string().optional(),
    executable: z.string().optional(),
    args: z.array(z.string()).optional(),
    dryRun: z.boolean().optional(),
    sessionId: z.number().optional(),
    running: z.boolean().optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative().optional(),
    outputTruncated: z.boolean().optional(),
  });
}

function registerWorkspaceTaskTool(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
): void {
  const taskEnum = z.enum(WORKSPACE_TASK_NAMES);
  registerAppTool(
    server,
    "launch_workspace_task",
    {
      title: "Launch workspace task",
      description:
        "Launch an allowlisted workspace task without accepting a raw shell command. The initial allowlisted task is aegis_runner. Use template for common start patterns or args for dynamic CLI arguments.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        task: taskEnum.describe("Allowlisted workspace task to launch."),
        template: z.string().optional().describe("Optional named template for common task arguments, such as status_console_5s."),
        args: z.array(z.string()).optional().describe("Optional CLI arguments appended after the task template arguments."),
        dryRun: z.boolean().optional().describe("Resolve and return the command without launching it."),
        tty: z.boolean().optional().describe("Allocate a pseudo-terminal when supported. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z.string().optional().describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z.number().int().min(0).max(30_000).optional().describe("Milliseconds to wait before returning a running session."),
        maxOutputTokens: z.number().int().positive().max(100_000).optional().describe("Approximate output token budget."),
      },
      outputSchema: workspaceTaskOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, task, template, args, dryRun, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const resolved = await resolveWorkspaceTask({
        workspaceRoot: workspace.root,
        task,
        args,
        template,
      });

      if (dryRun) {
        const result = `Resolved workspace task ${resolved.task}: ${resolved.command}`;
        const content = [textBlock(result)];
        logToolCall(config, {
          tool: "launch_workspace_task",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: resolved.command,
          commandLength: resolved.command.length,
          operation: "dry_run",
          dryRun: true,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content,
          structuredContent: {
            result,
            task: resolved.task,
            template: resolved.template,
            command: resolved.command,
            executable: resolved.executable,
            args: resolved.args,
            dryRun: true,
          },
        };
      }

      const snapshot = await processSessions.start({
        workspaceId,
        argv: {
          executable: resolved.executable,
          args: resolved.args,
          displayCommand: resolved.command,
        },
        cwd,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "launch_workspace_task",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: resolved.command,
        commandLength: resolved.command.length,
        operation: resolved.task,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("launch_workspace_task", workspaceId, snapshot, {
        task: resolved.task,
        template: resolved.template,
        command: resolved.command,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
): void {
  registerAppTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
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
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const snapshot = await processSessions.start({
        workspaceId,
        command: cmd,
        cwd,
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
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerAppTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
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
      outputSchema: processOutputSchema(),
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

function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
): McpServer {
  const toolNames = toolNamesFor(config);
  const server = new McpServer(
    {
      name: "workbridge",
      title: "Workbridge",
      version: "0.1.0",
      description:
        "Local AI workbridge for inspecting, editing, testing, and committing code in allowed workspaces.",
    },
    {
      instructions: serverInstructions(config, toolNames),
    },
  );

  registerAppResource(
    server,
    "Workbridge Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing Workbridge file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );



  if (CODEX_CLI_ENABLED) {
    registerAppTool(
      server,
      CODEX_CLI_RUNNER_TOOL_NAME,
    {
      title: "Run Codex CLI",
      description:
        "Run the local Codex CLI wrapper for a project and instruction file.",
      inputSchema: {
        projectDir: z
          .string()
          .describe("Target project directory inside allowed roots."),
        instructionFile: z
          .string()
          .describe("Markdown instruction file."),
        sandbox: z
          .enum(CODEX_SANDBOX_VALUES)
          .optional()
          .describe("Sandbox mode."),
        mode: z
          .enum(CODEX_RUNNER_MODE_VALUES)
          .optional()
          .describe("Execution mode."),
        model: z
          .string()
          .optional()
          .describe("Codex model passed to the Python runner. Defaults to gpt-5.5."),
        serviceTier: z
          .enum(CODEX_RUNNER_SERVICE_TIER_VALUES)
          .optional()
          .describe("Codex service tier passed to the Python runner. Defaults to standard."),
        reasoningEffort: z
          .enum(CODEX_RUNNER_REASONING_EFFORT_VALUES)
          .optional()
          .describe("Codex model reasoning effort passed to the Python runner. Defaults to xhigh."),
        dryRun: z
          .boolean()
          .optional()
          .describe("Validate without executing."),
        json: z
          .boolean()
          .optional()
          .describe("Use JSONL runner output."),
        timeout: z
          .number()
          .int()
          .positive()
          .max(3600)
          .optional()
          .describe("Timeout in seconds for sync mode. Defaults to 900, max 3600."),
        earlyWaitSeconds: z
          .number()
          .int()
          .positive()
          .max(300)
          .optional()
          .describe("Detached early-check seconds."),
        maxOutputCharacters: z
          .number()
          .int()
          .positive()
          .max(500_000)
          .optional()
          .describe("Maximum returned output characters."),
        maxFallbackPromptCharacters: z
          .number()
          .int()
          .positive()
          .max(500_000)
          .optional()
          .describe("Maximum fallback prompt characters."),
      },
      outputSchema: resultOutputSchema(codexCliRunnerOutputSchema),
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const startedAt = performance.now();
      try {
        const runnerResult = await runCodexCliRunner(input, {
          allowedRoots: config.allowedRoots,
        });
        const content = [textBlock(runnerResult.result)];
        logToolCall(config, {
          tool: CODEX_CLI_RUNNER_TOOL_NAME,
          path: runnerResult.projectDir,
          command: runnerResult.command.join(" "),
          commandLength: runnerResult.command.join(" ").length,
          exitCode: runnerResult.exitCode,
          timedOut: runnerResult.timedOut,
          sandbox: runnerResult.sandbox,
          dryRun: runnerResult.dryRun,
          success: !runnerResult.timedOut && (runnerResult.exitCode === 0 || runnerResult.status === "started_running"),
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          structuredContent: { ...runnerResult },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const content = [textBlock(message)];
        logFailedToolResponse(config, {
          tool: CODEX_CLI_RUNNER_TOOL_NAME,
          path: input.projectDir,
          sandbox: input.sandbox ?? "read-only",
          dryRun: input.dryRun ?? false,
        }, content, startedAt);
        return {
          content,
          isError: true,
          structuredContent: {
            result: message,
            status: "launch_error",
            exitCode: null,
            timedOut: false,
            errorKind: "runner_validation_error",
            nextAction: "none",
            fallbackRecommended: false,
            projectDir: input.projectDir,
            instructionFile: input.instructionFile,
            runnerPath: "",
            sandbox: input.sandbox ?? "read-only",
            mode: input.mode ?? "sync",
            dryRun: input.dryRun ?? false,
            json: input.json ?? false,
            stdout: "",
            stderr: message,
            command: [],
          },
        };
      }
    },
  );
  }

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a local project folder and return a workspaceId.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Project path inside allowed roots.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Workspace mode.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Optional worktree base ref."),
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
        instructionSources: z.unknown(),
        toolSurface: z.unknown(),
        recommendedWorkflow: z.unknown(),
        workspaceTasks: z.unknown(),
        verificationProfiles: z.unknown(),
        strategies: z.unknown(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }) => {
      const startedAt = performance.now();
      const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef });
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
          path: formatPathForPrompt(skill.filePath),
        }));
      const loadedAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const toolSurface = openWorkspaceToolSurface(config, toolNames);
      const recommendedWorkflow = openWorkspaceRecommendedWorkflow(config);
      const taskCatalog = await workspaceTaskCatalog(workspace.root);
      const workspaceTasks = {
        enabled: workspaceTasksEnabled(),
        enableWith: "WORKBRIDGE_ENABLE_WORKSPACE_TASKS=1",
        launcherTool: toolNames.launchWorkspaceTask,
        tasks: taskCatalog,
      };
      const verificationProfiles = openWorkspaceVerificationProfiles();
      const strategies = openWorkspaceStrategies(config);
      const instructionSources = {
        loaded: loadedAgentsFiles.map((file) => file.path),
        availableNested: availableAgentsFileOutputs.map((file) => file.path),
        skills: visibleSkills.map((skill) => ({ name: skill.name, path: skill.path })),
        rule: "Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill, read its path before proceeding.",
      };
      const instruction = config.skillsEnabled
        ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `Opened workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
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
            `Tool mode: ${config.toolMode}; widgets: ${config.widgets}; enabled profiles: ${enabledToolProfiles(config).join(", ")}`,
            workspaceTasks.enabled
              ? `Workspace tasks enabled: ${taskCatalog.filter((task) => task.scriptPresent).map((task) => task.name).join(", ") || "none found in this workspace"}`
              : "Workspace tasks disabled. Enable with WORKBRIDGE_ENABLE_WORKSPACE_TASKS=1.",
            `Recommended next call: ${recommendedWorkflow.nextRecommendedCalls instanceof Array ? recommendedWorkflow.nextRecommendedCalls.join(", ") : "workspace_snapshot"}`,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            summary: {
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              skills: visibleSkills.length,
              skillDiagnostics: workspace.skillDiagnostics.length,
              enabledProfiles: enabledToolProfiles(config).length,
              workspaceTasks: taskCatalog.filter((task) => task.scriptPresent).length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          agentsFiles: loadedAgentsFiles,
          availableAgentsFiles: availableAgentsFileOutputs,
          skills: visibleSkills,
          skillDiagnostics: workspace.skillDiagnostics,
          instruction,
          instructionSources,
          toolSurface,
          recommendedWorkflow,
          workspaceTasks,
          verificationProfiles,
          strategies,
        },
      };
    },
  );

  if (isForkToolMode(config)) {
  registerAppTool(
    server,
    toolNames.workspaceSnapshot,
    {
      title: "Workspace snapshot",
      description:
        "Return lightweight repository context.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace id."),
        include: z
          .object({
            git: z.boolean().optional(),
            topLevelFiles: z.boolean().optional(),
            packageJson: z.boolean().optional(),
            docs: z.boolean().optional(),
            src: z.boolean().optional(),
            agents: z.boolean().optional(),
          })
          .optional()
          .describe(
            "Sections to include.",
          ),
        maxFiles: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe(
            "Maximum listed files.",
          ),
      },
      outputSchema: resultOutputSchema({
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z.unknown().optional(),
        git: workspaceSnapshotGitOutputSchema.optional(),
        topLevelFiles: z.array(z.string()).optional(),
        readmePresent: z.boolean(),
        packageJsonPresent: z.boolean(),
        agents: z
          .object({
            agentsMd: z.boolean(),
            claudeMd: z.boolean(),
          })
          .optional(),
        packageJson: workspaceSnapshotPackageOutputSchema.optional(),
        docsFiles: z.array(z.string()).optional(),
        srcFiles: z.array(z.string()).optional(),
        testCommandCandidates: z.array(z.string()),
        summary: z.object({
          files: z.number().int().nonnegative(),
          truncated: z.boolean(),
        }),
      }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, include, maxFiles }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const snapshot = await workspaceSnapshot(workspace, {
        include,
        maxFiles,
      });
      const content = [textBlock(snapshot.result)];
      const resultSummary = textSummary(content);
      logToolCall(config, {
        tool: toolNames.workspaceSnapshot,
        workspaceId,
        path: workspace.root,
        resultFiles: snapshot.summary.files,
        resultLines: resultSummary.lines,
        resultCharacters: resultSummary.characters,
        truncated: snapshot.summary.truncated,
        gitStatusLines: snapshot.git?.status.length,
        gitStatusTruncated: snapshot.git?.statusTruncated,
        testCommandCandidates: snapshot.testCommandCandidates.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: snapshot,
      };
    },
  );


  }

  if (isForkToolMode(config)) {
  registerSafetyTools({
    server,
    workspaces,
    toolNames,
    enableTaskTools: false,
    enableAdvancedTools: config.toolMode === "full",
    logToolCall: (fields) => logToolCall(config, fields),
  });
  }

  if (isForkToolMode(config) && WORKFLOW_TOOLS_ENABLED) {
    registerWorkflowTools({
      server,
      workspaces,
      toolNames,
      logToolCall: (fields) => logToolCall(config, fields),
    });
  }

  if (ZIP_EXPORT_TOOLS_ENABLED) {
    registerZipExportTools({
      server,
      workspaces,
      exportStore: zipExports,
      toolNames,
      logToolCall: (fields) => logToolCall(config, fields),
    });

    registerZipTransferTools({
      server,
      exportStore: zipExports,
      toolNames,
      publicBaseUrl: config.publicBaseUrl,
      logToolCall: (fields) => logToolCall(config, fields),
    });
  }

  if (ZIP_IMPORT_TOOLS_ENABLED) {
    registerZipImportTools({
      server,
      workspaces,
      importStore: zipImports,
      toolNames,
      enableProbeTools: ZIP_IMPORT_PROBE_TOOLS_ENABLED,
      logToolCall: (fields) => logToolCall(config, fields),
    });
  }
  if (isForkToolMode(config)) {
  registerWorkspaceIndexTools({
    server,
    workspaces,
    indexStore: workspaceIndexes,
    toolNames,
    logToolCall: (fields) => logToolCall(config, fields),
  });

  registerAppTool(
    server,
    toolNames.gitStatus,
    {
      title: "Git status",
      description:
        "Return concise Git status.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        includeIgnored: z.boolean().optional().describe("Include ignored files."),
        maxStatusLines: z.number().int().positive().max(1000).optional().describe("Maximum status lines."),
      },
      outputSchema: resultOutputSchema(gitStatusOutputSchema.shape),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, includeIgnored, maxStatusLines }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const status = await gitStatusTool({ includeIgnored, maxStatusLines }, workspace);
        logToolCall(config, {
          tool: toolNames.gitStatus,
          workspaceId,
          operation: "git_status",
          stagedFiles: status.stagedFiles.length,
          unstagedFiles: status.unstagedFiles.length,
          untrackedFiles: status.untrackedFiles.length,
          resultLines: status.status.length,
          truncated: status.statusTruncated,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(status.result)], structuredContent: status };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const content = [textBlock(message)];
        logFailedToolResponse(config, { tool: toolNames.gitStatus, workspaceId, operation: "git_status" }, content, startedAt);
        return { content, isError: true, structuredContent: { result: message } };
      }
    },
  );

  registerAppTool(
    server,
    toolNames.gitDiffRanges,
    {
      title: "Git diff ranges",
      description: "Return bounded Git diff hunks.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        staged: z.boolean().optional().describe("Use staged diff."),
        files: z.array(z.string()).max(MAX_GIT_TOOL_FILES).optional().describe("Optional file paths."),
        contextLines: z.number().int().min(0).max(20).optional().describe("Context lines."),
        maxFiles: z.number().int().positive().max(MAX_GIT_DIFF_RANGE_FILES).optional().describe("Maximum files."),
        maxHunks: z.number().int().positive().max(MAX_GIT_DIFF_RANGE_HUNKS).optional().describe("Maximum hunks."),
        maxLines: z.number().int().positive().max(MAX_GIT_DIFF_RANGE_LINES).optional().describe("Maximum diff lines."),
      },
      outputSchema: resultOutputSchema({ gitRoot: z.string(), staged: z.boolean(), files: z.array(gitDiffRangeFileOutputSchema), summary: gitDiffRangeSummaryOutputSchema }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const diff = await gitDiffRangesTool(input, workspace, workspaces);
        logToolCall(config, { tool: toolNames.gitDiffRanges, workspaceId, operation: "git_diff_ranges", fileCount: diff.summary.fileCount, resultLines: diff.summary.hunkCount, additions: diff.summary.additions, removals: diff.summary.removals, truncated: diff.summary.truncated, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return { content: [textBlock(diff.result)], structuredContent: diff };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const content = [textBlock(message)];
        logFailedToolResponse(config, { tool: toolNames.gitDiffRanges, workspaceId, operation: "git_diff_ranges", fileCount: input.files?.length }, content, startedAt);
        return { content, isError: true, structuredContent: { result: message } };
      }
    },
  );

  registerAppTool(
    server,
    toolNames.editPreflightIndex,
    {
      title: "Edit preflight index",
      description: "Check an indexed file edit target.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        indexId: z.string().describe("Index id."),
        number: z.number().int().positive().describe("Index file number."),
        startLine: z.number().int().positive().optional().describe("Start line."),
        endLine: z.number().int().positive().optional().describe("End line."),
        oldText: z.string().optional().describe("Expected text."),
        newText: z.string().optional().describe("Replacement text."),
        anchor: z.string().optional().describe("Anchor text."),
        symbol: z.string().optional().describe("Symbol name."),
        kind: z.enum(["function", "class", "const", "any"]).optional().describe("Symbol kind."),
      },
      outputSchema: resultOutputSchema(editPreflightIndexOutputSchema.shape),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, indexId, number, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const entry = workspaceIndexes.resolveIndexEntries(workspace, { indexId, numbers: [number] })[0];
        if (!entry) throw new Error(`Unknown file index: ${number}`);
        const result = await editPreflightIndex({ ...input, path: entry.path, absolutePath: workspaces.resolvePath(workspace, entry.path) });
        logToolCall(config, { tool: toolNames.editPreflightIndex, workspaceId, path: entry.path, operation: "edit_preflight_index", additions: result.additions, removals: result.removals, resultCharacters: result.result.length, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return { content: [textBlock(result.result)], structuredContent: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const content = [textBlock(message)];
        logFailedToolResponse(config, { tool: toolNames.editPreflightIndex, workspaceId, path: indexId, operation: "edit_preflight_index" }, content, startedAt);
        return { content, isError: true, structuredContent: { result: message } };
      }
    },
  );




  if (config.toolMode === "full") {
    registerAppTool(
    server,
    toolNames.gitRecentCommits,
    {
      title: "Git recent commits",
      description:
        "Return recent Git commits.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        maxCount: z.number().int().positive().max(MAX_GIT_RECENT_COMMITS).optional().describe("Maximum commits."),
      },
      outputSchema: resultOutputSchema(gitRecentCommitsOutputSchema.shape),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, maxCount }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const commits = await gitRecentCommitsTool({ maxCount }, workspace);
        logToolCall(config, {
          tool: toolNames.gitRecentCommits,
          workspaceId,
          operation: "git_recent_commits",
          resultLines: commits.commits.length,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(commits.result)], structuredContent: commits };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const content = [textBlock(message)];
        logFailedToolResponse(config, { tool: toolNames.gitRecentCommits, workspaceId, operation: "git_recent_commits" }, content, startedAt);
        return { content, isError: true, structuredContent: { result: message } };
      }
    },
  );

  registerAppTool(
    server,
    toolNames.gitStageFiles,
    {
      title: "Git stage files",
      description:
        "Stage whole files in Git.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        files: z.array(z.string()).min(1).max(MAX_GIT_TOOL_FILES).describe("Paths to stage."),
      },
      outputSchema: resultOutputSchema({ stagedFiles: z.array(z.string()) }),
      _meta: {},
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, files }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const staged = await gitStageFilesTool({ files }, workspace, workspaces);
        logToolCall(config, {
          tool: toolNames.gitStageFiles,
          workspaceId,
          operation: "git_stage_files",
          fileCount: files.length,
          stagedFiles: staged.stagedFiles.length,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(staged.result)], structuredContent: staged };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const content = [textBlock(message)];
        logFailedToolResponse(config, { tool: toolNames.gitStageFiles, workspaceId, operation: "git_stage_files", fileCount: files.length }, content, startedAt);
        return { content, isError: true, structuredContent: { result: message } };
      }
    },
  );

  registerAppTool(
    server,
    toolNames.gitStageHunks,
    {
      title: "Git stage hunks",
      description:
        "Stage exact text hunks in Git.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        files: z.array(z.object({
          path: z.string().describe("Tracked file path."),
          edits: z.array(z.object({
            oldText: z.string().describe("Text in current index."),
            newText: z.string().describe("Text in working tree."),
          })).min(1).max(MAX_GIT_STAGE_HUNK_EDITS_PER_FILE),
        })).min(1).max(MAX_GIT_STAGE_HUNK_FILES),
        dryRun: z.boolean().optional().describe("Validate only."),
      },
      outputSchema: resultOutputSchema({
        status: z.enum(["validated", "staged"]),
        files: z.array(gitStageHunksFileOutputSchema),
        summary: gitStageHunksSummaryOutputSchema,
      }),
      _meta: {},
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, files, dryRun }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const staged = await gitStageHunksTool({ files, dryRun }, workspace, workspaces);
        logToolCall(config, {
          tool: toolNames.gitStageHunks,
          workspaceId,
          operation: "git_stage_hunks",
          fileCount: files.length,
          editCount: staged.summary.editCount,
          additions: staged.summary.additions,
          removals: staged.summary.removals,
          dryRun: staged.summary.dryRun,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(staged.result)], structuredContent: staged };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const content = [textBlock(message)];
        logFailedToolResponse(config, { tool: toolNames.gitStageHunks, workspaceId, operation: "git_stage_hunks", fileCount: files.length, dryRun: dryRun ?? false }, content, startedAt);
        return { content, isError: true, structuredContent: { result: message } };
      }
    },
  );

  }

  registerAppTool(
    server,
    toolNames.gitCommitFiles,
    {
      title: "Git commit files",
      description:
        "Stage selected files and commit.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        files: z.array(z.string()).min(1).max(MAX_GIT_TOOL_FILES).describe("Paths to commit."),
        message: z.string().describe("Commit message."),
        allowExistingStaged: z.boolean().optional().describe("Allow existing staged files."),
        allowEmpty: z.boolean().optional().describe("Allow empty commit."),
        dryRun: z.boolean().optional().describe("Validate only."),
      },
      outputSchema: resultOutputSchema(gitCommitOutputSchema.shape),
      _meta: {},
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, files, message, allowExistingStaged, allowEmpty, dryRun }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const commit = await gitCommitFilesTool({ files, message, allowExistingStaged, allowEmpty, dryRun }, workspace, workspaces);
        logToolCall(config, {
          tool: toolNames.gitCommitFiles,
          workspaceId,
          operation: "git_commit_files",
          fileCount: files.length,
          commitMessageLength: message.length,
          stagedFiles: commit.stagedFiles.length,
          dryRun: commit.dryRun,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(commit.result)], structuredContent: commit };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const content = [textBlock(errorMessage)];
        logFailedToolResponse(config, { tool: toolNames.gitCommitFiles, workspaceId, operation: "git_commit_files", fileCount: files.length, commitMessageLength: message.length, dryRun: dryRun ?? false }, content, startedAt);
        return { content, isError: true, structuredContent: { result: errorMessage } };
      }
    },
  );

  if (config.toolMode === "full") {
    registerAppTool(
    server,
    toolNames.gitCommitStaged,
    {
      title: "Git commit staged",
      description:
        "Commit the current Git index.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        message: z.string().describe("Commit message."),
        expectedFiles: z.array(z.string()).optional().describe("Expected staged paths."),
        allowEmpty: z.boolean().optional().describe("Allow empty commit."),
        dryRun: z.boolean().optional().describe("Validate only."),
      },
      outputSchema: resultOutputSchema(gitCommitOutputSchema.shape),
      _meta: {},
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, message, expectedFiles, allowEmpty, dryRun }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const commit = await gitCommitStagedTool({ message, expectedFiles, allowEmpty, dryRun }, workspace, workspaces);
        logToolCall(config, {
          tool: toolNames.gitCommitStaged,
          workspaceId,
          operation: "git_commit_staged",
          fileCount: expectedFiles?.length,
          commitMessageLength: message.length,
          stagedFiles: commit.stagedFiles.length,
          dryRun: commit.dryRun,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(commit.result)], structuredContent: commit };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const content = [textBlock(errorMessage)];
        logFailedToolResponse(config, { tool: toolNames.gitCommitStaged, workspaceId, operation: "git_commit_staged", fileCount: expectedFiles?.length, commitMessageLength: message.length, dryRun: dryRun ?? false }, content, startedAt);
        return { content, isError: true, structuredContent: { result: errorMessage } };
      }
    },
  );

  }

  registerAppTool(
    server,
    toolNames.grepContext,
    {
      title: "Grep context",
      description:
        "Search workspace text with bounded context.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        query: z.string().describe("Query or regex."),
        path: z.string().optional().describe("Optional search scope."),
        indexId: z.string().optional().describe("Optional workspace index id to constrain search."),
        numbers: z.array(z.number().int().positive()).max(500).optional().describe("Optional index file numbers."),
        regex: z.boolean().optional().describe("Use regex."),
        caseSensitive: z.boolean().optional().describe("Case sensitive."),
        contextLines: z.number().int().min(0).max(MAX_GREP_CONTEXT_LINES).optional().describe("Context lines."),
        maxMatches: z.number().int().positive().max(MAX_GREP_MAX_MATCHES).optional().describe("Maximum matches."),
        maxFiles: z.number().int().positive().max(MAX_GREP_MAX_FILES).optional().describe("Maximum files."),
        maxFileBytes: z.number().int().positive().max(MAX_GREP_MAX_FILE_BYTES).optional().describe("Maximum bytes per file."),
        includeExtensions: z.array(z.string()).optional().describe("Extension allowlist."),
      },
      outputSchema: resultOutputSchema({
        matches: z.array(grepContextMatchOutputSchema),
        summary: grepContextSummaryOutputSchema,
      }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const { indexId, numbers, ...grepInput } = input;
        if (indexId && grepInput.path) throw new Error("grep_context cannot combine indexId with path. Use indexId with optional numbers, or omit indexId and pass path.");
        const paths = indexId ? workspaceIndexes.resolveIndexPaths(workspace, { indexId, numbers }) : undefined;
        const inputs = paths ? paths.map((path) => ({ ...grepInput, path })) : [grepInput];
        const maxMatches = grepInput.maxMatches ?? DEFAULT_GREP_MAX_MATCHES;
        const matches = [];
        const parts = [];
        let searchedFiles = 0;
        let skippedFiles = 0;
        let truncated = false;

        for (const scopedInput of inputs) {
          if (matches.length >= maxMatches) {
            truncated = true;
            break;
          }
          const remainingMatches = Math.max(1, maxMatches - matches.length);
          const part = await grepContext({ ...scopedInput, maxMatches: remainingMatches }, workspace);
          parts.push(part);
          matches.push(...part.matches);
          searchedFiles += part.summary.searchedFiles;
          skippedFiles += part.summary.skippedFiles;
          truncated ||= part.summary.truncated;
        }

        const matchedFiles = new Set(matches.map((match) => match.path)).size;
        const result = parts.length === 1 && !indexId
          ? parts[0]!
          : {
              matches,
              summary: { searchedFiles, matchedFiles, matches: matches.length, skippedFiles, truncated },
              result: [
                `grep_context${indexId ? ` index=${indexId}` : ""} matches=${matches.length} files=${matchedFiles}/${searchedFiles}${truncated ? " truncated" : ""}`,
                ...parts.map((part) => part.result),
              ].join("\n\n"),
            };
        logToolCall(config, {
          tool: toolNames.grepContext,
          workspaceId,
          path: input.path ?? indexId,
          operation: "grep_context",
          resultFiles: result.summary.matchedFiles,
          resultLines: result.summary.matches,
          truncated: result.summary.truncated,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(result.result)], structuredContent: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const content = [textBlock(message)];
        logFailedToolResponse(config, { tool: toolNames.grepContext, workspaceId, path: input.path ?? input.indexId, operation: "grep_context" }, content, startedAt);
        return { content, isError: true, structuredContent: { result: message } };
      }
    },
  );

  registerAppTool(
    server,
    toolNames.fileOutline,
    {
      title: "File outline",
      description:
        "Return symbols or headings for one file.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        path: z.string().optional().describe("File path."),
        indexId: z.string().optional().describe("Optional workspace index id to outline files from."),
        numbers: z.array(z.number().int().positive()).max(500).optional().describe("Optional index file numbers."),
        maxSymbols: z.number().int().positive().max(MAX_OUTLINE_MAX_SYMBOLS).optional().describe("Maximum symbols per file."),
      },
      outputSchema: resultOutputSchema({
        path: z.string(),
        symbols: z.array(fileOutlineSymbolOutputSchema),
        summary: fileOutlineSummaryOutputSchema,
        files: z.array(fileOutlineFileOutputSchema).optional(),
      }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const { indexId, numbers, path, ...outlineInput } = input;
        if (indexId && path) throw new Error("file_outline cannot combine indexId with path. Use indexId with optional numbers, or omit indexId and pass path.");
        const paths = indexId ? workspaceIndexes.resolveIndexPaths(workspace, { indexId, numbers }) : [path];
        if (paths.some((entry) => !entry)) throw new Error("path or indexId is required.");
        const files = [];
        for (const targetPath of paths) {
          const outline = await fileOutline({ ...outlineInput, path: targetPath! }, workspace);
          files.push(outline);
        }
        const result = files.length === 1 && !indexId
          ? files[0]!
          : {
              path: `index:${indexId}`,
              symbols: files.flatMap((file) => file.symbols.map((symbol) => ({ ...symbol, filePath: file.path }))),
              summary: {
                symbols: files.reduce((total, file) => total + file.summary.symbols, 0),
                truncated: files.some((file) => file.summary.truncated),
                lines: files.reduce((total, file) => total + file.summary.lines, 0),
              },
              files,
              result: [
                `file_outline index=${indexId} files=${files.length}`,
                ...files.map((file) => file.result),
              ].join("\n\n"),
            };
        logToolCall(config, {
          tool: toolNames.fileOutline,
          workspaceId,
          path: path ?? indexId,
          operation: "file_outline",
          resultLines: result.summary.symbols,
          truncated: result.summary.truncated,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(result.result)], structuredContent: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const content = [textBlock(message)];
        logFailedToolResponse(config, { tool: toolNames.fileOutline, workspaceId, path: input.path ?? input.indexId, operation: "file_outline" }, content, startedAt);
        return { content, isError: true, structuredContent: { result: message } };
      }
    },
  );

  }

  if (isForkToolMode(config) && LEGACY_READ_TOOLS_ENABLED) {
    registerAppTool(
      server,
      toolNames.readMany,
    {
      title: "Read many files",
      description:
        "Read several files with bounded output.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace id."),
        files: z
          .array(
            z.object({
              path: z
                .string()
                .describe(
                  config.skillsEnabled
                    ? "File path."
                    : "File path.",
                ),
              offset: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Start line."),
              limit: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Line limit."),
            }),
          )
          .min(1)
          .max(MAX_READ_MANY_FILES),
        maxTotalCharacters: z
          .number()
          .int()
          .positive()
          .max(500_000)
          .optional()
          .describe(
            "Maximum characters.",
          ),
      },
      outputSchema: resultOutputSchema({
        files: z.array(readManyFileOutputSchema),
        summary: readManySummaryOutputSchema,
      }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, files, maxTotalCharacters }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const batch = await readManyFiles(
        { files, maxTotalCharacters },
        workspace,
        workspaces,
      );
      const content = [textBlock(batch.result)];
      const resultSummary = textSummary(content);
      logToolCall(config, {
        tool: toolNames.readMany,
        workspaceId,
        requestedFiles: batch.summary.requested,
        succeededFiles: batch.summary.succeeded,
        failedFiles: batch.summary.failed,
        resultFiles: batch.files.length,
        resultLines: resultSummary.lines,
        resultCharacters: resultSummary.characters,
        returnedCharacters: batch.summary.characters,
        truncated: batch.summary.truncated,
        maxTotalCharacters,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: batch,
      };
    },
  );

    registerAppTool(
      server,
      toolNames.read,
    {
      title: "Read file",
      description:
        "Read one workspace file with optional line bounds.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace id."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path."
              : "File path.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Start line."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Line limit."),
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
        resultLines: summary.lines,
        resultCharacters: summary.characters,
        limited: summary.limited,
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


  if (isMainExpandedToolMode(config)) {
    registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        "Create or overwrite one workspace file.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace id."),
        path: z
          .string()
          .describe("File path."),
        content: z.string().describe("File content."),
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
  }

  if (isForkToolMode(config) && EDIT_MANY_ENABLED) {
    registerAppTool(
      server,
      toolNames.editMany,
    {
      title: "Edit many files",
      description:
        "Apply exact replacements across multiple files.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace id."),
        files: z
          .array(
            z.object({
              path: z
                .string()
                .describe("File path."),
              edits: z
                .array(
                  z.object({
                    oldText: z
                      .string()
                      .describe(
                        "Unique text to replace.",
                      ),
                    newText: z.string().describe("Replacement."),
                  }),
                )
                .min(1)
                .max(MAX_EDIT_MANY_EDITS_PER_FILE),
            }),
          )
          .min(1)
          .max(MAX_EDIT_MANY_FILES),
        dryRun: z
          .boolean()
          .optional()
          .describe("Validate only."),
      },
      outputSchema: resultOutputSchema({
        status: z.enum(["validated", "applied"]),
        files: z.array(editManyFileOutputSchema),
        summary: editManySummaryOutputSchema,
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, files, dryRun }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);

      try {
        const batch = await editManyFiles(
          { files, dryRun },
          workspace,
          workspaces,
        );
        const content = [textBlock(batch.result)];
        logToolCall(config, {
          tool: toolNames.editMany,
          workspaceId,
          requestedFiles: batch.summary.requestedFiles,
          editCount: batch.summary.editCount,
          additions: batch.summary.additions,
          removals: batch.summary.removals,
          dryRun: batch.summary.dryRun,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: toolNames.editMany,
            card: {
              workspaceId,
              summary: batch.summary,
              files: batch.files,
            },
          },
          structuredContent: batch,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const content = [textBlock(message)];
        logFailedToolResponse(config, {
          tool: toolNames.editMany,
          workspaceId,
          requestedFiles: files.length,
          dryRun: dryRun ?? false,
        }, content, startedAt);
        return {
          content,
          isError: true,
          structuredContent: {
            result: message,
          },
        };
      }
    },
  );
  }

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        "Apply exact replacements in one workspace file.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace id."),
        path: z
          .string()
          .describe("File path."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Unique text to replace.",
                ),
              newText: z.string().describe("Replacement."),
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
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Apply one Codex-style patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
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

  if (isMainExpandedToolMode(config)) {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search workspace file contents.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace id."),
          pattern: z.string().describe("Pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional scope.",
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

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Find workspace files by glob.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace id."),
          pattern: z.string().describe("Glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional scope."),
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

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a workspace directory.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace id."),
          path: z
            .string()
            .describe(
              "Directory path.",
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

  registerAppTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: config.toolMode !== "full"
        ? `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. Prefer dedicated Workbridge tools when available and do not use ${toolNames.shell} to create or modify files.`
        : `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files when a Workbridge editing tool fits.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace id."),
        command: z
          .string()
          .describe(
            "Command.",
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Workdir.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
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

  if (workspaceTasksEnabled()) {
    registerWorkspaceTaskTool(server, config, workspaces, processSessions);
  }

  if (config.toolMode === "codex" || processToolsEnabled()) {
    registerCodexProcessTools(server, config, workspaces, processSessions);
  }

  logToolRegistrySummary(config, toolNames);

  return server;
}

export function createServer(config = loadConfig()): RunningServer {
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new Map<string, Transport>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir, (event) => logOAuthDiagnostic(config, event));
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();

  if (config.logging.trustProxy) {
    // Trust exactly one local tunnel/reverse-proxy hop; never use permissive true.
    app.set("trust proxy", 1);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    const oauthDiagnostic = safeOAuthDiagnosticFields(req);
    if (oauthDiagnostic) {
      logOAuthDiagnostic(config, {
        ...oauthDiagnostic,
        ...requestCorrelationFields(req, { requestId, sessionId: req.header("mcp-session-id") }),
      });
    }

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config, { requestId, sessionId: req.header("mcp-session-id") }),
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
      resourceName: "Workbridge",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "workbridge", legacyName: "devspace" });
  });

  app.get("/devspace-exports/:token.zip", (req, res) => {
    try {
      const record = zipExports.claimDownload(req.params.token);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="${record.exportId}.zip"`);
      res.sendFile(record.zipPath, { dotfiles: "allow" });
    } catch (error) {
      res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    requestCorrelationStore.enterWith(requestCorrelationFields(req, { requestId, sessionId }));

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
        ...requestLogFields(req, config, { requestId, sessionId }),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
      ...currentRequestCorrelationFields(),
    });

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.set(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config, { requestId, sessionId: newSessionId }),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId);
            logEvent(config.logging, "info", "mcp_session_closed", {
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(config, workspaces, reviewCheckpoints, processSessions);
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

  let closed = false;
  return {
    app,
    config,
    close: () => {
      if (closed) return;
      closed = true;
      processSessions.shutdown();
      oauthProvider.close();
      workspaceStore.close?.();
      void closeLogFiles();
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `workbridge listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`log file: ${config.logging.filePath ?? "disabled"}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
  });

  const shutdown = () => {
    httpServer.close(() => {
      close();
      void closeLogFiles().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
