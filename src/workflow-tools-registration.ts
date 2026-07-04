import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { DEVSPACE_VERIFY_PROFILES, devspaceVerify } from "./devspace-verify.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import {
  applyStructuredEdit,
  applyUnifiedPatch,
  checkWorkspaceInvariants,
  devspaceRouter,
  recordWorkflowEvent,
  resolveLocator,
  type WorkflowMode,
} from "./workflow-tools.js";

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

export interface WorkflowToolNames {
  applyUnifiedPatch: "apply_unified_patch";
  resolveLocator: "resolve_locator";
  applyStructuredEdit: "apply_structured_edit";
  checkWorkspaceInvariants: "check_workspace_invariants";
  recordWorkflowEvent: "record_workflow_event";
  devspaceRouter: "devspace_router";
  devspaceVerify: "devspace_verify";
}

export interface RegisterWorkflowToolsOptions {
  server: McpServer;
  workspaces: WorkspaceRegistry;
  toolNames: WorkflowToolNames;
  logToolCall(fields: LogFields): void;
}

const workflowModeSchema = z.enum(["baseline", "zip_first", "router", "zip_first_router"]);
const contentEncodingSchema = z.enum(["plain", "base64"]);
const taskClassSchema = z.enum(["read_inspect", "small_edit", "large_edit_refactor", "validation_test", "structured_sensitive_integration", "runtime_external_side_effect", "packaging_release", "incident_recovery"]);
const locatorSchema = z.object({
  type: z.enum(["line_range", "anchor", "between_anchors", "section_heading", "regex_single_match", "exact_text"]),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  anchor: z.string().optional(),
  startAnchor: z.string().optional(),
  endAnchor: z.string().optional(),
  heading: z.string().optional(),
  pattern: z.string().optional(),
  flags: z.string().optional(),
  exactText: z.string().optional(),
  occurrence: z.number().int().positive().optional(),
  includeStartAnchor: z.boolean().optional(),
  includeEndAnchor: z.boolean().optional(),
  includeHeading: z.boolean().optional(),
});

const locatorCandidateSchema = z.object({
  candidateId: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  selectedHash: z.string(),
  preview: z.string(),
});

const invariantCheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("token_absent"), id: z.string().optional(), token: z.string(), paths: z.array(z.string()).min(1).max(100) }),
  z.object({ type: z.literal("token_present"), id: z.string().optional(), token: z.string(), paths: z.array(z.string()).min(1).max(100), minCount: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("regex_count"), id: z.string().optional(), pattern: z.string(), flags: z.string().optional(), paths: z.array(z.string()).min(1).max(100), minCount: z.number().int().nonnegative().optional(), maxCount: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("structured_value_equal"), id: z.string().optional(), values: z.array(z.object({ path: z.string(), pointer: z.string() })).min(2).max(20) }),
]);

const routerTargetsSchema = z.object({
  paths: z.array(z.string()).min(1).max(100).optional(),
  numbers: z.array(z.number().int().positive()).max(100).optional(),
});

const routerLimitsSchema = z.object({
  maxFiles: z.number().int().positive().max(100).optional(),
  maxLines: z.number().int().positive().max(1000).optional(),
  maxOutputChars: z.number().int().positive().max(100_000).optional(),
  maxPreviewChars: z.number().int().positive().max(10_000).optional(),
});

const routerRefsSchema = z.record(z.string(), z.string().optional());

const verifyProfileSchema = z.enum(DEVSPACE_VERIFY_PROFILES);

