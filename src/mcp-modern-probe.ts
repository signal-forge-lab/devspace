export const MODERN_MCP_PROTOCOL_VERSION = "2026-07-28";

export type ModernMcpProbeSignal =
  | "server_discover"
  | "protocol_version_header"
  | "protocol_version_meta";

export interface ModernMcpProbeDetection {
  protocolVersion?: string;
  rpcMethod?: string;
  mcpMethodHeader?: string;
  mcpNameHeader?: string;
  sessionIdPresent: boolean;
  clientName?: string;
  clientVersion?: string;
  clientCapabilitiesPresent: boolean;
  userAgent?: string;
  signals: ModernMcpProbeSignal[];
}

export function detectModernMcpProbe(input: {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}): ModernMcpProbeDetection | undefined {
  const messages = Array.isArray(input.body) ? input.body : [input.body];
  const records = messages.flatMap((message) => {
    const record = objectValue(message);
    return record ? [record] : [];
  });
  const rpcMethod = boundedText(records
    .map((record) => stringValue(record.method))
    .find(Boolean));
  const protocolVersionHeader = boundedText(headerValue(input.headers, "mcp-protocol-version"));
  const meta = records
    .map((record) => objectValue(objectValue(record.params)?._meta))
    .find((value) => value !== undefined);
  const protocolVersionMeta = boundedText(stringValue(meta?.["io.modelcontextprotocol/protocolVersion"]));
  const clientInfo = objectValue(meta?.["io.modelcontextprotocol/clientInfo"]);
  const signals: ModernMcpProbeSignal[] = [];

  if (records.some((record) => stringValue(record.method) === "server/discover")) {
    signals.push("server_discover");
  }
  if (protocolVersionHeader === MODERN_MCP_PROTOCOL_VERSION) {
    signals.push("protocol_version_header");
  }
  if (protocolVersionMeta === MODERN_MCP_PROTOCOL_VERSION) {
    signals.push("protocol_version_meta");
  }
  if (signals.length === 0) return undefined;

  return compactObject({
    protocolVersion: protocolVersionHeader === MODERN_MCP_PROTOCOL_VERSION
      ? protocolVersionHeader
      : protocolVersionMeta === MODERN_MCP_PROTOCOL_VERSION
        ? protocolVersionMeta
        : undefined,
    rpcMethod,
    mcpMethodHeader: boundedText(headerValue(input.headers, "mcp-method")),
    mcpNameHeader: boundedText(headerValue(input.headers, "mcp-name")),
    sessionIdPresent: Boolean(headerValue(input.headers, "mcp-session-id")?.trim()),
    clientName: boundedText(stringValue(clientInfo?.name)),
    clientVersion: boundedText(stringValue(clientInfo?.version)),
    clientCapabilitiesPresent: Boolean(
      meta && Object.hasOwn(meta, "io.modelcontextprotocol/clientCapabilities"),
    ),
    userAgent: boundedText(headerValue(input.headers, "user-agent")),
    signals,
  });
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) return direct[0];
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function boundedText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
