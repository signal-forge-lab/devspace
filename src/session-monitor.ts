export type SessionMonitorState = "running" | "waiting" | "idle" | "error";
export type SessionMonitorNodeState = "running" | "waiting" | "success" | "error";

export interface SessionMonitorNodeSnapshot {
  number: number;
  tool: string;
  target?: string;
  state: SessionMonitorNodeState;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  exitCode?: number;
}

export interface SessionMonitorSessionSnapshot {
  displayNumber: number;
  sessionIdPrefix: string;
  startedAt: number;
  lastActivityAt: number;
  workspaceId?: string;
  workspaceLabel?: string;
  totalCalls: number;
  state: SessionMonitorState;
  nodes: SessionMonitorNodeSnapshot[];
}

export interface SessionMonitorSnapshot {
  version: 1;
  generatedAt: number;
  sessions: SessionMonitorSessionSnapshot[];
}

export interface SessionMonitorToolReference {
  sessionId: string;
  nodeNumber: number;
}

interface InternalNode extends SessionMonitorNodeSnapshot {
  startedMonotonic: number;
}

interface InternalSession {
  sessionId: string;
  displayNumber: number;
  startedAt: number;
  lastActivityAt: number;
  workspaceId?: string;
  workspaceLabel?: string;
  state: SessionMonitorState;
  nextNodeNumber: number;
  nodes: InternalNode[];
  closedAt?: number;
}

interface SessionMonitorOptions {
  maxSessions?: number;
  maxNodesPerSession?: number;
}

interface BeginToolOptions {
  sessionId: string;
  tool: string;
  input?: unknown;
  workspaceId?: string;
  workspaceLabel?: string;
}

interface ToolOutcome {
  nodeState: SessionMonitorNodeState;
  sessionState: SessionMonitorState;
  exitCode?: number;
}

const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "rejected"]);

export class SessionMonitor {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly maxSessions: number;
  private readonly maxNodesPerSession: number;
  private nextDisplayNumber = 1;

  constructor(options: SessionMonitorOptions = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? 200);
    this.maxNodesPerSession = Math.max(1, options.maxNodesPerSession ?? 200);
  }

  createSession(sessionId: string, startedAt = Date.now()): void {
    if (!sessionId || this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, {
      sessionId,
      displayNumber: this.nextDisplayNumber++,
      startedAt,
      lastActivityAt: startedAt,
      state: "idle",
      nextNodeNumber: 1,
      nodes: [],
    });
    this.pruneSessions();
  }

  closeSession(sessionId: string, closedAt = Date.now()): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.closedAt = closedAt;
    session.lastActivityAt = Math.max(session.lastActivityAt, closedAt);
  }

  beginTool(options: BeginToolOptions): SessionMonitorToolReference {
    this.createSession(options.sessionId);
    const session = this.sessions.get(options.sessionId);
    if (!session) throw new Error("Unable to create session monitor entry.");

    const now = Date.now();
    const number = session.nextNodeNumber++;
    const node: InternalNode = {
      number,
      tool: options.tool,
      target: summarizeToolTarget(options.tool, options.input),
      state: "running",
      startedAt: now,
      startedMonotonic: performance.now(),
    };
    session.nodes.push(node);
    if (session.nodes.length > this.maxNodesPerSession) {
      session.nodes.splice(0, session.nodes.length - this.maxNodesPerSession);
    }
    session.workspaceId = options.workspaceId ?? session.workspaceId;
    session.workspaceLabel = options.workspaceLabel ?? session.workspaceLabel;
    session.state = "running";
    session.lastActivityAt = now;
    session.closedAt = undefined;
    return { sessionId: options.sessionId, nodeNumber: number };
  }

  completeTool(reference: SessionMonitorToolReference, result: unknown): void {
    const session = this.sessions.get(reference.sessionId);
    const node = session?.nodes.find((candidate) => candidate.number === reference.nodeNumber);
    if (!session || !node) return;

    const now = Date.now();
    const outcome = classifyToolResult(result);
    node.state = outcome.nodeState;
    node.exitCode = outcome.exitCode;
    node.completedAt = now;
    node.durationMs = Math.max(0, Math.round(performance.now() - node.startedMonotonic));
    const resultWorkspaceId = readString(readRecord(result)?.structuredContent, "workspaceId");
    if (resultWorkspaceId) session.workspaceId = resultWorkspaceId;
    if (node.number === session.nextNodeNumber - 1) session.state = outcome.sessionState;
    session.lastActivityAt = now;
  }

  failTool(reference: SessionMonitorToolReference): void {
    const session = this.sessions.get(reference.sessionId);
    const node = session?.nodes.find((candidate) => candidate.number === reference.nodeNumber);
    if (!session || !node) return;

    const now = Date.now();
    node.state = "error";
    node.completedAt = now;
    node.durationMs = Math.max(0, Math.round(performance.now() - node.startedMonotonic));
    if (node.number === session.nextNodeNumber - 1) session.state = "error";
    session.lastActivityAt = now;
  }

  snapshot(maxSessions = 20, maxNodesPerSession = 20): SessionMonitorSnapshot {
    const sessions = Array.from(this.sessions.values())
      .sort((left, right) => right.startedAt - left.startedAt || right.displayNumber - left.displayNumber)
      .slice(0, Math.max(1, maxSessions))
      .map((session): SessionMonitorSessionSnapshot => ({
        displayNumber: session.displayNumber,
        sessionIdPrefix: session.sessionId.slice(0, 8),
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        workspaceId: session.workspaceId,
        workspaceLabel: session.workspaceLabel,
        totalCalls: session.nextNodeNumber - 1,
        state: session.state,
        nodes: session.nodes.slice(-Math.max(1, maxNodesPerSession)).map(
          ({ startedMonotonic: _startedMonotonic, ...node }) => ({ ...node }),
        ),
      }));
    return { version: 1, generatedAt: Date.now(), sessions };
  }

  private pruneSessions(): void {
    if (this.sessions.size <= this.maxSessions) return;
    const candidates = Array.from(this.sessions.values())
      .filter((session) => session.state !== "running")
      .sort((left, right) => left.startedAt - right.startedAt);
    for (const candidate of candidates) {
      if (this.sessions.size <= this.maxSessions) break;
      this.sessions.delete(candidate.sessionId);
    }
  }
}

