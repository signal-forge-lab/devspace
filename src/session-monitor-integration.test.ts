import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Script } from "node:vm";
import express, { type Request } from "express";
import { MonitorLogStream } from "./monitor-log-stream.js";
import { captureMonitorToolLog } from "./monitor-operation-context.js";
import {
  createSessionMonitorToolRegistrar,
  isLocalMonitorRequest,
  registerSessionMonitorRoutes,
  type AppToolRegistrar,
} from "./session-monitor-integration.js";
import { SessionMonitor } from "./session-monitor.js";
import { PACKAGE_VERSION } from "./version.js";
import type { WorkspaceRegistry } from "./workspaces.js";

await testToolRegistrationTracksWorkspaceAndOutcome();
testLocalMonitorRequestUsesTheDirectSocketOnly();
await testMonitorRoutesRemainLocalOnly();

console.log("session monitor integration tests passed");

function testLocalMonitorRequestUsesTheDirectSocketOnly(): void {
  assert.equal(isLocalMonitorRequest(fakeRequest("127.0.0.1")), true);
  assert.equal(isLocalMonitorRequest(fakeRequest("::1")), true);
  assert.equal(isLocalMonitorRequest(fakeRequest("198.51.100.10", "127.0.0.1")), false);
  assert.equal(isLocalMonitorRequest(fakeRequest("127.0.0.1", "127.0.0.1", {
    "x-forwarded-for": "127.0.0.1",
  })), false);
  assert.equal(isLocalMonitorRequest(fakeRequest("127.0.0.1", "127.0.0.1", {
    "cf-connecting-ip": "127.0.0.1",
  })), false);
}

