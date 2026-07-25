import { randomUUID } from "node:crypto";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { Express, Request, Response } from "express";
import {
  SessionMonitor,
  workspaceDisplayInfo,
  type SessionMonitorWorkspaceIdentity,
  type SessionMonitorToolReference,
} from "./session-monitor.js";
import { sessionMonitorHtml } from "./session-monitor-ui.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export type AppToolRegistrar = typeof registerAppTool;

export interface SessionMonitorContext {
  monitor: SessionMonitor;
  sessionId(): string | undefined;
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

export function registerSessionMonitorRoutes(app: Express, monitor: SessionMonitor): void {
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
  app.get("/monitor/api/snapshot", (req, res) => {
    if (!isLocalMonitorRequest(req)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(monitor.snapshot());
  });
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

function isLocalMonitorRequest(req: Request): boolean {
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
