import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { MonitorLogStream } from "./monitor-log-stream.js";
import {
  createSessionMonitorToolRegistrar,
  registerSessionMonitorRoutes,
  type AppToolRegistrar,
} from "./session-monitor-integration.js";
import { SessionMonitor } from "./session-monitor.js";
import type { WorkspaceRegistry } from "./workspaces.js";

await testToolRegistrationTracksWorkspaceAndOutcome();
await testMonitorRoutesRemainLocalOnly();

console.log("session monitor integration tests passed");

async function testToolRegistrationTracksWorkspaceAndOutcome(): Promise<void> {
  const workbridgeWorkspaceId = "ws_1234567890-aaaa-bbbb-cccc-1234567890ab";
  const arcaiaWorkspaceId = "ws_abcdefghij-aaaa-bbbb-cccc-1234567890ab";
  const monitor = new SessionMonitor();
  let capturedHandler: ((input: unknown) => Promise<unknown>) | undefined;
  const baseRegisterTool = ((_server: unknown, _name: unknown, _definition: unknown, handler: unknown) => {
    capturedHandler = handler as (input: unknown) => Promise<unknown>;
    return undefined;
  }) as unknown as AppToolRegistrar;
  const workspaces = {
    getWorkspace: (workspaceId: string) => {
      if (workspaceId === workbridgeWorkspaceId) {
        return { root: "C:\\projects\\workbridge" };
      }
      if (workspaceId === arcaiaWorkspaceId) {
        return { root: "C:\\projects\\arcaia" };
      }
      throw new Error(`Unknown workspace: ${workspaceId}`);
    },
    getWorkspaceStartedAt: (workspaceId: string) => workspaceId === workbridgeWorkspaceId ? 1_000 : 2_000,
  } as unknown as WorkspaceRegistry;
  const registerTool = createSessionMonitorToolRegistrar(
    baseRegisterTool,
    { monitor, sessionId: () => "session-1" },
    workspaces,
  );

  registerTool(
    {} as never,
    "read",
    {} as never,
    async () => ({ structuredContent: { result: "ok" } }) as never,
  );
  assert.ok(capturedHandler);
  await capturedHandler({ workspaceId: workbridgeWorkspaceId, path: "src/server.ts" });

  const snapshot = monitor.snapshot();
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0]?.workspaceId, workbridgeWorkspaceId);
  assert.equal(snapshot.sessions[0]?.workspaceLabel, "workbridge");
  assert.equal(snapshot.sessions[0]?.totalCalls, 1);
  assert.equal(snapshot.sessions[0]?.nodes[0]?.tool, "read");
  assert.equal(snapshot.sessions[0]?.nodes[0]?.target, "src/server.ts");
  assert.equal(snapshot.sessions[0]?.nodes[0]?.state, "success");

  registerTool(
    {} as never,
    "open_workspace",
    {} as never,
    async () => ({ structuredContent: { workspaceId: arcaiaWorkspaceId } }) as never,
  );
  assert.ok(capturedHandler);
  await capturedHandler({ path: "C:\\projects\\arcaia" });

  const promotedSnapshot = monitor.snapshot();
  const arcaiaSession = promotedSnapshot.sessions.find(
    (session) => session.workspaceId === arcaiaWorkspaceId,
  );
  assert.equal(arcaiaSession?.workspaceLabel, "arcaia");
  assert.equal(arcaiaSession?.totalCalls, 1);
  assert.equal(arcaiaSession?.nodes[0]?.tool, "open_workspace");
  assert.equal(arcaiaSession?.nodes[0]?.state, "success");

  registerTool(
    {} as never,
    "open_workspace",
    {} as never,
    async () => {
      throw new Error("expected failure");
    },
  );
  assert.ok(capturedHandler);
  await assert.rejects(
    capturedHandler({ path: "C:\\projects\\broken" }),
    /expected failure/,
  );

  const failedSnapshot = monitor.snapshot();
  const failedSession = failedSnapshot.sessions.find(
    (session) => session.workspaceLabel === "broken",
  );
  assert.equal(failedSession?.totalCalls, 1);
  assert.equal(failedSession?.nodes[0]?.tool, "open_workspace");
  assert.equal(failedSession?.nodes[0]?.state, "error");
  assert.equal(failedSession?.state, "error");
}

