import { posix, win32 } from "node:path";
import { workspaceIdDisplayToken } from "./logger.js";
import {
  sanitizeMonitorCommand,
  type MonitorOperationDetails,
} from "./monitor-operation-context.js";

export { workspaceIdDisplayToken } from "./logger.js";

export type SessionMonitorState = "running" | "waiting" | "idle" | "error";
export type SessionMonitorNodeState = "running" | "waiting" | "success" | "error";
export type SessionMonitorSort = "startedAt" | "lastActivityAt";

export interface SessionMonitorNodeSnapshot {
  nodeId: string;
  operationId: string;
  number: number;
  tool: string;
  target?: string;
  state: SessionMonitorNodeState;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  exitCode?: number;
}

export interface SessionMonitorOperationSnapshot {
  operationId: string;
  nodeId: string;
  workspaceId?: string;
  workspaceLabel?: string;
  workspaceDetail?: string;
  workspacePath?: string;
  workspaceContext?: SessionMonitorWorkspaceContext;
  displayId: string;
  sessionDisplayNumber: number;
  node: SessionMonitorNodeSnapshot;
  details: MonitorOperationDetails;
}

export interface SessionMonitorSessionSnapshot {
  displayNumber: number;
  displayId: string;
  startedAt: number;
  lastActivityAt: number;
  workspaceId?: string;
  workspaceLabel?: string;
  workspaceDetail?: string;
  workspacePath?: string;
  workspaceContext?: SessionMonitorWorkspaceContext;
  totalCalls: number;
  state: SessionMonitorState;
  nodes: SessionMonitorNodeSnapshot[];
}

export interface SessionMonitorSnapshot {
  version: 5;
  revision: number;
  generatedAt: number;
  sessions: SessionMonitorSessionSnapshot[];
}

export interface SessionMonitorToolReference {
  sessionKey: string;
  nodeId: string;
  operationId: string;
}

export interface SessionMonitorWorkspaceIdentity {
  workspaceId: string;
  workspaceLabel?: string;
  workspaceDetail?: string;
  workspacePath?: string;
  workspaceContext?: SessionMonitorWorkspaceContext;
  startedAt?: number;
}

export interface SessionMonitorWorkspaceContext {
  mode?: string;
  base?: string;
  sourceRoot?: string;
  loadedInstructions?: string[];
  availableInstructions?: string[];
  skills?: string[];
  explicitOnlySkills?: string[];
  agents?: string[];
}

export interface WorkspaceDisplayInfo {
  label?: string;
  detail?: string;
  path?: string;
}

interface InternalNode extends SessionMonitorNodeSnapshot {
  id: string;
  startedMonotonic: number;
  details?: MonitorOperationDetails;
}

interface InternalSession {
  key: string;
  transportSessionId?: string;
  workspaceId?: string;
  displayNumber: number;
  startedAt: number;
  lastActivityAt: number;
  workspaceLabel?: string;
  workspaceDetail?: string;
  workspacePath?: string;
  workspaceContext?: SessionMonitorWorkspaceContext;
  state: SessionMonitorState;
  nextNodeNumber: number;
  nodes: InternalNode[];
}

interface SessionMonitorOptions {
  maxSessions?: number;
  maxNodesPerSession?: number;
  maxOperationDetails?: number;
}

interface BeginToolOptions {
  operationId: string;
  transportSessionId?: string;
  workspaceId?: string;
  workspaceStartedAt?: number;
  tool: string;
  input?: unknown;
  workspaceLabel?: string;
  workspaceDetail?: string;
  workspacePath?: string;
  workspaceContext?: SessionMonitorWorkspaceContext;
}

interface ToolOutcome {
  nodeState: SessionMonitorNodeState;
  sessionState: SessionMonitorState;
  exitCode?: number;
}

const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "rejected"]);
const GENERIC_WORKTREE_NAMES = new Set([
  "next",
  "current",
  "main",
  "master",
  "develop",
  "development",
  "dev",
  "stage",
  "staging",
  "production",
  "prod",
]);

export class SessionMonitor {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly maxSessions: number;
  private readonly maxNodesPerSession: number;
  private readonly maxOperationDetails: number;
  private readonly detailedNodeIds: string[] = [];
  private nextDisplayNumber = 1;
  private nextNodeId = 1;
  private revision = 0;

