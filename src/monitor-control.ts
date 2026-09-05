import { timingSafeEqual } from "node:crypto";
import type { Express, Request } from "express";
import { isLocalMonitorRequest } from "./session-monitor-integration.js";

export interface MonitorControlOptions {
  token?: string;
  shutdown(): Promise<void> | void;
}

export function registerMonitorControlRoutes(
  app: Express,
  options: MonitorControlOptions,
): void {
  const token = options.token?.trim();
  if (!token) return;

  app.post("/monitor/api/control/shutdown", (req, res) => {
    if (!isLocalMonitorRequest(req)) {
      res.status(404).end();
      return;
    }
    if (!authorizationMatches(req, token)) {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return;
    }

    res.status(202).json({ ok: true, state: "stopping" });
    setImmediate(() => {
      void Promise.resolve(options.shutdown()).catch(() => undefined);
    });
  });
}

function authorizationMatches(req: Request, expectedToken: string): boolean {
  const authorization = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return false;
  const actual = Buffer.from(match[1] ?? "", "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
