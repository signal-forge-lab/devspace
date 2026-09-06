import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
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
import { createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import { toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
  sessionIdPrefix,
} from "./logger.js";
import { readFileTool } from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SoftPauseController } from "./soft-pause.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
} from "./mcp-sessions.js";
import { McpSessionLifecycle, isOpenAiMcpClient } from "./mcp-session-lifecycle.js";
import { ModernMcpRequestMetrics } from "./mcp-modern-metrics.js";
import { NodeSaturationMetrics } from "./node-saturation-metrics.js";
import { detectModernMcpProbe } from "./mcp-modern-probe.js";
import { createModernMcpServerAdapter } from "./mcp-modern-server.js";
import {
  bindMcpToolCatalog,
  createMcpToolCatalogRecorder,
  type CompiledMcpToolCatalog,
} from "./mcp-tool-catalog.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { SerenaSemanticManager } from "./serena-semantic.js";
import { CodebaseMemoryManager } from "./codebase-memory-code-intelligence.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { runCleanupSteps, shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
  workspaceAppDescriptorMeta,
} from "./tool-surfaces/shared.js";
import {
  WORKSPACE_APP_URI,
  toolNames,
  workspaceIdDescription,
  type ToolContent,
  type ToolSurface,
} from "./tool-surfaces/types.js";
import {
  registerSessionMonitorRoutes,
  type AppToolRegistrar,
  type SessionMonitorContext,
  type SessionMonitorRuntimeStatus,
} from "./session-monitor-integration.js";
import { SessionMonitor } from "./session-monitor.js";
import {
  createWorkbridgeToolRegistrars,
  registerWorkbridgeExtensionTools,
  workbridgeServerInstructions,
} from "./workbridge-tool-registration.js";
import { configProvenance } from "./workbridge-config-provenance.js";
import { runtimeBuildIdentity } from "./workbridge-runtime-identity.js";
import { LEGACY_SERVICE_NAME, PRODUCT_DISPLAY_NAME } from "./branding.js";
import { PACKAGE_VERSION } from "./version.js";

type Transport = StreamableHTTPServerTransport;
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  monitorApp: ReturnType<typeof express>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderStatus[];
  runtimeStatus(): SessionMonitorRuntimeStatus;
  close(): Promise<void>;
}

function mcpServerInfo() {
  return {
    name: LEGACY_SERVICE_NAME,
    title: PRODUCT_DISPLAY_NAME,
    version: PACKAGE_VERSION,
    description:
      "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspaceId.",
  };
}

function mcpServerOptions() {
  return { instructions: workbridgeServerInstructions() };
}

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

function serverInstructions(
  config: ServerConfig,
  toolSurface: ToolSurface,
): string {
  const artifactInstruction =
    config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
      ? ` When the user supplies or generates a file that is not present on the ${PRODUCT_DISPLAY_NAME} host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs.`
      : "";
  const showChangesInstruction =
    " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change.";
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";
  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;
  const common = `Use ${PRODUCT_DISPLAY_NAME} for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected.`;

  return `${common} ${toolSurface.instructions({ agents, skills })}${artifactInstruction}${showChangesInstruction}`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const effort = agent.effort ? `, effort ${agent.effort}` : "";
  return `${agent.name} (${agent.provider}${model}${effort})`;
}