const runtimeInfoSchema = z.object({
  appName: z.string(),
  displayName: z.string(),
  legacyName: z.string(),
  appVersion: z.string(),
  gitCommit: z.string(),
  gitBranch: z.string(),
  buildSource: z.string(),
  processStartedAt: z.string(),
  processId: z.number().int(),
  nodeVersion: z.string(),
  platform: z.string(),
  cliEntryPath: z.string(),
  runtimeDistPath: z.string(),
  cwd: z.string(),
});
const verifyCommandResultSchema = z.object({
  label: z.string(),
  bin: z.string(),
  args: z.array(z.string()),
  status: z.enum(["ok", "failed", "timed_out"]),
  exitCode: z.union([z.number(), z.string()]).optional(),
  signal: z.string().optional(),
  durationMs: z.number(),
  stdoutChars: z.number(),
  stderrChars: z.number(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
  stdoutOmitted: z.boolean(),
  stderrOmitted: z.boolean(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
});

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const VERIFY_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READ_ANNOTATIONS = { readOnlyHint: true };

export function registerWorkflowTools(options: RegisterWorkflowToolsOptions): void {
  const { server, workspaces, toolNames, logToolCall } = options;

  registerAppTool(
    server,
    toolNames.devspaceVerify,
    {
      title: "DevSpace verify",
      description:
        "Run fixed verification profiles with bounded output. Use this instead of ad-hoc bash for typecheck, related tests, npm test, build, or git diff check. The profile is an enum; arbitrary shell commands are not accepted. Successful commands return summaries and bounded warning/error tails rather than full stdout.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        profile: verifyProfileSchema,
        workflowMode: workflowModeSchema.optional(),
        timeoutMs: z.number().int().positive().max(300_000).optional(),
        maxOutputChars: z.number().int().positive().max(50_000).optional(),
        includeOutputOnSuccess: z.boolean().optional(),
      },
      outputSchema: resultSchema({
        status: z.enum(["ok", "failed", "timed_out"]),
        profile: verifyProfileSchema,
        workflowMode: workflowModeSchema.optional(),
        durationMs: z.number(),
        commandCount: z.number(),
        commands: z.array(verifyCommandResultSchema),
        summary: z.object({ failedCommands: z.number(), timedOutCommands: z.number(), stdoutChars: z.number(), stderrChars: z.number(), outputOmitted: z.boolean(), outputTruncated: z.boolean() }),
        runtimeInfo: runtimeInfoSchema,
      }),
      _meta: {},
      annotations: VERIFY_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await devspaceVerify({ ...input, workspace, workflowMode: input.workflowMode as WorkflowMode | undefined });
        const durationMs = Math.round(performance.now() - startedAt);
        if (input.workflowMode) {
          await recordWorkflowEvent({
            workspace,
            workflowMode: input.workflowMode as WorkflowMode,
            event: "devspace_verify",
            action: input.profile,
            tool: toolNames.devspaceVerify,
            status: result.status,
            testsRun: input.profile.includes("test") || input.profile === "related_tests" || input.profile === "npm_test" ? result.commands.length : undefined,
            outputChars: result.summary.stdoutChars + result.summary.stderrChars,
            durationMs,
            note: result.result,
          });
        }
        logToolCall({ tool: toolNames.devspaceVerify, workspaceId, operation: `verify_${input.profile}`, resultCharacters: result.result.length, success: result.status === "ok", durationMs });
        return { content: [textBlock(result.result)], structuredContent: result, isError: result.status !== "ok" };
      } catch (error) {
        return failed(toolNames.devspaceVerify, workspaceId, undefined, startedAt, error, logToolCall);
      }
    },
  );

  registerAppTool(
    server,
    toolNames.devspaceRouter,
    {
      title: "DevSpace router",
      description:
        "Route small, structured DevSpace workflow requests. Prefer this over broad bash/read/grep when action + targets + refs + limits can express the task. Do not pass large content, shell commands, patches, or newContent. Router v1 is read-only/planning oriented and can also suggest fixed devspace_verify profiles; use apply_unified_patch or apply_structured_edit for edits after inspection.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        workflowMode: workflowModeSchema.describe("Experiment mode for baseline/zip_first/router comparison."),
        action: z.enum(["start", "snapshot", "inspect", "resolve_locator", "check_invariants", "summarize", "verify_plan", "suggest_verify"]),
        mode: z.enum(["plan_only", "read_only"]).optional(),
        intent: z.string().max(1000).optional().describe("Short intent only. Do not paste large context."),
        taskClass: taskClassSchema.optional().describe("Optional shared task class for verification policy."),
        refs: routerRefsSchema.optional(),
        targets: routerTargetsSchema.optional(),
        locatorRequest: z.object({ path: z.string(), locator: locatorSchema, expectedSha256: z.string().optional() }).optional(),
        invariantChecks: z.array(invariantCheckSchema).min(1).max(50).optional(),
        limits: routerLimitsSchema.optional(),
      },
      outputSchema: resultSchema({
        status: z.enum(["ok", "blocked"]),
        action: z.enum(["start", "snapshot", "inspect", "resolve_locator", "check_invariants", "summarize", "verify_plan", "suggest_verify"]),
        mode: z.enum(["plan_only", "read_only"]),
        workflowMode: workflowModeSchema,
        refs: z.record(z.string(), z.string()),
        summary: z.record(z.string(), z.unknown()),
        results: z.record(z.string(), z.unknown()),
        nextRecommendedAction: z.string().optional(),
        warnings: z.array(z.string()),
        runtimeInfo: runtimeInfoSchema,
      }),
      _meta: {},
      annotations: READ_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await devspaceRouter({ ...input, workspace, workflowMode: input.workflowMode as WorkflowMode });
        const durationMs = Math.round(performance.now() - startedAt);
        await recordWorkflowEvent({
          workspace,
          workflowMode: input.workflowMode as WorkflowMode,
          event: "devspace_router",
          action: input.action,
          tool: toolNames.devspaceRouter,
          status: result.status,
          filesRead: Array.isArray((result.results as { files?: unknown[] }).files) ? ((result.results as { files?: unknown[] }).files?.length ?? 0) : undefined,
          outputChars: result.result.length,
          durationMs,
          note: result.nextRecommendedAction,
        });
        logToolCall({ tool: toolNames.devspaceRouter, workspaceId, operation: `router_${input.action}`, resultCharacters: result.result.length, success: result.status === "ok", durationMs });
        return { content: [textBlock(result.result)], structuredContent: result, isError: result.status !== "ok" };
      } catch (error) {
        return failed(toolNames.devspaceRouter, workspaceId, undefined, startedAt, error, logToolCall);
      }
    },
  );

  registerAppTool(
    server,
    toolNames.applyUnifiedPatch,
    {
      title: "Apply unified patch",
      description: "Apply a hash-guarded unified diff patch.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        patch: z.string().max(1_000_000).describe("Unified diff patch."),
        contentEncoding: contentEncodingSchema.optional().describe("Typed transport encoding for patch content."),
        expectedBase: z.array(z.object({ path: z.string(), sha256: z.string() })).min(1).max(100).describe("Expected full-file sha256 by path."),
        dryRun: z.boolean().optional(),
        workflowMode: workflowModeSchema.optional(),
        maxPatchBytes: z.number().int().positive().max(1_000_000).optional(),
        maxDecodedBytes: z.number().int().positive().max(1_000_000).optional(),
        maxFiles: z.number().int().positive().max(100).optional(),
        maxHunks: z.number().int().positive().max(500).optional(),
        requireTracked: z.boolean().optional(),
      },
      outputSchema: resultSchema({
        status: z.enum(["validated", "applied"]),
        dryRun: z.boolean(),
        workflowMode: workflowModeSchema.optional(),
        contentEncoding: contentEncodingSchema,
        decodedBytes: z.number().int().nonnegative(),
        files: z.array(z.object({ path: z.string(), hunks: z.number(), additions: z.number(), removals: z.number(), oldSha256: z.string(), newSha256: z.string() })),
        summary: z.object({ fileCount: z.number(), hunkCount: z.number(), additions: z.number(), removals: z.number() }),
      }),
      _meta: {},
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await applyUnifiedPatch({ ...input, workspace, workflowMode: input.workflowMode as WorkflowMode | undefined });
        logToolCall({ tool: toolNames.applyUnifiedPatch, workspaceId, operation: "apply_unified_patch", editCount: result.files.length, additions: result.summary.additions, removals: result.summary.removals, dryRun: result.dryRun, resultCharacters: result.result.length, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return { content: [textBlock(result.result)], structuredContent: result };
      } catch (error) {
        return failed(toolNames.applyUnifiedPatch, workspaceId, undefined, startedAt, error, logToolCall);
      }
    },
  );

  registerAppTool(
    server,
    toolNames.resolveLocator,
    {
      title: "Resolve locator",
      description: "Resolve a small locator into candidate ranges.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string(),
        locator: locatorSchema,
        expectedSha256: z.string().optional(),
        maxPreviewChars: z.number().int().positive().max(2000).optional(),
      },
      outputSchema: resultSchema({
        path: z.string(),
        sha256: z.string(),
        lineCount: z.number(),
        matchCount: z.number(),
        selected: locatorCandidateSchema.optional(),
        candidates: z.array(locatorCandidateSchema),
      }),
      _meta: {},
      annotations: READ_ANNOTATIONS,
    },
    async ({ workspaceId, path, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await resolveLocator({ ...input, workspace, path });
        logToolCall({ tool: toolNames.resolveLocator, workspaceId, path, operation: "resolve_locator", resultCharacters: result.result.length, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return { content: [textBlock(result.result)], structuredContent: result };
      } catch (error) {
        return failed(toolNames.resolveLocator, workspaceId, path, startedAt, error, logToolCall);
      }
    },
  );

  registerAppTool(
    server,
    toolNames.applyStructuredEdit,
    {
      title: "Apply structured edit",
      description: "Apply a locator-based structured edit with sha256 guard.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string(),
        locator: locatorSchema,
        operation: z.object({
          type: z.enum(["replace", "insert_before", "insert_after", "replace_section_body"]),
          content: z.string().max(300_000),
          contentEncoding: contentEncodingSchema.optional(),
          maxDecodedBytes: z.number().int().positive().max(1_000_000).optional(),
        }),
        expectedSha256: z.string().optional(),
        dryRun: z.boolean().optional(),
        workflowMode: workflowModeSchema.optional(),
      },
      outputSchema: resultSchema({
        status: z.enum(["validated", "applied"]),
        path: z.string(),
        dryRun: z.boolean(),
        workflowMode: workflowModeSchema.optional(),
        contentEncoding: contentEncodingSchema,
        decodedBytes: z.number().int().nonnegative(),
        lineStart: z.number(),
        lineEnd: z.number(),
        selectedHash: z.string(),
        oldSha256: z.string(),
        newSha256: z.string(),
        additions: z.number(),
        removals: z.number(),
      }),
      _meta: {},
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, path, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await applyStructuredEdit({ ...input, workspace, path, workflowMode: input.workflowMode as WorkflowMode | undefined });
        logToolCall({ tool: toolNames.applyStructuredEdit, workspaceId, path, operation: "apply_structured_edit", additions: result.additions, removals: result.removals, dryRun: result.dryRun, resultCharacters: result.result.length, success: true, durationMs: Math.round(performance.now() - startedAt) });
        return { content: [textBlock(result.result)], structuredContent: result };
      } catch (error) {
        return failed(toolNames.applyStructuredEdit, workspaceId, path, startedAt, error, logToolCall);
      }
    },
  );

  registerAppTool(
    server,
    toolNames.checkWorkspaceInvariants,
    {
      title: "Check workspace invariants",
      description: "Run generic token, regex, and structured-value consistency checks.",
      inputSchema: {
        workspaceId: z.string(),
        checks: z.array(invariantCheckSchema).min(1).max(50),
        workflowMode: workflowModeSchema.optional(),
        maxFiles: z.number().int().positive().max(1000).optional(),
        maxMatches: z.number().int().positive().max(1000).optional(),
      },
      outputSchema: resultSchema({
        status: z.enum(["ok", "failed"]),
        workflowMode: workflowModeSchema.optional(),
        checks: z.array(z.object({ id: z.string(), type: z.string(), ok: z.boolean(), count: z.number().optional(), message: z.string(), matches: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })).optional() }).passthrough()),
        summary: z.object({ total: z.number(), failed: z.number() }),
      }),
      _meta: {},
      annotations: READ_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const result = await checkWorkspaceInvariants({ ...input, workspace, workflowMode: input.workflowMode as WorkflowMode | undefined });
        logToolCall({ tool: toolNames.checkWorkspaceInvariants, workspaceId, operation: "check_workspace_invariants", resultCharacters: result.result.length, success: result.status === "ok", durationMs: Math.round(performance.now() - startedAt) });
        return { content: [textBlock(result.result)], structuredContent: result, isError: result.status !== "ok" };
      } catch (error) {
        return failed(toolNames.checkWorkspaceInvariants, workspaceId, undefined, startedAt, error, logToolCall);
      }
    },
  );


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
  return { content: [textBlock(message)], isError: true, structuredContent: { result: message } };
}
