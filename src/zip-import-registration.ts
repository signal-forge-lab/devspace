import { performance } from "node:perf_hooks";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { WorkspaceRegistry } from "./workspaces.js";
import {
  type WorkspaceZipImportStore,
  type ImportFileSource,
} from "./workspace-zip-import.js";

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

export interface ZipImportToolNames {
  probeImportFileArgShape: "probe_import_file_arg_shape";
  probeImportFile: "probe_import_file";
  importZipFile: "import_zip_file";
  importZipFromUrl: "import_zip_from_url";
  extractImportedZip: "extract_imported_zip";
}

export interface RegisterZipImportToolsOptions {
  server: McpServer;
  workspaces: WorkspaceRegistry;
  importStore: WorkspaceZipImportStore;
  toolNames: ZipImportToolNames;
  enableProbeTools?: boolean;
  logToolCall(fields: LogFields): void;
}

const fileParameter = z
  .file()
  .max(50 * 1024 * 1024)
  .describe("Uploaded file parameter.");

const fileOrUrlParameter = z
  .union([fileParameter, z.string().min(1).max(20_000)])
  .describe("Uploaded file or URL.");

const zipUrlParameter = z
  .string()
  .min(1)
  .max(20_000)
  .describe("HTTP(S) ZIP URL. Non-URL strings are accepted only to diagnose whether the MCP host rewrites uploaded file references.");

