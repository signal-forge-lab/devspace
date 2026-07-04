import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import type { WorkspaceRegistry } from "./workspaces.js";
import { editByLineRange, editPlanPreflight, insertByAnchor, replaceSymbol } from "./safe-editing.js";
import { routeSafeOperation } from "./operation-router.js";
import { resumeTaskCheckpoint, saveTaskCheckpoint } from "./task-checkpoints.js";

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const READ_ANNOTATIONS = { readOnlyHint: true };

type ToolContent = { type: "text"; text: string };

type LogFields = {
  tool: string;
  workspaceId?: string;
  path?: string;
  operation?: string;
  editCount?: number;
  additions?: number;
  removals?: number;
  resultCharacters?: number;
  dryRun?: boolean;
  success: boolean;
  durationMs: number;
  error?: string;
};

export interface SafetyToolNames {
  editPlanPreflight: string;
  editByLineRange: string;
  insertByAnchor: string;
  replaceSymbol: string;
  safeOperationRouter: string;
  taskCheckpoint: string;
  taskResume: string;
}

export interface RegisterSafetyToolsOptions {
  server: McpServer;
  workspaces: WorkspaceRegistry;
  toolNames: SafetyToolNames;
  enableTaskTools?: boolean;
  enableAdvancedTools?: boolean;
  logToolCall(fields: LogFields): void;
}

