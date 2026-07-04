import { performance } from "node:perf_hooks";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { WorkspaceZipExportStore } from "./workspace-zip-export.js";

type ToolContent = { type: "text"; text: string };

type LogFields = {
  tool: string;
  operation?: string;
  path?: string;
  fileCount?: number;
  resultCharacters?: number;
  success: boolean;
  durationMs: number;
  error?: string;
};

export interface ZipTransferToolNames {
  createZipDownloadUrl: "create_zip_download_url";
}

export function registerZipTransferTools(options: {
  server: McpServer;
  exportStore: WorkspaceZipExportStore;
  toolNames: ZipTransferToolNames;
  publicBaseUrl: string;
  logToolCall(fields: LogFields): void;
}): void {
  const { server, exportStore, toolNames, publicBaseUrl, logToolCall } = options;

  registerAppTool(
    server,
    toolNames.createZipDownloadUrl,
    {
      title: "Create ZIP download URL",
      description: "Create a temporary ZIP download URL.",
      inputSchema: {
        exportId: z.string(),
        ttlSeconds: z.number().int().positive().max(3600).optional(),
        maxDownloads: z.number().int().positive().max(10).optional(),
      },
      outputSchema: {
        result: z.string(),
        exportId: z.string(),
        downloadUrl: z.string(),
        token: z.string(),
        expiresAt: z.string(),
        ttlSeconds: z.number().int().positive(),
        maxDownloads: z.number().int().positive(),
      },
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ exportId, ttlSeconds, maxDownloads }) => {
      const startedAt = performance.now();
      try {
        const link = exportStore.createDownloadUrl(exportId, publicBaseUrl, { ttlSeconds, maxDownloads });
        logToolCall({
          tool: toolNames.createZipDownloadUrl,
          operation: "create_zip_download_url",
          resultCharacters: link.result.length,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(`${link.result}\nDownload URL: ${link.downloadUrl}`)], structuredContent: link };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall({
          tool: toolNames.createZipDownloadUrl,
          operation: "create_zip_download_url",
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