function fakeRequest(
  remoteAddress: string,
  ip = remoteAddress,
  headers: Record<string, string> = {},
): Request {
  return {
    socket: { remoteAddress },
    ip,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

async function testToolRegistrationTracksWorkspaceAndOutcome(): Promise<void> {
  const workbridgeWorkspaceId = "ws_1234567890-aaaa-bbbb-cccc-1234567890ab";
  const arcaiaWorkspaceId = "ws_abcdefghij";
  const monitor = new SessionMonitor();
  let capturedHandler: ((input: unknown) => Promise<unknown>) | undefined;
  const baseRegisterTool = ((_server: unknown, _name: unknown, _definition: unknown, handler: unknown) => {
    capturedHandler = handler as (input: unknown) => Promise<unknown>;
    return undefined;
  }) as unknown as AppToolRegistrar;
  const workspaces = {
    getWorkspace: (workspaceId: string) => {
      if (workspaceId === workbridgeWorkspaceId) {
        return { root: "C:\\projects\\workbridge", mode: "checkout", skills: [], agentProfiles: [] };
      }
      if (workspaceId === arcaiaWorkspaceId) {
        return {
          root: "C:\\worktrees\\arcaia-next",
          sourceRoot: "C:\\projects\\arcaia",
          mode: "worktree",
          worktree: {
            path: "C:\\worktrees\\arcaia-next",
            baseRef: "main",
            baseSha: "1234567890abcdef",
            dirtySource: true,
            detached: true,
            managed: true,
          },
          skills: [
            { name: "ponytail", disableModelInvocation: false },
            { name: "manual-release", disableModelInvocation: true },
          ],
          agentProfiles: [{ name: "reviewer", provider: "codex", model: "gpt-5.6-sol" }],
        };
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
  assert.equal(snapshot.version, 5);
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0]?.workspaceId, workbridgeWorkspaceId);
  assert.equal(snapshot.sessions[0]?.workspaceLabel, "workbridge");
  assert.equal(snapshot.sessions[0]?.totalCalls, 1);
  assert.equal(snapshot.sessions[0]?.nodes[0]?.tool, "read");
  assert.equal(snapshot.sessions[0]?.nodes[0]?.target, "src/server.ts");
  assert.equal(snapshot.sessions[0]?.nodes[0]?.state, "success");

  registerTool(
    {} as never,
    "exec_command",
    {} as never,
    async () => {
      captureMonitorToolLog({
        tool: "exec_command",
        workspaceId: workbridgeWorkspaceId,
        command: "API_KEY=hidden npm test",
        workingDirectory: ".",
        shell: "cmd.exe",
        running: false,
        exitCode: 0,
      });
      return { structuredContent: { running: false, exitCode: 0 } } as never;
    },
  );
  assert.ok(capturedHandler);
  await capturedHandler({ workspaceId: workbridgeWorkspaceId, cmd: "npm test" });
  const inspectedNode = monitor.snapshot().sessions[0]?.nodes.at(-1);
  assert.ok(inspectedNode?.operationId);
  const inspectedOperation = monitor.operation(inspectedNode.operationId);
  assert.equal(inspectedOperation?.details.shell, "cmd.exe");
  assert.equal(inspectedOperation?.details.commandDisplay, "API_KEY=[REDACTED] npm test");

  registerTool(
    {} as never,
    "open_workspace",
    {} as never,
    async () => ({
      structuredContent: {
        workspaceId: arcaiaWorkspaceId,
        agentsFiles: [{ path: "AGENTS.md", content: "instructions" }],
        availableAgentsFiles: [{ path: "nested/AGENTS.md" }],
        skills: [{ name: "ponytail" }, { name: "debugging-and-error-recovery" }],
        agents: [{ name: "reviewer", provider: "codex", model: "gpt-5.6-sol" }],
      },
    }) as never,
  );
  assert.ok(capturedHandler);
  await capturedHandler({ path: "C:\\projects\\arcaia" });

  const promotedSnapshot = monitor.snapshot();
  const arcaiaSession = promotedSnapshot.sessions.find(
    (session) => session.workspaceId === arcaiaWorkspaceId,
  );
  assert.equal(arcaiaSession?.workspaceLabel, "arcaia");
  assert.equal(arcaiaSession?.workspaceDetail, "worktree: arcaia-next");
  assert.deepEqual(arcaiaSession?.workspaceContext, {
    mode: "worktree",
    base: "main · 12345678 · source dirty",
    sourceRoot: "C:\\projects\\arcaia",
    loadedInstructions: ["AGENTS.md"],
    availableInstructions: ["nested/AGENTS.md"],
    skills: ["ponytail", "manual-release"],
    explicitOnlySkills: ["manual-release"],
    agents: ["reviewer · codex · gpt-5.6-sol"],
  });
  assert.equal(arcaiaSession?.totalCalls, 1);
  assert.equal(arcaiaSession?.nodes[0]?.tool, "open_workspace");
  assert.equal(arcaiaSession?.nodes[0]?.state, "success");

  registerTool(
    {} as never,
    "read",
    {} as never,
    async () => ({ structuredContent: { result: "ok" } }) as never,
  );
  assert.ok(capturedHandler);
  await capturedHandler({ workspaceId: arcaiaWorkspaceId, path: "src/index.ts" });
  assert.deepEqual(
    monitor.snapshot().sessions.find((session) => session.workspaceId === arcaiaWorkspaceId)?.workspaceContext?.loadedInstructions,
    ["AGENTS.md"],
  );

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
    operationId: "op-route",
    transportSessionId: "session-2",
    tool: "read",
    input: { path: "README.md" },
  });
  monitor.completeTool(reference, { structuredContent: {} });
  const app = express();
  const monitorRoutes = registerSessionMonitorRoutes(app, monitor, logs, () => ({
    server: {
      status: "running",
      pid: 1234,
      startedAt: "2026-07-26T00:00:00.000Z",
      uptimeMs: 12_345,
      version: "1.4.0",
      port: 7676,
      monitorPort: 7677,
      controlEnabled: true,
      stateDir: "C:\\workbridge-state",
      mcpConnectionMode: "openai-secure-mcp-tunnel",
      buildIdentity: {
        sourceRoot: "C:\\workbridge-source",
        branch: "feature/runtime-identity",
        commit: "0123456789abcdef",
        dirty: false,
      },
      configProvenance: {
        publicBaseUrl: "environment",
        allowedRoots: "environment",
        auxiliaryRoots: "config.jsonc",
        worktreeRoot: "derived",
        stateDir: "config.jsonc",
        trustProxy: "environment",
        oauthOwnerToken: "auth.json",
        oauthClientRegistrationKey: "derived",
      },
      startupConfig: {
        publicBaseUrl: "https://workbridge.example.test",
        allowedRoots: ["C:\\workspace"],
        auxiliaryRoots: ["C:\\Users\\test\\.codex", "C:\\Users\\test\\.agents"],
        worktreeRoot: "C:\\workspace\\.workbridge\\worktrees",
        stateDir: "C:\\workbridge-state",
        trustProxy: true,
      },
      memory: {
        rssBytes: 285.2 * 1024 * 1024,
        heapUsedBytes: 163.2 * 1024 * 1024,
      },
    },
    mcpSessions: {
      stats: {
        active: 2,
        activeRequests: 1,
        initializedOnly: 0,
        handshakeOnly: 0,
        discoveryOnly: 0,
        operational: 2,
        toolCallSessions: 2,
        oneShotCleanupCandidates: 1,
        reusedToolCallSessions: 0,
        maxToolCallsPerSession: 1,
        totalCreated: 4,
        totalClosed: 2,
        totalSubsequentRequests: 4,
        oldestAgeMs: 20_000,
        longestIdleMs: 500,
        requestMethods: { "tools/call": 2 },
        clientNames: { "openai-mcp": 2 },
        protocolVersions: { "2025-06-18": 2 },
      },
      recent: [{
        sessionIdPrefix: "mcp-123456",
        clientName: "openai-mcp",
        state: "active",
        ageMs: 2_000,
        idleMs: 25,
        activeRequests: 1,
        toolCalls: 1,
        subsequentRequests: 1,
      }],
    },
    modernMcpRequests: {
      stats: {
        requests: 5,
        requestsTotal: 5,
        active: 1,
        activeRequests: 1,
        peakActiveRequests: 3,
        activeRegistrations: 0,
        peakActiveRegistrations: 1,
        activeHandlers: 0,
        peakActiveHandlers: 1,
        requestsCompleted: 4,
        toolsList: 2,
        toolsCall: 2,
        success: 3,
        error: 1,
      },
      recent: [{
        requestId: "modern-request",
        method: "tools/call",
        tool: "open_workspace",
        clientName: "openai-mcp",
        clientVersion: "2.0.0",
        protocolVersion: "2026-07-28",
        status: "running",
        startedAt: "2026-07-26T00:00:02.000Z",
        durationMs: 50,
        concurrencyAtStart: 1,
        peakConcurrencyDuringRequest: 1,
        overlapped: false,
      }],
      phaseTimings: {
        authMs: { count: 0 },
        classifyMs: { count: 0 },
        registrationMs: { count: 0 },
        handlerMs: { count: 0 },
        totalMs: { count: 0 },
      },
    },
    nodeSaturation: {
      eventLoopUtilization: 0.25,
      eventLoopDelayP50Ms: 1,
      eventLoopDelayP95Ms: 2,
      eventLoopDelayP99Ms: 3,
      sampleWindowMs: 1_000,
      sampledAt: "2026-07-26T00:00:02.000Z",
    },
    softPause: {
      version: 1,
      requestedAt: "2026-07-26T00:00:01.000Z",
      reason: "test pause",
    },
  }));
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
    assert.ok(html.includes(`v${PACKAGE_VERSION}`));
    const scriptStart = html.indexOf("<script>");
    const scriptEnd = html.lastIndexOf("</script>");
    assert.ok(scriptStart >= 0 && scriptEnd > scriptStart);
    assert.doesNotThrow(() => new Script(
      html.slice(scriptStart + "<script>".length, scriptEnd),
      { filename: "session-monitor-inline.js" },
    ));
    assert.match(html, /workbridge-monitor-icon\.png/);
    assert.match(html, /Polling/);
    assert.match(html, /data-session-key/);
    assert.match(html, /ResizeObserver/);
    assert.match(html, /scrollWidth-nextWidth-rightGap/);
    assert.match(html, /workbridge-monitor-session-sort/);
    assert.match(html, /最終活動時刻順/);
    assert.match(html, /snapshot\?sort=/);
    assert.match(html, /SESSION_POLL_ACTIVE_MS=500/);
    assert.match(html, /SESSION_POLL_IDLE_MS=2000/);
    assert.match(html, /SESSION_POLL_HIDDEN_MS=5000/);
    assert.match(html, /data-live-started-at/);
    assert.match(html, /data-operation-id/);
    assert.match(html, /id="node-inspector"/);
    assert.match(html, /Copy Command/);
    assert.match(html, /Copy Details/);
    assert.match(html, /Show in Activity Log/);
    assert.match(html, /\/monitor\/api\/operations\//);
    assert.match(html, /id="log-search"/);
    assert.match(html, /function showOperationLog/);
    assert.match(html, /currentSearch/);
    assert.doesNotMatch(
      html,
      /active=true;nodeViewportDragging=true;moved=false;startX=.*setPointerCapture\(event\.pointerId\)/,
    );
    assert.match(
      html,
      /if\(Math\.abs\(delta\)>3&&!moved\)\{moved=true;nodeViewportDragging=true;viewport\.classList\.add\('dragging'\);viewport\.setPointerCapture\(event\.pointerId\)\}/,
    );
    assert.match(html, /\.session-times\{[^}]*grid-template-columns:max-content minmax\(0,1fr\)/);
    assert.match(html, /\.session-time-value\{[^}]*font-variant-numeric:tabular-nums/);
    assert.match(html, />Started<\/span><span class="session-time-value">/);
    assert.match(html, />Last active<\/span><span class="session-time-value">/);
    assert.match(html, /sessionClock\(s\.lastActivityAt\)/);
    assert.match(html, /s\.workspaceId\|\|s\.displayId/);
    assert.match(html, /operation\.displayId/);
    assert.match(html, /\.node-status\{position:absolute;top:7px;right:22px;margin:0/);
    assert.doesNotMatch(html, /\.node-status\{margin-top:4px/);
    assert.match(html, /node-status polling">Polling/);
    assert.match(html, /lastSessionRevision/);
    assert.match(html, /scheduleSessionRefresh/);
    assert.match(html, /document\.hidden/);
    assert.doesNotMatch(html, /setInterval\(refresh,500\)/);
    assert.match(html, /startup-field input:not\(\[type="checkbox"\]\)/);
    assert.match(html, /startup-toggle input\{width:auto;flex:0 0 auto;margin:0/);
    assert.match(html, /\.monitor-pane\{[^}]*overflow:hidden;display:flex/);
    assert.match(html, /\.board\{[^}]*overflow:auto/);
    assert.match(html, /\.console-pane\{[^}]*flex:0 0 var\(--console-height\)/);
    assert.doesNotMatch(html, /\.console-pane\{[^}]*max-height:72vh/);
    assert.match(html, /monitorHeight-180/);
    assert.match(html, /dragMaximumHeight=maximumConsoleHeight\(\)/);
    assert.match(html, /\.columns\{position:sticky;top:0;z-index:8/);
    assert.doesNotMatch(html, /monitor-pane\{[^}]*box-shadow:inset 0 1px 0/);
    assert.match(html, /Legacy MCP sessions/);
    assert.match(html, /Modern MCP requests/);
    assert.match(html, /Modern peak/);
    assert.match(html, /Handlers active \/ peak/);
    assert.match(html, /Registrations active \/ peak/);
    assert.match(html, /eventLoopUtilization/);
    assert.match(html, /Loop p95/);
    assert.match(html, /modernStats\.peakActiveRequests\?\?modernStats\.peakActive\?\?0/);
    assert.match(html, /concurrencyAtStart/);
    assert.match(html, /peakConcurrencyDuringRequest/);
    assert.match(html, /modernMcpRequests/);
    assert.match(html, /1回実行・整理候補/);
    assert.match(html, /JavaScriptヒープ/);
    assert.match(html, /DESKTOP MONITOR/);
    assert.match(html, /Peak \(since monitor start\)/);
    assert.match(html, /PROCESS BREAKDOWN/);
    assert.match(html, /SYSTEM RAM/);
    assert.match(html, /desktopMemory/);
    assert.match(html, /memory-history/);
    assert.match(html, /History: On/);
    assert.match(html, /memoryLog/);
    assert.match(html, /workbridgeMonitorHost/);
    assert.match(html, /monitorHost\?\.kind==='tauri'.*desktopApi\.getStatus\(runtimeStatus\)/);
    assert.match(html, /reportedState===.starting.&&!Number\.isInteger\(supervisor\?\.managedPid\)/);
    assert.match(html, /Renderer \(Tab\)/);
    assert.match(html, /oneShotCleanupCandidates/);
    assert.match(html, /formatMemoryBytes/);
    assert.match(html, /if\(v==null\)return'—'/);
    assert.match(html, /WORKBRIDGE SERVER/);
    assert.match(html, /configuredStartupConfig/);
    assert.match(html, /OpenAI Secure MCP Tunnel · OAuth Off/);
    assert.match(html, /Environment override適用中/);
    assert.match(html, /config\.json/);
    assert.match(html, />BUILD</);
    assert.match(html, /buildIdentity/);
    assert.match(html, /startupConfigSources/);
    assert.match(html, /oauthOwnerToken/);
    assert.match(html, /Model-visible skills/);
    assert.match(html, /Explicit-only skills/);
    assert.match(html, /startup-public-url/);
    assert.match(html, /Project Roots/);
    assert.match(html, /startup-auxiliary-roots/);
    assert.match(html, /startup-worktree-root/);
    assert.match(html, /saveStartupConfig/);
    assert.match(html, /data-runtime-action="resume"/);
    assert.match(html, />Resume</);
    assert.match(html, /resuming:'Resuming'/);
    assert.match(html, /Residual process/);
    assert.match(html, /runtime-dot\.residual_process/);
    assert.match(html, /Activity Log/);
    assert.match(html, /aria-label="Workbridge activity log"/);
    assert.match(html, />Time</);
    assert.match(html, />Workspace</);
    assert.match(html, />Type</);
    assert.match(html, />Operation</);
    assert.match(html, />Status</);
    assert.match(html, />Duration</);
    assert.match(html, />Summary</);
    assert.match(html, /data-resize-column="summary"/);
    assert.match(html, /workbridge-monitor-log-columns-v1/);
    assert.match(html, /Reset columns/);
    assert.match(html, /expandedLogSequences/);
    assert.match(html, /logBody\.querySelector\('\.log-entry\[data-sequence="'\+sequence\+'"\]'\)\?\.remove\(\)/);
    assert.match(html, /log-detail-grid/);
    assert.doesNotMatch(html, /currentFilter==='all'&&log\.details\?\.routineMcpHttp/);
    assert.match(html, /registrationMs/);
    assert.match(html, /new-logs-button/);
    assert.match(html, /isConsoleNearEnd/);
    assert.match(html, /eventSource\.onerror=.*eventSource\.close\(\).*setTimeout\(loadLogHistory,1500\)/);
    assert.match(html, /data-filter="session">MCP/);
    assert.match(html, /SERENA/);
    assert.match(html, /run_semantic_action:'Serena'/);
    assert.doesNotMatch(html, /log\.line/);
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
    const snapshot = await snapshotResponse.json() as {
      revision: number;
      sessions: Array<{ displayId: string }>;
    };
    assert.equal(snapshot.revision, 2);
    assert.equal(snapshot.sessions[0]?.displayId, "session-");

    const operationResponse = await fetch(`${baseUrl}/monitor/api/operations/op-route`);
    assert.equal(operationResponse.status, 200);
    const operationPayload = await operationResponse.json() as {
      operation: { operationId: string; nodeId: string; displayId: string; node: { tool: string } };
    };
    assert.equal(operationPayload.operation.operationId, "op-route");
    assert.equal(operationPayload.operation.displayId, "session-");
    assert.equal(operationPayload.operation.node.tool, "read");

    const missingOperationResponse = await fetch(`${baseUrl}/monitor/api/operations/missing`);
    assert.equal(missingOperationResponse.status, 404);

    const statusResponse = await fetch(`${baseUrl}/monitor/api/status`);
    assert.equal(statusResponse.status, 200);
    const runtimeStatus = await statusResponse.json() as {
      server: {
        pid: number;
        version: string;
        monitorPort: number;
        controlEnabled: boolean;
        stateDir: string;
        mcpConnectionMode: "public-url" | "openai-secure-mcp-tunnel";
        buildIdentity: { sourceRoot: string; branch?: string; commit?: string; dirty?: boolean };
        configProvenance: { oauthOwnerToken: string; oauthClientRegistrationKey: string };
        startupConfig: {
          publicBaseUrl: string;
          allowedRoots: string[];
          auxiliaryRoots: string[];
          worktreeRoot: string;
          stateDir: string;
          trustProxy: boolean;
        };
        memory: { rssBytes: number; heapUsedBytes: number };
      };
      mcpSessions: { stats: { active: number; activeRequests: number }; recent: Array<{ sessionIdPrefix: string }> };
  modernMcpRequests: {
        stats: { requests: number; requestsTotal: number; active: number; activeRequests: number; peakActiveRequests: number; activeRegistrations: number; peakActiveRegistrations: number; activeHandlers: number; peakActiveHandlers: number; requestsCompleted: number; toolsList: number; toolsCall: number; success: number; error: number };
        recent: Array<{ clientName?: string; protocolVersion?: string }>;
      };
      nodeSaturation: { eventLoopUtilization: number; eventLoopDelayP50Ms: number; eventLoopDelayP95Ms: number; eventLoopDelayP99Ms: number; sampleWindowMs: number; sampledAt: string | null };
      softPause?: { reason?: string };
    };
    assert.equal(runtimeStatus.server.pid, 1234);
    assert.equal(runtimeStatus.server.version, "1.4.0");
    assert.equal(runtimeStatus.server.monitorPort, 7677);
    assert.equal(runtimeStatus.server.controlEnabled, true);
    assert.equal(runtimeStatus.server.stateDir, "C:\\workbridge-state");
    assert.equal(runtimeStatus.server.mcpConnectionMode, "openai-secure-mcp-tunnel");
    assert.equal(runtimeStatus.server.buildIdentity.sourceRoot, "C:\\workbridge-source");
    assert.equal(runtimeStatus.server.buildIdentity.commit, "0123456789abcdef");
    assert.equal(runtimeStatus.server.configProvenance.oauthOwnerToken, "auth.json");
    assert.equal(runtimeStatus.server.configProvenance.oauthClientRegistrationKey, "derived");
    assert.equal(runtimeStatus.server.startupConfig.publicBaseUrl, "https://workbridge.example.test");
    assert.deepEqual(runtimeStatus.server.startupConfig.allowedRoots, ["C:\\workspace"]);
    assert.deepEqual(runtimeStatus.server.startupConfig.auxiliaryRoots, [
      "C:\\Users\\test\\.codex",
      "C:\\Users\\test\\.agents",
    ]);
    assert.equal(
      runtimeStatus.server.startupConfig.worktreeRoot,
      "C:\\workspace\\.workbridge\\worktrees",
    );
    assert.equal(runtimeStatus.server.startupConfig.trustProxy, true);
    assert.equal(runtimeStatus.server.memory.rssBytes, 285.2 * 1024 * 1024);
    assert.equal(runtimeStatus.server.memory.heapUsedBytes, 163.2 * 1024 * 1024);
    assert.equal(runtimeStatus.mcpSessions.stats.active, 2);
    assert.equal(runtimeStatus.mcpSessions.stats.activeRequests, 1);
    assert.equal(runtimeStatus.mcpSessions.recent[0]?.sessionIdPrefix, "mcp-123456");
    assert.equal(runtimeStatus.modernMcpRequests.stats.requests, 5);
    assert.equal(runtimeStatus.modernMcpRequests.stats.active, 1);
    assert.equal(runtimeStatus.nodeSaturation.eventLoopUtilization, 0.25);
    assert.equal(runtimeStatus.nodeSaturation.eventLoopDelayP95Ms, 2);
    assert.equal(runtimeStatus.modernMcpRequests.recent[0]?.clientName, "openai-mcp");
    assert.equal(runtimeStatus.modernMcpRequests.recent[0]?.protocolVersion, "2026-07-28");
    assert.equal(runtimeStatus.softPause?.reason, "test pause");

    const published = logs.publish({
      ts: "2026-07-25T00:00:00.000Z",
      level: "info",
      event: "tool_call",
      kind: "read",
      status: "success",
      error: false,
      workspaceId: "ws_test",
      workspace: "test",
      tool: "read",
      operation: "read",
      durationMs: 4,
      summary: "README.md",
      details: { path: "README.md" },
    });
    const logsResponse = await fetch(`${baseUrl}/monitor/api/logs`);
    assert.equal(logsResponse.status, 200);
    const logSnapshot = await logsResponse.json() as {
      version: number;
      latestSequence: number;
      logs: Array<{ sequence: number; summary: string; status: string }>;
    };
    assert.equal(logSnapshot.version, 2);
    assert.equal(logSnapshot.latestSequence, published.sequence);
    assert.equal(logSnapshot.logs[0]?.summary, "README.md");
    assert.equal(logSnapshot.logs[0]?.status, "success");

    const abortController = new AbortController();
    const streamResponse = await fetch(`${baseUrl}/monitor/api/logs/stream?after=0`, {
      signal: abortController.signal,
    });
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") ?? "", /^text\/event-stream/);
    const streamText = await readSseEvent(streamResponse);
    assert.match(streamText, new RegExp(`id: ${published.sequence}`));
    assert.match(streamText, /event: log/);
    assert.match(streamText, /"summary":"README\.md"/);
    abortController.abort();

    const forwardedResponse = await fetch(`${baseUrl}/monitor`, {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    assert.equal(forwardedResponse.status, 404);
    const forwardedLogsResponse = await fetch(`${baseUrl}/monitor/api/logs`, {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    assert.equal(forwardedLogsResponse.status, 404);
    const forwardedStatusResponse = await fetch(`${baseUrl}/monitor/api/status`, {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    assert.equal(forwardedStatusResponse.status, 404);
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