export function registerSafetyTools(options: RegisterSafetyToolsOptions): void {
  const { server, workspaces, toolNames, enableTaskTools = false, enableAdvancedTools = true, logToolCall } = options;

  if (enableAdvancedTools) {
    registerAppTool(
    server,
    toolNames.editPlanPreflight,
    {
      title: "Edit plan preflight",
      description:
        "Assess a planned operation.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id."),
        operation: z.string().optional().describe("Operation name."),
        plannedTool: z.string().optional().describe("Planned tool name."),
        commandShape: z.string().optional().describe("Command shape."),
        targetKind: z.enum(["function", "class", "const", "lines", "insertion", "exact_text"]).optional().describe("Target kind."),
        symbol: z.string().optional().describe("Target symbol."),
        edits: z.array(z.object({
          path: z.string().optional(),
          oldText: z.string().optional(),
          newText: z.string().optional(),
          oldChars: z.number().int().nonnegative().optional(),
          newChars: z.number().int().nonnegative().optional(),
          kind: z.string().optional(),
        })).max(50).optional(),
      },
      outputSchema: resultSchema({
        risk: z.enum(["low", "medium", "high"]),
        recommendedStrategy: z.string(),
        maxEditChars: z.number().int().positive(),
        reasons: z.array(z.string()),
        saferTools: z.array(z.string()),
      }),
      _meta: {},
      annotations: READ_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      if (workspaceId) workspaces.getWorkspace(workspaceId);
      const result = editPlanPreflight(input);
      logToolCall({
        tool: toolNames.editPlanPreflight,
        workspaceId,
        operation: input.operation ?? "edit_plan_preflight",
        resultCharacters: result.result.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return { content: [textBlock(result.result)], structuredContent: result };
    },
  );

  registerAppTool(
    server,
    toolNames.safeOperationRouter,
    {
      title: "Safe operation router",
      description:
        "Recommend a safer operation shape.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id."),
        intent: z.string().optional(),
        plannedTool: z.string().optional(),
        operation: z.string().optional(),
        commandShape: z.string().optional(),
        fileCount: z.number().int().nonnegative().optional(),
        editCharacters: z.number().int().nonnegative().optional(),
        writesFiles: z.boolean().optional(),
        usesGit: z.boolean().optional(),
        taskClass: z.enum(["read_inspect", "small_edit", "large_edit_refactor", "validation_test", "structured_sensitive_integration", "runtime_external_side_effect", "packaging_release", "incident_recovery"]).optional(),
        secretValueHandling: z.enum(["never_read_or_write", "mock_only"]).optional(),
        envVarReferences: z.array(z.string()).max(50).optional(),
        liveSmokeRequested: z.boolean().optional(),
        externalSideEffect: z.boolean().optional(),
        incident: z.string().max(500).optional(),
        targetKind: z.enum(["function", "class", "const", "lines", "insertion", "exact_text"]).optional().describe("Target kind."),
        symbol: z.string().optional().describe("Target symbol."),
      },
      outputSchema: resultSchema({
        risk: z.enum(["low", "medium", "high"]),
        recommendedTool: z.string(),
        strategy: z.string(),
        reasons: z.array(z.string()),
        warnings: z.array(z.string()),
        taskClass: z.enum(["read_inspect", "small_edit", "large_edit_refactor", "validation_test", "structured_sensitive_integration", "runtime_external_side_effect", "packaging_release", "incident_recovery"]),
        efficiencyGoal: z.string(),
        recommendedSequence: z.array(z.string()),
        requiredChecks: z.array(z.string()),
        transportRecommendation: z.enum(["none", "plain_structured_edit", "base64_structured_edit", "unified_patch_with_hash_guard"]),
        blockedPattern: z.string(),
        improvementHint: z.string(),
      }),
      _meta: {},
      annotations: READ_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      if (workspaceId) workspaces.getWorkspace(workspaceId);
      const result = routeSafeOperation(input);
      logToolCall({
        tool: toolNames.safeOperationRouter,
        workspaceId,
        operation: input.operation ?? "safe_operation_route",
        resultCharacters: result.result.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return { content: [textBlock(result.result)], structuredContent: result };
    },
  );

  }

  registerAppTool(
    server,
    toolNames.editByLineRange,
    {
      title: "Edit by line range",
      description:
        "Replace a bounded line range.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        path: z.string().describe("File path."),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        newText: z.string(),
        expectedHash: z.string().optional().describe("Expected hash prefix."),
        dryRun: z.boolean().optional(),
      },
      outputSchema: resultSchema({
        status: z.enum(["validated", "applied"]),
        path: z.string(),
        additions: z.number().int().nonnegative(),
        removals: z.number().int().nonnegative(),
        dryRun: z.boolean(),
        selectedHash: z.string().optional(),
      }),
      _meta: {},
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, path, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await editByLineRange({ ...input, path, absolutePath: workspaces.resolvePath(workspace, path) });
        logToolCall({
          tool: toolNames.editByLineRange,
          workspaceId,
          path,
          operation: "edit_by_line_range",
          additions: result.additions,
          removals: result.removals,
          dryRun: result.dryRun,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(result.result)], structuredContent: result };
      } catch (error) {
        return failed(toolNames.editByLineRange, workspaceId, path, startedAt, error, logToolCall);
      }
    },
  );

  if (enableAdvancedTools) {
    registerAppTool(
    server,
    toolNames.insertByAnchor,
    {
      title: "Insert by anchor",
      description:
        "Insert content near an anchor string.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        path: z.string().describe("File path."),
        anchor: z.string().min(1),
        position: z.enum(["before", "after"]),
        content: z.string(),
        occurrence: z.number().int().positive().optional(),
        dryRun: z.boolean().optional(),
      },
      outputSchema: resultSchema({
        status: z.enum(["validated", "applied"]),
        path: z.string(),
        additions: z.number().int().nonnegative(),
        removals: z.number().int().nonnegative(),
        dryRun: z.boolean(),
        matches: z.number().int().nonnegative().optional(),
      }),
      _meta: {},
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, path, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await insertByAnchor({ ...input, path, absolutePath: workspaces.resolvePath(workspace, path) });
        logToolCall({ tool: toolNames.insertByAnchor, workspaceId, path, operation: "insert_by_anchor", additions: result.additions, removals: result.removals, dryRun: result.dryRun, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return { content: [textBlock(result.result)], structuredContent: result };
      } catch (error) {
        return failed(toolNames.insertByAnchor, workspaceId, path, startedAt, error, logToolCall);
      }
    },
  );

  registerAppTool(
    server,
    toolNames.replaceSymbol,
    {
      title: "Replace symbol",
      description:
        "Replace one named symbol range.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        path: z.string().describe("File path."),
        symbol: z.string(),
        kind: z.enum(["function", "class", "const", "any"]).optional(),
        newText: z.string(),
        expectedHash: z.string().optional().describe("Expected hash prefix."),
        dryRun: z.boolean().optional(),
      },
      outputSchema: resultSchema({
        status: z.enum(["validated", "applied"]),
        path: z.string(),
        additions: z.number().int().nonnegative(),
        removals: z.number().int().nonnegative(),
        dryRun: z.boolean(),
        selectedHash: z.string().optional(),
      }),
      _meta: {},
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, path, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await replaceSymbol({ ...input, path, absolutePath: workspaces.resolvePath(workspace, path) });
        logToolCall({ tool: toolNames.replaceSymbol, workspaceId, path, operation: "replace_symbol", additions: result.additions, removals: result.removals, dryRun: result.dryRun, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return { content: [textBlock(result.result)], structuredContent: result };
      } catch (error) {
        return failed(toolNames.replaceSymbol, workspaceId, path, startedAt, error, logToolCall);
      }
    },
  );

  }

  if (enableTaskTools) {
    registerAppTool(
      server,
      toolNames.taskCheckpoint,
    {
      title: "Task checkpoint",
      description:
        "Save a resumable task checkpoint.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        title: z.string(),
        objective: z.string(),
        completed: z.array(z.string()).optional(),
        pending: z.array(z.string()).optional(),
        changedFiles: z.array(z.string()).optional(),
        validation: z.array(z.string()).optional(),
        filteredOperations: z.array(z.string()).optional(),
        blockedOperations: z.array(z.string()).optional().describe("Deprecated."),
        nextAction: z.string().optional(),
        notes: z.string().optional(),
      },
      outputSchema: resultSchema({
        checkpointId: z.string(),
        path: z.string(),
        record: z.record(z.string(), z.unknown()),
      }),
      _meta: {},
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await saveTaskCheckpoint({ ...input, workspaceId, root: workspace.root });
        logToolCall({ tool: toolNames.taskCheckpoint, workspaceId, path: result.path, operation: "task_checkpoint", resultCharacters: result.result.length, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return { content: [textBlock(result.result)], structuredContent: result };
      } catch (error) {
        return failed(toolNames.taskCheckpoint, workspaceId, undefined, startedAt, error, logToolCall);
      }
    },
  );

  registerAppTool(
    server,
    toolNames.taskResume,
    {
      title: "Task resume",
      description:
        "Read a task checkpoint.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        checkpointId: z.string().optional(),
      },
      outputSchema: resultSchema({
        checkpointId: z.string().optional(),
        path: z.string().optional(),
        record: z.record(z.string(), z.unknown()).optional(),
      }),
      _meta: {},
      annotations: READ_ANNOTATIONS,
    },
    async ({ workspaceId, checkpointId }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await resumeTaskCheckpoint({ root: workspace.root, checkpointId });
        logToolCall({ tool: toolNames.taskResume, workspaceId, path: result.path, operation: "task_resume", resultCharacters: result.result.length, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return { content: [textBlock(result.result)], structuredContent: result };
      } catch (error) {
        return failed(toolNames.taskResume, workspaceId, undefined, startedAt, error, logToolCall);
      }
    },
  );
  }
}

function resultSchema(extra: z.ZodRawShape): z.ZodRawShape {
  return { result: z.string(), ...extra };
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function failed(tool: string, workspaceId: string | undefined, path: string | undefined, startedAt: number, error: unknown, logToolCall: (fields: LogFields) => void) {
  const message = error instanceof Error ? error.message : String(error);
  logToolCall({ tool, workspaceId, path, success: false, durationMs: Math.round(performance.now() - startedAt), error: message });
  return {
    content: [textBlock(message)],
    isError: true,
    structuredContent: { result: message },
  };
}