const importArgumentShapeOutput = {
  result: z.string(),
  valueKind: z.string(),
  constructorName: z.string().optional(),
  hasArrayBuffer: z.boolean(),
  hasName: z.boolean(),
  hasType: z.boolean(),
  hasSize: z.boolean(),
  stringKind: z.string().optional(),
  stringLength: z.number().int().nonnegative().optional(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  keys: z.array(z.string()),
};

export function registerZipImportTools(options: RegisterZipImportToolsOptions): void {
  const { server, workspaces, importStore, toolNames, enableProbeTools = false, logToolCall } = options;

  if (enableProbeTools) {
    registerAppTool(
      server,
      toolNames.probeImportFileArgShape,
    {
      title: "Probe import file argument shape",
      description:
        "Inspect an uploaded file argument shape.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        file: z.any().optional().describe("Raw argument."),
        source: z.string().optional().describe("String source."),
      },
      outputSchema: importArgumentShapeOutput,
      _meta: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, file, source }) => {
      const startedAt = performance.now();
      try {
        workspaces.getWorkspace(workspaceId);
        const inspected = importStore.probeImportArgumentShape(file ?? source);
        logToolCall({
          tool: toolNames.probeImportFileArgShape,
          workspaceId,
          operation: "probe_import_file_arg_shape",
          resultCharacters: inspected.result.length,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(`${inspected.result}\nkind: ${inspected.valueKind}`)], structuredContent: inspected };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall({
          tool: toolNames.probeImportFileArgShape,
          workspaceId,
          operation: "probe_import_file_arg_shape",
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
    toolNames.probeImportFile,
    {
      title: "Probe imported file",
      description:
        "Probe an uploaded file parameter.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        file: fileOrUrlParameter,
        maxBytes: z.number().int().positive().max(50 * 1024 * 1024).optional().describe("Maximum upload bytes."),
      },
      outputSchema: {
        result: z.string(),
        originalName: z.string(),
        mimeType: z.string(),
        sizeBytes: z.number().int().nonnegative(),
        sha256: z.string(),
      },
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspaceId, file, maxBytes }) => {
      const startedAt = performance.now();
      try {
        workspaces.getWorkspace(workspaceId);
        const probed = await importStore.probeImportFile(file as ImportFileSource, { maxBytes });
        logToolCall({
          tool: toolNames.probeImportFile,
          workspaceId,
          operation: "probe_import_file",
          resultCharacters: probed.result.length,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(`${probed.result}\nsha256: ${probed.sha256}`)], structuredContent: probed };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall({
          tool: toolNames.probeImportFile,
          workspaceId,
          operation: "probe_import_file",
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
    toolNames.importZipFile,
    {
      title: "Import ZIP file",
      description:
        "Import an uploaded ZIP into isolated DevSpace storage.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        file: fileOrUrlParameter,
        expectedSha256: z.string().optional().describe("Expected sha256."),
        maxBytes: z.number().int().positive().max(50 * 1024 * 1024).optional().describe("Maximum upload bytes."),
        maxFiles: z.number().int().positive().max(50_000).optional().describe("Maximum entries."),
      },
      outputSchema: {
        result: z.string(),
        importId: z.string(),
        importDir: z.string(),
        sourceZipPath: z.string(),
        originalName: z.string(),
        mimeType: z.string(),
        sizeBytes: z.number().int().nonnegative(),
        sha256: z.string(),
        entryCount: z.number().int().nonnegative(),
        totalUncompressedBytes: z.number().int().nonnegative(),
        manifestPresent: z.boolean(),
      },
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspaceId, file, expectedSha256, maxBytes, maxFiles }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const imported = await importStore.importZipFile(workspace, file as ImportFileSource, { expectedSha256, maxBytes, maxFiles });
        logToolCall({
          tool: toolNames.importZipFile,
          workspaceId,
          operation: "import_zip_file",
          path: imported.sourceZipPath,
          fileCount: imported.entryCount,
          resultCharacters: imported.result.length,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(`${imported.result}\nsha256: ${imported.sha256}`)], structuredContent: imported };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall({
          tool: toolNames.importZipFile,
          workspaceId,
          operation: "import_zip_file",
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return { content: [textBlock(message)], isError: true, structuredContent: { result: message } };
      }
    },
  );

  }

  registerAppTool(
    server,
    toolNames.importZipFromUrl,
    {
      title: "Import ZIP from URL",
      description:
        "Import a ZIP from an HTTP(S) URL into isolated DevSpace storage.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        url: zipUrlParameter,
        expectedSha256: z.string().optional().describe("Expected sha256."),
        maxBytes: z.number().int().positive().max(50 * 1024 * 1024).optional().describe("Maximum upload bytes."),
        maxFiles: z.number().int().positive().max(50_000).optional().describe("Maximum entries."),
      },
      outputSchema: {
        result: z.string(),
        importId: z.string(),
        importDir: z.string(),
        sourceZipPath: z.string(),
        originalName: z.string(),
        mimeType: z.string(),
        sizeBytes: z.number().int().nonnegative(),
        sha256: z.string(),
        entryCount: z.number().int().nonnegative(),
        totalUncompressedBytes: z.number().int().nonnegative(),
        manifestPresent: z.boolean(),
      },
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspaceId, url, expectedSha256, maxBytes, maxFiles }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const imported = await importStore.importZipFile(workspace, url, { expectedSha256, maxBytes, maxFiles });
        logToolCall({
          tool: toolNames.importZipFromUrl,
          workspaceId,
          operation: "import_zip_from_url",
          path: imported.sourceZipPath,
          fileCount: imported.entryCount,
          resultCharacters: imported.result.length,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(`${imported.result}
sha256: ${imported.sha256}`)], structuredContent: imported };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall({
          tool: toolNames.importZipFromUrl,
          workspaceId,
          operation: "import_zip_from_url",
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
    toolNames.extractImportedZip,
    {
      title: "Extract imported ZIP",
      description:
        "Extract an imported ZIP into isolated storage.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id."),
        importId: z.string().describe("Import id."),
        maxBytes: z.number().int().positive().max(50 * 1024 * 1024).optional().describe("Maximum extracted bytes."),
        maxFiles: z.number().int().positive().max(50_000).optional().describe("Maximum files."),
      },
      outputSchema: {
        result: z.string(),
        workspaceId: z.string(),
        importId: z.string(),
        extractDir: z.string(),
        fileCount: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
        files: z.array(z.string()),
      },
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, importId, maxBytes, maxFiles }) => {
      const startedAt = performance.now();
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        const extracted = await importStore.extractImportedZip(workspace, importId, { maxBytes, maxFiles });
        logToolCall({
          tool: toolNames.extractImportedZip,
          workspaceId,
          operation: "extract_imported_zip",
          path: extracted.extractDir,
          fileCount: extracted.fileCount,
          resultCharacters: extracted.result.length,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return { content: [textBlock(extracted.result)], structuredContent: extracted };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall({
          tool: toolNames.extractImportedZip,
          workspaceId,
          operation: "extract_imported_zip",
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
