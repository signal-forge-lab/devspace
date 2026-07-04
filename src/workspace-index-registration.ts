import { performance } from "node:perf_hooks";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { WorkspaceRegistry } from "./workspaces.js";
import {
  type WorkspaceIndexStore,
} from "./workspace-index.js";

type ToolContent = { type: "text"; text: string };

type LogFields = {
  tool: string;
  workspaceId?: string;
  operation?: string;
  path?: string;
  fileCount?: number;
  resultLines?: number;
  resultCharacters?: number;
  returnedCharacters?: number;
  truncated?: boolean;
  reused?: boolean;
  source?: string;
  success: boolean;
  durationMs: number;
  error?: string;
};

export interface WorkspaceIndexToolNames {
  createWorkspaceIndex: "create_workspace_index";
  readIndexRanges: "read_index_ranges";
}

export interface RegisterWorkspaceIndexToolsOptions {
  server: McpServer;
  workspaces: WorkspaceRegistry;
  indexStore: WorkspaceIndexStore;
  toolNames: WorkspaceIndexToolNames;
  logToolCall(fields: LogFields): void;
}

const workspaceIndexEntryOutputSchema = z.object({
  number: z.number().int().positive(),
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

const readIndexRangeOutputSchema = z.object({
  number: z.number().int().positive(),
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  ok: z.boolean(),
  content: z.string().optional(),
  error: z.string().optional(),
  characters: z.number().int().nonnegative().optional(),
  lines: z.number().int().nonnegative().optional(),
  limited: z.boolean(),
});

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z.string(),
    ...extra,
  };
}

export function registerWorkspaceIndexTools(options: RegisterWorkspaceIndexToolsOptions): void {
  const { server, workspaces, indexStore, toolNames, logToolCall } = options;

  registerAppTool(
    server,
    toolNames.createWorkspaceIndex,
    {
      title: "Create workspace index",
      description:
        "Create a numeric index for Git-tracked files.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        mode: z.enum(["git_tracked"]).optional().describe("Index mode."),
        includeExtensions: z.array(z.string()).max(100).optional().describe("Extension allowlist."),
        pathPrefixes: z.array(z.string()).max(200).optional().describe("Path prefixes."),
        includePaths: z.array(z.string()).max(200).optional().describe("Exact paths."),
        maxFiles: z.number().int().positive().max(50_000).optional().describe("Maximum files."),
        maxPreviewFiles: z.number().int().positive().max(1_000).optional().describe("Preview limit."),
        reuse: z.boolean().optional().describe("Reuse an identical live index when available. Defaults to true."),
        refresh: z.boolean().optional().describe("Force a fresh index."),
        includePreview: z.boolean().optional().describe("Include preview entries. Defaults to true for created indexes and false for reused indexes."),
      },
      outputSchema: resultOutputSchema({
        indexId: z.string(),
        workspaceId: z.string(),
        mode: z.enum(["git_tracked"]),
        fileCount: z.number().int().nonnegative(),
        previewCount: z.number().int().nonnegative(),
        truncated: z.boolean(),
        pathHash: z.string(),
        fingerprintHash: z.string(),
        cacheKey: z.string(),
        reused: z.boolean(),
        source: z.enum(["created", "cache"]),
        staleReason: z.string().nullable().optional(),
        createdAt: z.string(),
        lastUsedAt: z.string(),
        entries: z.array(workspaceIndexEntryOutputSchema),
      }),
      _meta: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const index = await indexStore.createWorkspaceIndex(workspace, input);
        logToolCall({
          tool: toolNames.createWorkspaceIndex,
          workspaceId,
          operation: "create_workspace_index",
          fileCount: index.fileCount,
          resultLines: index.previewCount,
          resultCharacters: index.result.length,
          truncated: index.truncated,
          reused: index.reused,
          source: index.source,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(index.result)], structuredContent: index };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall({
          tool: toolNames.createWorkspaceIndex,
          workspaceId,
          operation: "create_workspace_index",
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return { content: [textBlock(message)], isError: true, structuredContent: { result: message } };
      }
    },
  );

  registerAppTool(
    server,
    toolNames.readIndexRanges,
    {
      title: "Read indexed ranges",
      description:
        "Read line ranges from a workspace index.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        indexId: z.string().describe("Index id."),
        spec: z.string().min(1).max(20_000).optional().describe("Compact range spec."),
        ranges: z.array(z.object({
          number: z.number().int().positive().describe("Index file number."),
          startLine: z.number().int().positive().describe("Start line."),
          endLine: z.number().int().positive().describe("End line."),
        })).max(500).optional().describe("Structured ranges."),
        maxTotalCharacters: z.number().int().positive().max(500_000).optional().describe("Maximum characters."),
        maxRanges: z.number().int().positive().max(500).optional().describe("Maximum ranges."),
        maxLinesPerRange: z.number().int().positive().max(20_000).optional().describe("Maximum lines per range."),
      },
      outputSchema: resultOutputSchema({
        indexId: z.string(),
        ranges: z.array(readIndexRangeOutputSchema),
        summary: z.object({
          requested: z.number().int().nonnegative(),
          succeeded: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          characters: z.number().int().nonnegative(),
          truncated: z.boolean(),
        }),
      }),
      _meta: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const ranges = await indexStore.readIndexRanges(workspace, input);
        logToolCall({
          tool: toolNames.readIndexRanges,
          workspaceId,
          operation: "read_index_ranges",
          fileCount: ranges.summary.requested,
          resultLines: ranges.ranges.reduce((total, range) => total + (range.lines ?? 0), 0),
          resultCharacters: ranges.result.length,
          returnedCharacters: ranges.summary.characters,
          truncated: ranges.summary.truncated,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(ranges.result)], structuredContent: ranges };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall({
          tool: toolNames.readIndexRanges,
          workspaceId,
          operation: "read_index_ranges",
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return { content: [textBlock(message)], isError: true, structuredContent: { result: message } };
      }
    },
  );
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}
