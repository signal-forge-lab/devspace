import { AsyncLocalStorage } from "node:async_hooks";

const MAX_COMMAND_CHARACTERS = 32 * 1024;
const MAX_DETAIL_CHARACTERS = 2_000;
const PROCESS_DETAIL_TTL_MS = 10 * 60 * 1_000;
const MAX_PROCESS_DETAILS = 500;

export interface MonitorOperationDetails {
  commandDisplay?: string;
  commandTruncated?: boolean;
  workingDirectory?: string;
  shell?: string;
  action?: string;
  preset?: string;
  profile?: string;
  sessionId?: number;
  parentSessionId?: number;
  tty?: boolean;
  intent?: string;
  retryContext?: string;
  outputTruncated?: boolean;
  signal?: string;
  exitCode?: number;
  error?: string;
  dryRun?: boolean;
  executed?: boolean;
  cancelled?: boolean;
}

export interface MonitorToolLogFields extends MonitorOperationDetails {
  tool: string;
  workspaceId?: string;
  command?: string;
  commandLength?: number;
  running?: boolean;
}

interface MonitorOperationStore {
  operationId: string;
  details: MonitorOperationDetails;
  update(details: MonitorOperationDetails): void;
}

interface StoredProcessDetails {
  expiresAt: number;
  details: MonitorOperationDetails;
}

const operationStorage = new AsyncLocalStorage<MonitorOperationStore>();
const processDetails = new Map<string, StoredProcessDetails>();

export function runMonitorOperation<T>(
  operationId: string,
  update: (details: MonitorOperationDetails) => void,
  callback: () => T,
): T {
  return operationStorage.run({ operationId, details: {}, update }, callback);
}

export function currentMonitorOperationId(): string | undefined {
  return operationStorage.getStore()?.operationId;
}

export function currentMonitorOperationDetails(): MonitorOperationDetails {
  return { ...(operationStorage.getStore()?.details ?? {}) };
}

export function recordMonitorOperationDetails(details: MonitorOperationDetails): void {
  const store = operationStorage.getStore();
  if (!store) return;
  const normalized = normalizeDetails(details);
  if (Object.keys(normalized).length === 0) return;
  Object.assign(store.details, normalized);
  store.update(normalized);
}

export function captureMonitorToolLog(fields: MonitorToolLogFields): string | undefined {
  const parent = fields.tool === "write_stdin" && fields.workspaceId && fields.sessionId !== undefined
    ? readProcessDetails(fields.workspaceId, fields.sessionId)
    : undefined;
  const commandDetails = fields.command === undefined
    ? {}
    : sanitizeMonitorCommand(fields.command);
  const details = normalizeDetails({
    ...parent,
    ...commandDetails,
    workingDirectory: fields.workingDirectory,
    shell: fields.shell,
    action: fields.action,
    preset: fields.preset,
    profile: fields.profile,
    sessionId: fields.sessionId,
    parentSessionId: parent ? fields.sessionId : undefined,
    tty: fields.tty,
    intent: fields.intent,
    retryContext: fields.retryContext,
    outputTruncated: fields.outputTruncated,
    signal: fields.signal,
    exitCode: fields.exitCode,
    error: fields.error,
    dryRun: fields.dryRun,
    executed: fields.executed,
    cancelled: fields.cancelled,
  });
  recordMonitorOperationDetails(details);

  if (
    fields.workspaceId
    && fields.sessionId !== undefined
    && fields.running === true
    && details.commandDisplay
  ) {
    rememberProcessDetails(fields.workspaceId, fields.sessionId, details);
  }
  if (
    fields.tool === "write_stdin"
    && fields.workspaceId
    && fields.sessionId !== undefined
    && fields.running !== true
  ) {
    forgetProcessDetails(fields.workspaceId, fields.sessionId);
  }
  return currentMonitorOperationId();
}

export function sanitizeMonitorCommand(command: string): Pick<
  MonitorOperationDetails,
  "commandDisplay" | "commandTruncated"
> {
  const redacted = redactKnownSecrets(command);
  if (redacted.length <= MAX_COMMAND_CHARACTERS) {
    return { commandDisplay: redacted, commandTruncated: false };
  }
  const marker = "\n... command truncated ...\n";
  const available = MAX_COMMAND_CHARACTERS - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return {
    commandDisplay: `${redacted.slice(0, head)}${marker}${redacted.slice(-tail)}`,
    commandTruncated: true,
  };
}

export function sanitizeMonitorText(value: string): string {
  const redacted = redactKnownSecrets(value);
  return redacted.length <= MAX_DETAIL_CHARACTERS
    ? redacted
    : `${redacted.slice(0, MAX_DETAIL_CHARACTERS - 3)}...`;
}

function normalizeDetails(details: MonitorOperationDetails): MonitorOperationDetails {
  const normalized: MonitorOperationDetails = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      const safe = key === "commandDisplay"
        ? sanitizeMonitorCommand(value).commandDisplay
        : sanitizeMonitorText(value);
      if (safe) (normalized as Record<string, unknown>)[key] = safe;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      (normalized as Record<string, unknown>)[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      (normalized as Record<string, unknown>)[key] = value;
    }
  }
  return normalized;
}

function rememberProcessDetails(
  workspaceId: string,
  sessionId: number,
  details: MonitorOperationDetails,
): void {
  pruneProcessDetails();
  processDetails.set(processKey(workspaceId, sessionId), {
    expiresAt: Date.now() + PROCESS_DETAIL_TTL_MS,
    details: { ...details },
  });
  while (processDetails.size > MAX_PROCESS_DETAILS) {
    const oldest = processDetails.keys().next().value as string | undefined;
    if (!oldest) break;
    processDetails.delete(oldest);
  }
}

function readProcessDetails(
  workspaceId: string,
  sessionId: number,
): MonitorOperationDetails | undefined {
  pruneProcessDetails();
  const stored = processDetails.get(processKey(workspaceId, sessionId));
  return stored ? { ...stored.details } : undefined;
}

function forgetProcessDetails(workspaceId: string, sessionId: number): void {
  processDetails.delete(processKey(workspaceId, sessionId));
}

function pruneProcessDetails(now = Date.now()): void {
  for (const [key, stored] of processDetails) {
    if (stored.expiresAt <= now) processDetails.delete(key);
  }
}

function processKey(workspaceId: string, sessionId: number): string {
  return `${workspaceId}:${sessionId}`;
}

function redactKnownSecrets(value: string): string {
  return value
    .replace(
      /(\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)([^"'`\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:cookie|set-cookie|x-api-key|api-key)\s*:\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^"'`\s;&|]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:access[_-]?token|api[_-]?key|token|secret|password|passwd|cookie|authorization|session[_-]?token)\b\s*=\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s;&|]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:--|-D)(?:access-token|api-key|token|secret|password|passwd|cookie|authorization)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:access_token|api_key|token|key|secret|password|auth|authorization|signature)=)[^&#\s]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:^|\s)(?:-u|--user)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
      "$1[REDACTED]@",
    );
}