function formatAvailableAgentProvider(provider: {
  id: string;
  model?: string;
  effort?: string;
  note?: string;
}): string {
  const details = [
    provider.model ? `model ${provider.model}` : undefined,
    provider.effort ? `effort ${provider.effort}` : undefined,
    provider.note,
  ].filter(Boolean).join(", ");
  return `${provider.id}${details ? ` (${details})` : ""}`;
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

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

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

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
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
    <title>${PRODUCT_DISPLAY_NAME} Workspace</title>
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

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  softPause = new SoftPauseController(config.stateDir),
  monitorContext?: SessionMonitorContext,
  semanticManager = new SerenaSemanticManager({ stateDir: config.stateDir }),
  codebaseMemoryManager = new CodebaseMemoryManager({ stateDir: config.stateDir }),
  registration: {
    server?: McpServer;
    baseRegisterTool?: AppToolRegistrar;
    registerAppResources?: boolean;
  } = {},
): McpServer {
  const toolSurface = getToolSurface(config.toolMode);
  const server = registration.server ?? new McpServer(mcpServerInfo(), mcpServerOptions());
  const sdkBaseRegisterTool = ((
    sdkServer: McpServer,
    name: string,
    definition: unknown,
    handler: unknown,
  ) => (sdkServer.registerTool as (...args: unknown[]) => unknown)(name, definition, handler)) as AppToolRegistrar;
  const {
    registerTool,
    artifactRegisterTool,
  } = createWorkbridgeToolRegistrars({
    config,
    softPause,
    workspaces,
    monitorContext,
    baseRegisterTool: registration.baseRegisterTool ?? sdkBaseRegisterTool,
  });
  const registerSdkTool = ((name, definition, handler) =>
    (registerTool as (...args: unknown[]) => unknown)(server, name, definition, handler)) as McpServer["registerTool"];

  if (registration.registerAppResources !== false && config.widgets !== "off") registerAppResource(
    server,
    `${PRODUCT_DISPLAY_NAME} Diff Card`,
    WORKSPACE_APP_URI,
    {
      description: `Interactive card for viewing ${PRODUCT_DISPLAY_NAME} file diffs.`,
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

  registerTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Start work in a project directory or isolated worktree when no usable workspaceId exists for it. During continued work, reuse the existing workspaceId instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
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
        agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skillDiagnostics: z.array(z.unknown()).optional(),
        review: z.discriminatedUnion("available", [
          z.object({ available: z.literal(true) }),
          z.object({
            available: z.literal(false),
            reason: z.string(),
          }),
        ]),
        instruction: z.string(),
      },
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }, { _meta }) => {
      const startedAt = performance.now();
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, mode, baseRef },
        { conversationScopeId: openAiConversationScopeId(_meta) },
      );
      const review = await reviewCheckpoints.initializeWorkspace({
        workspaceId: workspace.id,
        root: workspace.root,
      });
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const agentCatalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const cardAgentProviders = agentCatalog.providers
        .filter((provider) => provider.usable)
        .map((provider) => ({
          id: provider.id,
          model: provider.model,
          effort: provider.effort,
          note: provider.note,
        }));
      const cardAgents = agentCatalog.profiles;
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const cardInstruction = config.skillsEnabled
        ? "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const instruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspaceId.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspaceId for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
          : cardInstruction;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
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
            visibleAgentProviders.length > 0
              ? `Available subagent providers: ${visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
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
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            availableAgentsFiles: cardAvailableAgentsFiles,
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            review,
            instruction: cardInstruction,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          review,
          ...(includeBootstrapContext
            ? {
                agentsFiles: loadedAgentsFiles,
                availableAgentsFiles: availableAgentsFileOutputs,
                skills: visibleSkills,
                agentProviders: visibleAgentProviders,
                agents: visibleAgents,
                skillDiagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
        },
      };
    },
  );

  server.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file in a workspace. Use this for file inspection instead of shell commands like cat or sed.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
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

      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  toolSurface.register({
    server,
    registerTool: registerSdkTool,
    config,
    workspaces,
    processSessions,
  });

  registerTool(
    server,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        workspaceId: z.string(),
        reviewRef: z.string().regex(/^[0-9a-f]{40,64}$/),
      }),
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const reviewRef = typeof _meta?.["devspace/reviewRef"] === "string"
        ? _meta["devspace/reviewRef"]
        : undefined;
      const review = reviewRef
        ? await reviewCheckpoints.reviewByRef({
            workspaceId,
            root: workspace.root,
            reviewRef,
          })
        : await reviewCheckpoints.reviewChanges({
            workspaceId,
            root: workspace.root,
            markReviewed: true,
          });

      const content = [textBlock(review.result)];
      logToolCall(config, {
        tool: "show_changes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          card: {
            workspaceId,
            summary: review.summary,
            files: review.files,
            payload: {
              patch: review.patch,
            },
          },
        },
        structuredContent: {
          workspaceId,
          reviewRef: review.reviewRef,
          result: contentText(content),
        },
      };
    },
  );

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(server, {
      config,
      workspaces,
      incomingArtifactAdapters,
      registerTool: artifactRegisterTool,
    });
  }

  registerWorkbridgeExtensionTools({
    server,
    config,
    workspaces,
    processSessions,
    semanticManager,
    codebaseMemoryManager,
    incomingArtifactAdapters,
    registerTool,
    artifactRegisterTool,
    shellToolMeta: { _meta: {} },
  });

  return server;
}

function compileModernMcpToolCatalog(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  softPause: SoftPauseController,
  sessionMonitor: SessionMonitor,
  semanticManager: SerenaSemanticManager,
  codebaseMemoryManager: CodebaseMemoryManager,
): CompiledMcpToolCatalog {
  const recorder = createMcpToolCatalogRecorder();
  createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    processSessions,
    resolveLocalAgentProviders,
    incomingArtifactAdapters,
    softPause,
    { monitor: sessionMonitor, sessionId: () => undefined },
    semanticManager,
    codebaseMemoryManager,
    {
      server: new McpServer(mcpServerInfo(), mcpServerOptions()),
      baseRegisterTool: recorder.registrar,
      registerAppResources: false,
    },
  );
  return recorder.compile();
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const monitorApp = express();
  monitorApp.disable("x-powered-by");
  const sessionLifecycle = new McpSessionLifecycle<Transport>({
    log: (level, event, fields) => logEvent(config.logging, level, event, fields),
  });
  const modernMcpMetrics = new ModernMcpRequestMetrics();
  const modernMcpRequestContext = new AsyncLocalStorage<symbol>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = config.oauth
    ? new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir)
    : undefined;
  const bearerAuth = oauthProvider && config.oauth
    ? requireBearerAuth({
        verifier: oauthProvider,
        requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
      })
    : undefined;
  const workspaceStore = createWorkspaceStore(config.stateDir, config.workspaceSessionMaxAgeMs);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const localAgentProviders = resolveLocalAgentProviders();
  const semanticManager = new SerenaSemanticManager({ stateDir: config.stateDir });
  const codebaseMemoryManager = new CodebaseMemoryManager({ stateDir: config.stateDir });
  const softPause = new SoftPauseController(config.stateDir);
  const sessionMonitor = new SessionMonitor();
  const nodeSaturation = new NodeSaturationMetrics();
  nodeSaturation.start();
  const serverStartedAt = Date.now();
  const buildIdentity = runtimeBuildIdentity();
  const runtimeConfigProvenance = config.provenance ?? configProvenance();
  const modernMcpToolCatalog = compileModernMcpToolCatalog(
    config,
    workspaces,
    reviewCheckpoints,
    processSessions,
    resolveLocalAgentProviders,
    incomingArtifactAdapters,
    softPause,
    sessionMonitor,
    semanticManager,
    codebaseMemoryManager,
  );
  sessionLifecycle.start();
  const modernMcpHandler = createMcpHandler(() => {
    const registrationStartedAt = performance.now();
    const requestReference = modernMcpRequestContext.getStore();
    if (requestReference) modernMcpMetrics.beginRegistration(requestReference);
    try {
      const adapter = createModernMcpServerAdapter(mcpServerInfo(), mcpServerOptions());
      bindMcpToolCatalog(adapter.registerTool, modernMcpToolCatalog);
      if (requestReference) {
        modernMcpMetrics.recordTimings(requestReference, {
          registrationMs: performance.now() - registrationStartedAt,
        });
      }
      return adapter.server;
    } finally {
      if (requestReference) modernMcpMetrics.endRegistration(requestReference);
    }
  }, { legacy: "reject" });
  const modernNodeHandler = toNodeHandler(modernMcpHandler, {
    onerror: (error) => logEvent(config.logging, "error", "mcp_modern_adapter_error", {
      error: error instanceof Error ? error.message : String(error),
    }),
  });

  if (config.logging.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

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
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  if (oauthProvider && config.oauth) {
    app.use(
      mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(config.publicBaseUrl),
        baseUrl: new URL(config.publicBaseUrl),
        resourceServerUrl,
        scopesSupported: config.oauth.scopes,
        resourceName: PRODUCT_DISPLAY_NAME,
      }),
    );
  }

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
    res.json({ ok: true, name: LEGACY_SERVICE_NAME });
  });

  const runtimeStatus = (): SessionMonitorRuntimeStatus => {
    const pauseState = softPause.status();
    const memory = process.memoryUsage();
    return {
      server: {
        status: "running",
        pid: process.pid,
        startedAt: new Date(serverStartedAt).toISOString(),
        uptimeMs: Math.max(0, Date.now() - serverStartedAt),
        version: PACKAGE_VERSION,
        port: config.port,
        monitorPort: config.monitorPort,
        controlEnabled: Boolean(process.env.WORKBRIDGE_MONITOR_CONTROL_TOKEN?.trim()),
        stateDir: config.stateDir,
        mcpConnectionMode: config.mcpConnectionMode,
        buildIdentity,
        configProvenance: runtimeConfigProvenance,
        startupConfig: {
          publicBaseUrl: config.publicBaseUrl,
          allowedRoots: [...config.allowedRoots],
          auxiliaryRoots: [...config.auxiliaryRoots],
          worktreeRoot: config.worktreeRoot,
          stateDir: config.stateDir,
          trustProxy: config.logging.trustProxy,
        },
        memory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
        },
      },
      mcpSessions: sessionLifecycle.snapshot(8),
      modernMcpRequests: modernMcpMetrics.snapshot(8),
      nodeSaturation: nodeSaturation.snapshot(),
      ...(pauseState ? { softPause: pauseState } : {}),
    };
  };
  const sessionMonitorRoutes = registerSessionMonitorRoutes(
    monitorApp,
    sessionMonitor,
    undefined,
    runtimeStatus,
  );

  app.all("/mcp", async (req, res) => {
    const requestStartedAt = performance.now();
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    const requestMethods = mcpRequestMethods(req.method, req.body);
    const modernProbe = detectModernMcpProbe({ headers: req.headers, body: req.body });

    if (modernProbe) {
      logEvent(config.logging, "info", "mcp_modern_probe_detected", {
        requestId,
        protocolEra: "modern",
        ...modernProbe,
      });
    }

    let authMs = 0;
    if (bearerAuth) {
      const authStartedAt = performance.now();
      await new Promise<void>((resolve, reject) => {
        bearerAuth(req, res, (error?: unknown) => {
          if (error) reject(error);
          else resolve();
        });
      });
      authMs = performance.now() - authStartedAt;
      if (res.headersSent) return;

      if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
        logEvent(config.logging, "warn", "auth_denied", {
          requestId,
          method: req.method,
          path: requestPath(req),
          reason: "invalid_oauth_resource",
          ...requestLogFields(req, config),
        });
        sendJsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      requestMethods,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      const classifyStartedAt = performance.now();
      const webRequest = await toWebRequest(req, req.body);
      const legacyRequest = await isLegacyRequest(webRequest, req.body);
      const classifyMs = performance.now() - classifyStartedAt;
      if (!legacyRequest) {
        const modernRequest = modernMcpMetrics.begin({
          requestId,
          method: modernProbe?.rpcMethod ?? requestMethods[0]?.slice(0, 160) ?? req.method,
          tool: modernProbe?.mcpNameHeader,
          clientName: modernProbe?.clientName,
          clientVersion: modernProbe?.clientVersion,
          protocolVersion: modernProbe?.protocolVersion,
        });
        modernMcpMetrics.recordTimings(modernRequest, { authMs, classifyMs });
        const handlerStartedAt = performance.now();
        modernMcpMetrics.beginHandler(modernRequest);
        try {
          await modernMcpRequestContext.run(
            modernRequest,
            () => modernNodeHandler(req, res, req.body),
          );
          modernMcpMetrics.recordTimings(modernRequest, {
            handlerMs: performance.now() - handlerStartedAt,
            totalMs: performance.now() - requestStartedAt,
          });
          modernMcpMetrics.finish(modernRequest, res.statusCode < 400);
        } catch (error) {
          modernMcpMetrics.recordTimings(modernRequest, {
            handlerMs: performance.now() - handlerStartedAt,
            totalMs: performance.now() - requestStartedAt,
          });
          modernMcpMetrics.finish(modernRequest, false);
          throw error;
        } finally {
          modernMcpMetrics.endHandler(modernRequest);
        }
        return;
      }

      let transport: Transport | undefined;

      if (sessionId) {
        transport = sessionLifecycle.beginRequest(sessionId, requestMethods);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
        sessionLifecycle.trackRequestUntilResponseEnd(sessionId, res);
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            const metadata = mcpInitializeMetadata(req);
            if (transport) {
              sessionLifecycle.register(newSessionId, transport, metadata, {
                requestActive: true,
                oneShotCleanupEligible: isOpenAiMcpClient(metadata),
              });
              sessionLifecycle.trackRequestUntilResponseEnd(newSessionId, res);
            }
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              activeSessionCount: sessionLifecycle.size,
              clientName: metadata.clientName,
              clientVersion: metadata.clientVersion,
              protocolVersion: metadata.protocolVersion,
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) sessionLifecycle.remove(closedSessionId, "transport_close");
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          resolveLocalAgentProviders,
          incomingArtifactAdapters,
          softPause,
          { monitor: sessionMonitor, sessionId: () => transport?.sessionId },
          semanticManager,
          codebaseMemoryManager,
        );
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

  let closePromise: Promise<void> | undefined;
  return {
    app,
    monitorApp,
    config,
    localAgentProviders,
    runtimeStatus,
    close: () => {
      closePromise ??= (async () => {
        await runCleanupSteps([
          () => sessionMonitorRoutes.close(),
          () => nodeSaturation.close(),
          () => modernMcpHandler.close(),
          () => sessionLifecycle.close(),
          () => semanticManager.close(),
          () => codebaseMemoryManager.close(),
          () => processSessions.shutdown(),
          () => oauthProvider?.close(),
          () => workspaceStore.close?.(),
        ]);
      })();
      return closePromise;
    },
  };
}

function mcpRequestMethods(httpMethod: string, body: unknown): string[] {
  if (httpMethod !== "POST") return [`http/${httpMethod.toLowerCase()}`];
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const method = (message as { method?: unknown }).method;
    return typeof method === "string" && method ? [method] : [];
  });
}

function mcpInitializeMetadata(req: Request): {
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  userAgent?: string;
} {
  const body = req.body;
  const message = Array.isArray(body) ? body.find((entry) => isInitializeRequest(entry)) : body;
  if (!message || typeof message !== "object") return {};
  const params = (message as { params?: unknown }).params;
  const paramsRecord = params && typeof params === "object" ? params as Record<string, unknown> : {};
  const clientInfo = paramsRecord.clientInfo && typeof paramsRecord.clientInfo === "object"
    ? paramsRecord.clientInfo as Record<string, unknown>
    : {};
  return {
    clientName: typeof clientInfo.name === "string" ? clientInfo.name : undefined,
    clientVersion: typeof clientInfo.version === "string" ? clientInfo.version : undefined,
    protocolVersion: typeof paramsRecord.protocolVersion === "string" ? paramsRecord.protocolVersion : undefined,
    userAgent: req.header("user-agent"),
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`auth: ${config.oauth ? "oauth owner-token flow required" : "delegated to secure tunnel"}`);
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
