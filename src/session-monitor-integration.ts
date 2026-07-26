import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { Express, Request, Response } from "express";
import {
  monitorLogStream,
  type MonitorLogEntry,
  type MonitorLogStream,
} from "./monitor-log-stream.js";
import {
  SessionMonitor,
  workspaceDisplayInfo,
  type SessionMonitorSort,
  type SessionMonitorWorkspaceIdentity,
  type SessionMonitorToolReference,
} from "./session-monitor.js";
import { sessionMonitorHtml } from "./session-monitor-ui.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { McpSessionSnapshot } from "./mcp-sessions.js";
import type { SoftPauseState } from "./soft-pause.js";

const MONITOR_ICON_PATH = fileURLToPath(
  new URL("../assets/workbridge-monitor-icon.png", import.meta.url),
);
const MONITOR_ICON_BYTES = readFileSync(MONITOR_ICON_PATH);

export type AppToolRegistrar = typeof registerAppTool;

export interface SessionMonitorContext {
  monitor: SessionMonitor;
  sessionId(): string | undefined;
}

export interface SessionMonitorRouteController {
  close(): void;
}

export interface SessionMonitorRuntimeStatus {
  server: {
    status: "running";
    pid: number;
    startedAt: string;
    uptimeMs: number;
    version: string;
    port: number;
    controlEnabled: boolean;
    memory: {
      rssBytes: number;
      heapUsedBytes: number;
    };
  };
  mcpSessions: McpSessionSnapshot;
  softPause?: SoftPauseState;
}

export function createSessionMonitorToolRegistrar(
  baseRegisterTool: AppToolRegistrar,
  context: SessionMonitorContext,
  workspaces: WorkspaceRegistry,
): AppToolRegistrar {
  return ((server, name, definition, handler) => {
    const monitoredHandler = (async (...args: unknown[]) => {
      const input = objectValue(args[0]);
      const workspaceId = stringValue(input?.workspaceId);
      const workspaceIdentity = workspaceId
        ? workspaceIdentityForId(workspaces, workspaceId)
        : undefined;
      const pendingWorkspace = name === "open_workspace"
        ? workspaceDisplayInfo(input?.path)
        : undefined;
      const reference: SessionMonitorToolReference = context.monitor.beginTool({
        transportSessionId: context.sessionId() ?? `unbound-${randomUUID()}`,
        tool: name,
        input,
        workspaceId,
        workspaceStartedAt: workspaceIdentity?.startedAt,
        workspaceLabel: workspaceIdentity?.workspaceLabel ?? pendingWorkspace?.label,
        workspaceDetail: workspaceIdentity?.workspaceDetail ?? pendingWorkspace?.detail,
        workspacePath: workspaceIdentity?.workspacePath ?? pendingWorkspace?.path,
      });

      try {
        const result = await (handler as (...handlerArgs: unknown[]) => Promise<unknown> | unknown)(...args);
        const resultWorkspaceId = resultWorkspaceIdFromToolResult(result);
        context.monitor.completeTool(
          reference,
          result,
          resultWorkspaceId
            ? workspaceIdentityForId(workspaces, resultWorkspaceId)
            : undefined,
        );
        return result;
      } catch (error) {
        context.monitor.failTool(reference);
        throw error;
      }
    }) as typeof handler;
    return baseRegisterTool(server, name, definition, monitoredHandler);
  }) as AppToolRegistrar;
}

export function registerSessionMonitorRoutes(
  app: Express,
  monitor: SessionMonitor,
  logs: MonitorLogStream = monitorLogStream,
  runtimeStatus?: () => SessionMonitorRuntimeStatus,
): SessionMonitorRouteController {
  const streamResponses = new Set<Response>();
  const sendMonitorHtml = (req: Request, res: Response) => {
    if (!isLocalMonitorRequest(req)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    );
    res.send(sessionMonitorHtml());
  };

  app.get("/monitor", sendMonitorHtml);
  app.get("/monitor/", sendMonitorHtml);
  app.get("/monitor/assets/workbridge-monitor-icon.png", (req, res) => {
    if (!isLocalMonitorRequest(req)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(MONITOR_ICON_BYTES);
  });
  app.get("/monitor/api/snapshot", (req, res) => {
    if (!isLocalMonitorRequest(req)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(monitor.snapshot(20, 20, sessionSort(req)));
  });
  app.get("/monitor/api/status", (req, res) => {
    if (!isLocalMonitorRequest(req)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    if (!runtimeStatus) {
      res.status(503).json({ ok: false, error: "Runtime status unavailable" });
      return;
    }
    res.json({ version: 1, generatedAt: new Date().toISOString(), ...runtimeStatus() });
  });
  app.get("/monitor/api/logs", (req, res) => {
    if (!isLocalMonitorRequest(req)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(logs.snapshot(queryInteger(req, "after"), queryInteger(req, "limit") ?? 300));
  });
  app.get("/monitor/api/logs/stream", (req, res) => {
    if (!isLocalMonitorRequest(req)) {
      res.status(404).end();
      return;
    }
    const after = Math.max(
      queryInteger(req, "after") ?? 0,
      positiveInteger(req.header("last-event-id")) ?? 0,
    );
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write("retry: 1500\n\n");
    streamResponses.add(res);
    for (const entry of logs.snapshot(after).logs) writeSseLog(res, entry);
    const unsubscribe = logs.subscribe((entry) => writeSseLog(res, entry));
    const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    keepAlive.unref();
    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
      streamResponses.delete(res);
    };
    req.once("close", cleanup);
    res.once("finish", cleanup);
  });
  return {
    close: () => {
      for (const response of streamResponses) {
        if (!response.writableEnded && !response.destroyed) {
          response.write("event: close\ndata: {}\n\n");
          response.end();
        }
      }
      streamResponses.clear();
    },
  };
}

function writeSseLog(res: Response, entry: MonitorLogEntry): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`id: ${entry.sequence}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`);
}

function queryInteger(req: Request, name: string): number | undefined {
  const value = req.query[name];
  return positiveInteger(Array.isArray(value) ? value[0] : value);
}

function sessionSort(req: Request): SessionMonitorSort {
  return req.query.sort === "lastActivityAt" ? "lastActivityAt" : "startedAt";
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function workspaceIdentityForId(
  workspaces: WorkspaceRegistry,
  workspaceId: string | undefined,
): SessionMonitorWorkspaceIdentity | undefined {
  if (!workspaceId) return undefined;
  try {
    const workspace = workspaces.getWorkspace(workspaceId);
    const display = workspaceDisplayInfo(workspace.root, workspace.sourceRoot);
    return {
      workspaceId,
      workspaceLabel: display.label,
      workspaceDetail: display.detail,
      workspacePath: display.path,
      startedAt: workspaces.getWorkspaceStartedAt(workspaceId),
    };
  } catch {
    return undefined;
  }
}

function resultWorkspaceIdFromToolResult(result: unknown): string | undefined {
  const structuredContent = objectValue(objectValue(result)?.structuredContent);
  return stringValue(structuredContent?.workspaceId);
}

export function isLocalMonitorRequest(req: Request): boolean {
  const forwarded = req.header("cf-connecting-ip")
    ?? req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded && !isLoopbackAddress(forwarded)) return false;
  return isLoopbackAddress(req.socket.remoteAddress) || isLoopbackAddress(req.ip);
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
  return normalized === "::1" || normalized === "localhost" || normalized.startsWith("127.");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