export function workspaceLabelFromPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[\\/]+$/, "");
  if (!normalized) return undefined;
  return compactText(normalized.split(/[\\/]/).filter(Boolean).at(-1), 40);
}

export function summarizeToolTarget(tool: string, input: unknown): string | undefined {
  const record = readRecord(input);
  if (!record) return undefined;
  switch (tool) {
    case "open_workspace": return workspaceLabelFromPath(record.path);
    case "read": return compactPath(record.path);
    case "apply_patch": return summarizePatch(record.patch);
    case "exec_command":
    case "bash": return compactText(record.cmd ?? record.command, 72);
    case "run_workspace_action": {
      const action = compactText(record.action, 48);
      const preset = compactText(record.preset, 32);
      return action && preset ? `${action} / ${preset}` : action;
    }
    case "download_artifact": return compactPath(record.path);
    case "write_stdin": {
      const chars = record.chars;
      if (chars === undefined || chars === "") return "poll";
      if (chars === "\u0003") return "interrupt";
      return typeof chars === "string" ? `input ${chars.length} chars` : "input";
    }
    default:
      return compactPath(record.path)
        ?? compactText(record.action, 72)
        ?? compactText(record.cmd ?? record.command, 72);
  }
}

export function classifyToolResult(result: unknown): ToolOutcome {
  const outer = readRecord(result);
  const structured = readRecord(outer?.structuredContent);
  const status = readString(structured, "status")?.toLowerCase();
  const exitCode = readNumber(structured, "exitCode");
  if (outer?.isError === true || (status && FAILED_STATUSES.has(status)) || (exitCode !== undefined && exitCode !== 0)) {
    return { nodeState: "error", sessionState: "error", exitCode };
  }
  if (structured?.running === true || status === "running") {
    return { nodeState: "waiting", sessionState: "waiting", exitCode };
  }
  return { nodeState: "success", sessionState: "idle", exitCode };
}

function summarizePatch(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const matches = Array.from(value.matchAll(/^\*\*\* (?:Add|Update|Delete|Move) File: (.+)$/gm));
  if (matches.length === 1) return compactPath(matches[0]?.[1]);
  if (matches.length > 1) return `${matches.length} files`;
  return "patch";
}

function compactPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return compactText(value.trim().replace(/\\/g, "/"), 72);
}

function compactText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const candidate = readRecord(value)?.[key];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const candidate = readRecord(value)?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}
