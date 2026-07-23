import { performance } from "node:perf_hooks";
import type { Express, Response } from "express";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { redactPathsInText, workspacePathRedactions } from "./path-redaction.js";
import {
  createWorkspaceBundleEmbeddedTransferProbe,
  type WorkspaceBundleExport,
  type WorkspaceBundleReadReason,
  type WorkspaceBundleResult,
  type WorkspaceBundleStore,
} from "./workspace-bundle.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export type WorkspaceBundleToolContent =
  | { type: "text"; text: string }
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
    }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      title: string;
      description: string;
      mimeType: "application/zip";
      size: number;
      annotations: {
        audience: ["assistant", "user"];
        priority: 1;
      };
    };

export function workspaceBundleTransferResult(bundle: WorkspaceBundleExport): {
  content: WorkspaceBundleToolContent[];
  structuredContent: WorkspaceBundleResult;
} {
  const {
    blob,
    resourceUri,
    fileName,
    ...structuredContent
  } = bundle;
  return {
    content: [
      textBlock([
        bundle.result,
        `Embedded resource URI: ${resourceUri}`,
        `Fallback download URL: ${bundle.downloadUrl}`,
        `SHA-256: ${bundle.sha256}`,
      ].join("\n")),
      {
        type: "resource",
        resource: {
          uri: resourceUri,
          mimeType: "application/zip",
          blob,
        },
        annotations: {
          audience: ["assistant", "user"],
          priority: 1,
        },
      },
      {
        type: "resource_link",
        uri: bundle.downloadUrl,
        name: fileName,
        title: "Workbridge workspace bundle",
        description: "Fallback temporary ZIP snapshot for inspection and editing in the ChatGPT sandbox.",
        mimeType: "application/zip",
        size: bundle.sizeBytes,
        annotations: {
          audience: ["assistant", "user"],
          priority: 1,
        },
      },
    ],
    structuredContent,
  };
}