  constructor(options: SessionMonitorOptions = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? 200);
    this.maxNodesPerSession = Math.max(1, options.maxNodesPerSession ?? 200);
    this.maxOperationDetails = Math.max(1, options.maxOperationDetails ?? 300);
  }

  beginTool(options: BeginToolOptions): SessionMonitorToolReference {
    const now = Date.now();
    const sessionKey = options.workspaceId
      ? workspaceSessionKey(options.workspaceId)
      : transportSessionKey(options.transportSessionId ?? `unbound-${now}-${this.nextNodeId}`);
    const session = this.ensureSession(sessionKey, {
      transportSessionId: options.transportSessionId,
      workspaceId: options.workspaceId,
      startedAt: options.workspaceStartedAt ?? now,
      workspaceLabel: options.workspaceLabel,
      workspaceDetail: options.workspaceDetail,
      workspacePath: options.workspacePath,
      workspaceContext: options.workspaceContext,
    });

    const number = session.nextNodeNumber++;
    const nodeId = `node-${this.nextNodeId++}`;
    const node: InternalNode = {
      id: nodeId,
      nodeId,
      operationId: options.operationId,
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
    session.state = "running";
    session.lastActivityAt = now;
    this.pruneSessions();
    this.revision += 1;
    return { sessionKey, nodeId, operationId: options.operationId };
  }

  updateTool(
    reference: SessionMonitorToolReference,
    details: MonitorOperationDetails,
  ): void {
    const session = this.sessions.get(reference.sessionKey);
    const node = session?.nodes.find((candidate) => candidate.id === reference.nodeId);
    if (!session || !node) return;
    const hadDetails = node.details !== undefined;
    const next = { ...(node.details ?? {}), ...details };
    if (JSON.stringify(next) === JSON.stringify(node.details ?? {})) return;
    node.details = next;
    if (!hadDetails) {
      this.detailedNodeIds.push(node.id);
      this.pruneOperationDetails();
    }
    session.lastActivityAt = Date.now();
    this.revision += 1;
  }

  completeTool(
    reference: SessionMonitorToolReference,
    result: unknown,
    workspaceIdentity?: SessionMonitorWorkspaceIdentity,
  ): void {
    const session = this.sessions.get(reference.sessionKey);
    const node = session?.nodes.find((candidate) => candidate.id === reference.nodeId);
    if (!session || !node) return;

    const now = Date.now();
    const outcome = classifyToolResult(result);
    node.state = outcome.nodeState;
    node.exitCode = outcome.exitCode;
    node.completedAt = now;
    node.durationMs = Math.max(0, Math.round(performance.now() - node.startedMonotonic));
    if (node.number === session.nextNodeNumber - 1) session.state = outcome.sessionState;
    session.lastActivityAt = now;

    const resultWorkspaceId = workspaceIdentity?.workspaceId
      ?? readString(readRecord(result)?.structuredContent, "workspaceId");
    if (resultWorkspaceId) {
      this.promoteToWorkspace(reference.sessionKey, {
        workspaceId: resultWorkspaceId,
        workspaceLabel: workspaceIdentity?.workspaceLabel,
        workspaceDetail: workspaceIdentity?.workspaceDetail,
        workspacePath: workspaceIdentity?.workspacePath,
        workspaceContext: workspaceIdentity?.workspaceContext,
        startedAt: workspaceIdentity?.startedAt,
      });
    }
    this.revision += 1;
  }

  failTool(reference: SessionMonitorToolReference): void {
    const session = this.sessions.get(reference.sessionKey);
    const node = session?.nodes.find((candidate) => candidate.id === reference.nodeId);
    if (!session || !node) return;

    const now = Date.now();
    node.state = "error";
    node.completedAt = now;
    node.durationMs = Math.max(0, Math.round(performance.now() - node.startedMonotonic));
    if (node.number === session.nextNodeNumber - 1) session.state = "error";
    session.lastActivityAt = now;
    this.revision += 1;
  }

  snapshot(
    maxSessions = 20,
    maxNodesPerSession = 20,
    sortBy: SessionMonitorSort = "startedAt",
  ): SessionMonitorSnapshot {
    const sessions = Array.from(this.sessions.values())
      .sort((left, right) => {
        const difference = sortBy === "lastActivityAt"
          ? right.lastActivityAt - left.lastActivityAt
          : right.startedAt - left.startedAt;
        return difference || right.displayNumber - left.displayNumber;
      })
      .slice(0, Math.max(1, maxSessions))
      .map((session): SessionMonitorSessionSnapshot => ({
        displayNumber: session.displayNumber,
        displayId: session.workspaceId
          ? workspaceIdDisplayToken(session.workspaceId)
          : transportIdCompactPrefix(session.transportSessionId),
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        workspaceId: session.workspaceId,
        workspaceLabel: session.workspaceLabel,
        workspaceDetail: session.workspaceDetail,
        workspacePath: session.workspacePath,
        workspaceContext: session.workspaceContext,
        totalCalls: session.nextNodeNumber - 1,
        state: session.state,
        nodes: session.nodes.slice(-Math.max(1, maxNodesPerSession)).map(
          ({ id: _id, startedMonotonic: _startedMonotonic, details: _details, ...node }) => ({ ...node }),
        ),
      }));
    return { version: 5, revision: this.revision, generatedAt: Date.now(), sessions };
  }

  operation(operationId: string): SessionMonitorOperationSnapshot | undefined {
    for (const session of this.sessions.values()) {
      const node = session.nodes.find((candidate) => candidate.operationId === operationId);
      if (!node) continue;
      const { id: _id, startedMonotonic: _startedMonotonic, details, ...snapshot } = node;
      return {
        operationId: node.operationId,
        nodeId: node.nodeId,
        workspaceId: session.workspaceId,
        workspaceLabel: session.workspaceLabel,
        workspaceDetail: session.workspaceDetail,
        workspacePath: session.workspacePath,
        workspaceContext: session.workspaceContext,
        displayId: session.workspaceId
          ? workspaceIdDisplayToken(session.workspaceId)
          : transportIdCompactPrefix(session.transportSessionId),
        sessionDisplayNumber: session.displayNumber,
        node: { ...snapshot },
        details: { ...(details ?? {}) },
      };
    }
    return undefined;
  }

  private ensureSession(
    key: string,
    identity: {
      transportSessionId?: string;
      workspaceId?: string;
      startedAt: number;
      workspaceLabel?: string;
      workspaceDetail?: string;
      workspacePath?: string;
      workspaceContext?: SessionMonitorWorkspaceContext;
    },
  ): InternalSession {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.workspaceId = identity.workspaceId ?? existing.workspaceId;
      existing.workspaceLabel = identity.workspaceLabel ?? existing.workspaceLabel;
      existing.workspaceDetail = identity.workspaceDetail ?? existing.workspaceDetail;
      existing.workspacePath = identity.workspacePath ?? existing.workspacePath;
      existing.workspaceContext = mergeWorkspaceContext(existing.workspaceContext, identity.workspaceContext);
      existing.startedAt = Math.min(existing.startedAt, identity.startedAt);
      return existing;
    }

    const session: InternalSession = {
      key,
      transportSessionId: identity.transportSessionId,
      workspaceId: identity.workspaceId,
      displayNumber: this.nextDisplayNumber++,
      startedAt: identity.startedAt,
      lastActivityAt: identity.startedAt,
      workspaceLabel: identity.workspaceLabel,
      workspaceDetail: identity.workspaceDetail,
      workspacePath: identity.workspacePath,
      workspaceContext: identity.workspaceContext,
      state: "idle",
      nextNodeNumber: 1,
      nodes: [],
    };
    this.sessions.set(key, session);
    return session;
  }

  private promoteToWorkspace(
    sourceKey: string,
    identity: SessionMonitorWorkspaceIdentity,
  ): void {
    const source = this.sessions.get(sourceKey);
    if (!source) return;
    const targetKey = workspaceSessionKey(identity.workspaceId);
    const target = this.sessions.get(targetKey);

    if (!target || target === source) {
      if (sourceKey !== targetKey) {
        this.sessions.delete(sourceKey);
        source.key = targetKey;
        this.sessions.set(targetKey, source);
      }
      applyWorkspaceIdentity(source, identity);
      return;
    }

    target.nodes.push(...source.nodes);
    target.nodes.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
    target.nodes.forEach((node, index) => {
      node.number = index + 1;
    });
    if (target.nodes.length > this.maxNodesPerSession) {
      target.nodes.splice(0, target.nodes.length - this.maxNodesPerSession);
    }
    target.nextNodeNumber = target.nodes.reduce((maximum, node) => Math.max(maximum, node.number), 0) + 1;
    target.startedAt = Math.min(target.startedAt, source.startedAt, identity.startedAt ?? Number.POSITIVE_INFINITY);
    target.lastActivityAt = Math.max(target.lastActivityAt, source.lastActivityAt);
    target.state = currentSessionState(target.nodes);
    applyWorkspaceIdentity(target, identity);
    this.sessions.delete(sourceKey);
  }

  private pruneSessions(): void {
    if (this.sessions.size <= this.maxSessions) return;
    const candidates = Array.from(this.sessions.values())
      .filter((session) => session.state !== "running")
      .sort((left, right) => left.startedAt - right.startedAt);
    for (const candidate of candidates) {
      if (this.sessions.size <= this.maxSessions) break;
      this.sessions.delete(candidate.key);
    }
  }

  private pruneOperationDetails(): void {
    while (this.detailedNodeIds.length > this.maxOperationDetails) {
      const nodeId = this.detailedNodeIds.shift();
      if (!nodeId) break;
      for (const session of this.sessions.values()) {
        const node = session.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) continue;
        node.details = undefined;
        break;
      }
    }
  }
}