async function testMonitorRoutesRemainLocalOnly(): Promise<void> {
  const monitor = new SessionMonitor();
  const logs = new MonitorLogStream(10);
  const reference = monitor.beginTool({
    transportSessionId: "session-2",
    tool: "read",
    input: { path: "README.md" },
  });
  monitor.completeTool(reference, { structuredContent: {} });
  const app = express();
  const monitorRoutes = registerSessionMonitorRoutes(app, monitor, logs);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const htmlResponse = await fetch(`${baseUrl}/monitor`);
    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(htmlResponse.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    const html = await htmlResponse.text();
    assert.match(html, /Workbridge Session Monitor/);
    assert.match(html, /v1\.3\.1/);
    assert.match(html, /workbridge-monitor-icon\.png/);
    assert.match(html, /Polling/);
    assert.match(html, /data-session-key/);
    assert.doesNotMatch(html, /1行 = 1 workspace session/);
    assert.doesNotMatch(html, /translateY\(-1px\)/);

    const iconResponse = await fetch(
      `${baseUrl}/monitor/assets/workbridge-monitor-icon.png`,
    );
    assert.equal(iconResponse.status, 200);
    assert.equal(iconResponse.headers.get("content-type"), "image/png");
    assert.ok((await iconResponse.arrayBuffer()).byteLength > 1_000);

    const snapshotResponse = await fetch(`${baseUrl}/monitor/api/snapshot`);
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json() as { sessions: Array<{ sessionIdPrefix: string }> };
    assert.equal(snapshot.sessions[0]?.sessionIdPrefix, "session-");

    const published = logs.publish({
      ts: "2026-07-25T00:00:00.000Z",
      level: "info",
      event: "tool_call",
      kind: "read",
      error: false,
      line: "read README.md",
      workspaceId: "ws_test",
      tool: "read",
      details: { path: "README.md" },
    });
    const logsResponse = await fetch(`${baseUrl}/monitor/api/logs`);
    assert.equal(logsResponse.status, 200);
    const logSnapshot = await logsResponse.json() as {
      latestSequence: number;
      logs: Array<{ sequence: number; line: string }>;
    };
    assert.equal(logSnapshot.latestSequence, published.sequence);
    assert.equal(logSnapshot.logs[0]?.line, "read README.md");

    const abortController = new AbortController();
    const streamResponse = await fetch(`${baseUrl}/monitor/api/logs/stream?after=0`, {
      signal: abortController.signal,
    });
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") ?? "", /^text\/event-stream/);
    const streamText = await readSseEvent(streamResponse);
    assert.match(streamText, new RegExp(`id: ${published.sequence}`));
    assert.match(streamText, /event: log/);
    assert.match(streamText, /read README\.md/);
    abortController.abort();

    const forwardedResponse = await fetch(`${baseUrl}/monitor`, {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    assert.equal(forwardedResponse.status, 404);
    const forwardedLogsResponse = await fetch(`${baseUrl}/monitor/api/logs`, {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    assert.equal(forwardedLogsResponse.status, 404);
    const forwardedIconResponse = await fetch(
      `${baseUrl}/monitor/assets/workbridge-monitor-icon.png`,
      { headers: { "x-forwarded-for": "198.51.100.10" } },
    );
    assert.equal(forwardedIconResponse.status, 404);

    const shutdownStreamResponse = await fetch(
      `${baseUrl}/monitor/api/logs/stream?after=${published.sequence}`,
    );
    const shutdownReader = shutdownStreamResponse.body?.getReader();
    assert.ok(shutdownReader);
    monitorRoutes.close();
    const shutdownText = await readStreamUntilDone(shutdownReader);
    assert.match(shutdownText, /event: close/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function readStreamUntilDone(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (let index = 0; index < 8; index += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

async function readSseEvent(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let text = "";
  for (let index = 0; index < 8 && !text.includes("event: log"); index += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  return text;
}
