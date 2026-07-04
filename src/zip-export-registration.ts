import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import type { WorkspaceRegistry } from "./workspaces.js";
import {
  exportIdFromResourceUri,
  ZIP_RESOURCE_MIME_TYPE,
  ZIP_RESOURCE_TEMPLATE,
  type WorkspaceZipExportStore,
} from "./workspace-zip-export.js";

type ToolContent = { type: "text"; text: string };

type LogFields = {
  tool: string;
  workspaceId?: string;
  operation?: string;
  path?: string;
  fileCount?: number;
  resultCharacters?: number;
  success: boolean;
  durationMs: number;
  error?: string;
};

export interface ZipExportToolNames {
  exportWorkspaceZip: "export_workspace_zip";
}

export interface RegisterZipExportToolsOptions {
  server: McpServer;
  workspaces: WorkspaceRegistry;
  exportStore: WorkspaceZipExportStore;
  toolNames: ZipExportToolNames;
  publicBaseUrl?: string;
  logToolCall(fields: LogFields): void;
}

export function registerZipExportTools(options: RegisterZipExportToolsOptions): void {
  const { server, workspaces, exportStore, toolNames, publicBaseUrl, logToolCall } = options;

  server.registerResource(
    "Workbridge ZIP export",
    new ResourceTemplate(ZIP_RESOURCE_TEMPLATE, {
      list: () => ({
        resources: exportStore.listExports().map((item) => ({
          uri: item.resourceUri,
          name: item.exportId,
          title: `ZIP export ${item.exportId}`,
          description: `${item.mode} workspace ZIP snapshot (${item.fileCount} files, ${item.sizeBytes} bytes).`,
          mimeType: ZIP_RESOURCE_MIME_TYPE,
        })),
      }),
    }),
    {
      title: "Workbridge ZIP export",
      description: "Binary ZIP workspace snapshot.",
      mimeType: ZIP_RESOURCE_MIME_TYPE,
    },
    async (uri, variables) => {
      const exportId = exportIdFromResourceUri(uri, variables);
      const record = exportStore.getExport(exportId);
      const blob = await exportStore.readExportBlob(exportId);
      return {
        contents: [
          {
            uri: record.resourceUri,
            mimeType: ZIP_RESOURCE_MIME_TYPE,
            blob,
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    toolNames.exportWorkspaceZip,
    {
      title: "Export workspace ZIP",
      description:
        "Create a Git-tracked workspace ZIP snapshot.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        mode: z.enum(["git_tracked"]).optional().describe("Export mode."),
        outputName: z.string().max(120).optional().describe("ZIP name."),
        includeManifest: z.boolean().optional().describe("Include manifest."),
        maxBytes: z.number().int().positive().max(500_000_000).optional().describe("Maximum ZIP bytes."),
        maxFiles: z.number().int().positive().max(50_000).optional().describe("Maximum files."),
      },
      outputSchema: {
        result: z.string(),
        exportId: z.string(),
        resourceUri: z.string(),
        zipPath: z.string(),
        mode: z.enum(["git_tracked"]),
        fileCount: z.number().int().nonnegative(),
        sizeBytes: z.number().int().nonnegative(),
        sha256: z.string(),
        manifestIncluded: z.boolean(),
        skippedFiles: z.array(z.string()),
      },
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const exported = await exportStore.exportWorkspaceZip(workspace, input);
        logToolCall({
          tool: toolNames.exportWorkspaceZip,
          workspaceId,
          operation: "export_workspace_zip",
          path: exported.zipPath,
          fileCount: exported.fileCount,
          resultCharacters: exported.result.length,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(`${exported.result}\nResource uri: ${exported.resourceUri}`)],
          structuredContent: exported,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall({
          tool: toolNames.exportWorkspaceZip,
          workspaceId,
          operation: "export_workspace_zip",
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