export function workspaceDisplayInfo(root: unknown, sourceRoot?: unknown): WorkspaceDisplayInfo {
  const normalizedRoot = normalizeDisplayPath(root);
  if (!normalizedRoot) return {};
  const rootPath = displayPathApi(normalizedRoot);
  const rootName = rootPath.basename(normalizedRoot);
  const normalizedSourceRoot = normalizeDisplayPath(sourceRoot);
  const sourceName = normalizedSourceRoot
    ? displayPathApi(normalizedSourceRoot).basename(normalizedSourceRoot)
    : undefined;

  if (sourceName && sourceName !== rootName) {
    return {
      label: sourceName,
      detail: `worktree: ${rootName}`,
      path: normalizedRoot,
    };
  }

  const parentName = rootPath.basename(rootPath.dirname(normalizedRoot));
  const inferredProject = parentName.replace(/(?:[._-]?worktrees?)$/i, "");
  if (
    GENERIC_WORKTREE_NAMES.has(rootName.toLowerCase())
    && inferredProject
    && inferredProject !== parentName
  ) {
    return {
      label: inferredProject,
      detail: `worktree: ${rootName}`,
      path: normalizedRoot,
    };
  }

  return { label: rootName, path: normalizedRoot };
}

export function workspaceLabelFromPath(value: unknown): string | undefined {
  return workspaceDisplayInfo(value).label;
}