interface BundleToolLogFields {
  tool: string;
  workspaceId?: string;
  operation?: string;
  path?: string;
  fileCount?: number;
  resultCharacters?: number;
  reason?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

type AppToolRegistrar = typeof registerAppTool;

export function registerWorkspaceBundleEmbeddedTransferProbeTool(options: {
  server: McpServer;
  registerTool?: AppToolRegistrar;
  logToolCall(fields: BundleToolLogFields): void;
}): void {
  const { server, logToolCall } = options;
  const registerTool = options.registerTool ?? registerAppTool;
  registerTool(
    server,
    "probe_embedded_zip_transfer",
    {
      title: "Probe embedded ZIP transfer",
      description:
        "Return a tiny fixed valid ZIP as an MCP embedded binary resource. Diagnostic only: use this to verify whether the ChatGPT host materializes embedded tool resources into a sandbox file without fetching a public URL.",
      inputSchema: {},
      outputSchema: {
        result: z.string(),
        resourceUri: z.string(),
        fileName: z.string(),
        sizeBytes: z.number().int().positive(),
        sha256: z.string(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const startedAt = performance.now();
      const probe = createWorkspaceBundleEmbeddedTransferProbe();
      logToolCall({
        tool: "probe_embedded_zip_transfer",
        operation: "probe_embedded_zip_transfer",
        resultCharacters: probe.result.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [
          textBlock([
            probe.result,
            `Resource URI: ${probe.resourceUri}`,
            `SHA-256: ${probe.sha256}`,
          ].join("\n")),
          {
            type: "resource",
            resource: {
              uri: probe.resourceUri,
              mimeType: "application/zip",
              blob: probe.blob,
            },
            annotations: {
              audience: ["assistant", "user"],
              priority: 1,
            },
          },
        ],
        structuredContent: {
          result: probe.result,
          resourceUri: probe.resourceUri,
          fileName: probe.fileName,
          sizeBytes: probe.sizeBytes,
          sha256: probe.sha256,
        },
      };
    },
  );
}

export function registerWorkspaceBundleTool(options: {
  server: McpServer;
  workspaces: WorkspaceRegistry;
  bundleStore: WorkspaceBundleStore;
  registerTool?: AppToolRegistrar;
  logToolCall(fields: BundleToolLogFields): void;
}): void {
  const { server, workspaces, bundleStore, logToolCall } = options;
  const registerTool = options.registerTool ?? registerAppTool;
  registerTool(
    server,
    "export_workspace_bundle",
    {
      title: "Export workspace bundle",
      description:
        "Create the required ZIP snapshot for ChatGPT sandbox inspection and editing. Includes tracked and untracked non-ignored regular files, excludes common secret files and symbolic links, records a structured manifest, and returns a temporary download URL. In sandbox_bundle mode, use this before broad project inspection.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: {
        result: z.string(),
        bundleId: z.string().optional(),
        downloadUrl: z.string().optional(),
        expiresAt: z.string().optional(),
        fileCount: z.number().int().nonnegative().optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
        sha256: z.string().optional(),
        excludedFiles: z.array(z.string()).optional(),
        exclusions: z.array(z.object({
          path: z.string(),
          reason: z.enum([
            "reserved_path",
            "sensitive_path",
            "symbolic_link",
            "non_regular_file",
            "missing_at_export",
          ]),
          exceptionReadable: z.boolean(),
        })).optional(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      let workspaceRoot: string | undefined;
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaceRoot = workspace.root;
        const bundle = await bundleStore.exportWorkspace(workspace);
        logToolCall({
          tool: "export_workspace_bundle",
          workspaceId,
          operation: "export_workspace_bundle",
          path: bundle.bundleId,
          fileCount: bundle.fileCount,
          resultCharacters: bundle.result.length,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return workspaceBundleTransferResult(bundle);
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = redactPathsInText(rawMessage, workspacePathRedactions(workspaceRoot));
        logToolCall({
          tool: "export_workspace_bundle",
          workspaceId,
          operation: "export_workspace_bundle",
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          content: [textBlock(message)],
          isError: true,
          structuredContent: { result: message },
        };
      }
    },
  );
}

export function registerWorkspaceBundleExceptionReadTool(options: {
  server: McpServer;
  workspaces: WorkspaceRegistry;
  bundleStore: WorkspaceBundleStore;
  registerTool?: AppToolRegistrar;
  logToolCall(fields: BundleToolLogFields): void;
}): void {
  const { server, workspaces, bundleStore, logToolCall } = options;
  const registerTool = options.registerTool ?? registerAppTool;
  registerTool(
    server,
    "read_unbundled_file",
    {
      title: "Read unbundled file — exception only",
      description:
        "Exception-only UTF-8 text read for a file absent from a referenced sandbox bundle, or for an advertised external skill file. Requires the bundleId, a classified reason, and a brief task-specific purpose. Files present in the ZIP, sensitive paths, symbolic links, binary files, and files over 256 KiB are rejected.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        bundleId: z.string().describe("Bundle whose manifest proves that ordinary project inspection belongs in the sandbox."),
        path: z.string().describe("File absent from the referenced bundle, or an advertised external skill path."),
        reason: z.enum(["excluded_from_bundle", "external_instruction"]).describe(
          "Why the requested file cannot be read from the extracted sandbox bundle.",
        ),
        purpose: z.string().min(8).max(200).describe(
          "Brief task-specific reason this exceptional read is necessary.",
        ),
      },
      outputSchema: {
        result: z.string(),
        bundleId: z.string().optional(),
        path: z.string().optional(),
        reason: z.enum(["excluded_from_bundle", "external_instruction"]).optional(),
        purpose: z.string().optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
        sha256: z.string().optional(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, bundleId, path, reason, purpose }) => {
      const startedAt = performance.now();
      let workspaceRoot: string | undefined;
      try {
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaceRoot = workspace.root;
        const readPath = workspaces.resolveReadPath(workspace, path);
        const result = await bundleStore.readUnbundledFile({
          workspace,
          bundleId,
          requestedPath: path,
          absolutePath: readPath.absolutePath,
          readRoots: readPath.readRoots,
          reason: reason as WorkspaceBundleReadReason,
          purpose,
          externalInstruction: Boolean(readPath.skillRead?.isSkillFile),
        });
        workspaces.markReadPathLoaded(workspace, readPath);
        logToolCall({
          tool: "read_unbundled_file",
          workspaceId,
          operation: "read_unbundled_file",
          path: result.path,
          reason: result.reason,
          resultCharacters: result.result.length,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result.result)],
          structuredContent: result,
        };
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = redactPathsInText(rawMessage, workspacePathRedactions(workspaceRoot));
        logToolCall({
          tool: "read_unbundled_file",
          workspaceId,
          operation: "read_unbundled_file",
          path,
          reason,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          content: [textBlock(message)],
          isError: true,
          structuredContent: { result: message },
        };
      }
    },
  );
}

export function registerWorkspaceBundleDownloadRoutes(
  app: Express,
  bundleStore: WorkspaceBundleStore,
): void {
  app.head("/workbridge-bundles/:token/workspace.zip", (req, res) => {
    try {
      const download = bundleStore.peekDownload(req.params.token);
      setDownloadHeaders(res, download.fileName, download.sizeBytes, download.sha256);
      res.status(200).end();
    } catch {
      res.sendStatus(404);
    }
  });

  app.get("/workbridge-bundles/:token/workspace.zip", (req, res) => {
    let download;
    try {
      download = bundleStore.claimDownload(req.params.token);
    } catch {
      res.sendStatus(404);
      return;
    }

    setDownloadHeaders(res, download.fileName, download.sizeBytes, download.sha256);
    res.sendFile(download.filePath, {
      acceptRanges: false,
      cacheControl: false,
      dotfiles: "deny",
    }, (error) => {
      void bundleStore.completeDownload(download.token, !error);
      if (!error) return;
      if (!res.headersSent) res.sendStatus(500);
      else res.destroy();
    });
  });
}

function setDownloadHeaders(res: Response, fileName: string, sizeBytes: number, sha256: string): void {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Length", String(sizeBytes));
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Accept-Ranges", "none");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("Digest", `sha-256=${Buffer.from(sha256, "hex").toString("base64")}`);
}

function textBlock(text: string): WorkspaceBundleToolContent {
  return { type: "text", text };
}