export function summarizeToolTarget(tool: string, input: unknown): string | undefined {
  const record = readRecord(input);
  if (!record) return undefined;
  switch (tool) {
    case "open_workspace": return workspaceLabelFromPath(record.path);
    case "read": return compactPath(record.path);
    case "apply_patch": return summarizePatch(record.patch);
    case "exec_command":
    case "bash": {
      const command = readString(record, "cmd") ?? readString(record, "command");
      return command
        ? compactText(sanitizeMonitorCommand(command).commandDisplay, 72)
        : undefined;
    }
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
        ?? compactText(
          sanitizeMonitorCommand(
            readString(record, "cmd") ?? readString(record, "command") ?? "",
          ).commandDisplay,
          72,
        );
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

function applyWorkspaceIdentity(
  session: InternalSession,
  identity: SessionMonitorWorkspaceIdentity,
): void {
  session.workspaceId = identity.workspaceId;
  session.workspaceLabel = identity.workspaceLabel ?? session.workspaceLabel;
  session.workspaceDetail = identity.workspaceDetail ?? session.workspaceDetail;
  session.workspacePath = identity.workspacePath ?? session.workspacePath;
  session.workspaceContext = mergeWorkspaceContext(session.workspaceContext, identity.workspaceContext);
  if (identity.startedAt !== undefined) {
    session.startedAt = Math.min(session.startedAt, identity.startedAt);
  }
}

function mergeWorkspaceContext(
  current: SessionMonitorWorkspaceContext | undefined,
  next: SessionMonitorWorkspaceContext | undefined,
): SessionMonitorWorkspaceContext | undefined {
  if (!current) return next;
  if (!next) return current;
  return {
    ...current,
    ...next,
    loadedInstructions: next.loadedInstructions?.length ? next.loadedInstructions : current.loadedInstructions,
    availableInstructions: next.availableInstructions?.length ? next.availableInstructions : current.availableInstructions,
    skills: next.skills?.length ? next.skills : current.skills,
    explicitOnlySkills: next.explicitOnlySkills?.length ? next.explicitOnlySkills : current.explicitOnlySkills,
    agents: next.agents?.length ? next.agents : current.agents,
  };
}

function currentSessionState(nodes: InternalNode[]): SessionMonitorState {
  const latest = nodes.at(-1);
  if (!latest) return "idle";
  if (latest.state === "running") return "running";
  if (latest.state === "waiting") return "waiting";
  if (latest.state === "error") return "error";
  return "idle";
}

function workspaceSessionKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

function transportSessionKey(transportSessionId: string): string {
  return `transport:${transportSessionId}`;
}

function transportIdCompactPrefix(value: string | undefined): string {
  return value ? value.slice(0, 8) : "opening";
}

function normalizeDisplayPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[\\/]+$/, "");
  return normalized || undefined;
}

function displayPathApi(value: string): typeof posix | typeof win32 {
  return value.includes("\\") ? win32 : posix;
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
