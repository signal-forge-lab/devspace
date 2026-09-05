import {
  McpServer,
  type ServerContext,
  type ServerOptions,
} from "@modelcontextprotocol/server";
import type { Implementation as LegacyImplementation } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolCatalogRegistrar } from "./mcp-tool-catalog.js";

interface ModernMcpServerAdapter {
  server: McpServer;
  registerTool: McpToolCatalogRegistrar;
}

type ModernRegisterTool = (
  name: string,
  definition: Record<string, unknown>,
  handler: (input: unknown, context: ServerContext) => unknown,
) => unknown;

export function createModernMcpServerAdapter(
  serverInfo: LegacyImplementation,
  options?: ServerOptions,
): ModernMcpServerAdapter {
  const server = new McpServer(serverInfo, options);
  const registerModernTool = server.registerTool.bind(server) as unknown as ModernRegisterTool;
  const registerTool: McpToolCatalogRegistrar = (name, definition, handler) => registerModernTool(
    name,
    definition as unknown as Record<string, unknown>,
    async (input, context) => (handler as (
      toolInput: unknown,
      extra: Record<string, unknown>,
    ) => unknown)(input, legacyToolHandlerExtra(context)),
  );

  return {
    server,
    registerTool,
  };
}

function legacyToolHandlerExtra(context: ServerContext): Record<string, unknown> {
  const sendRelatedRequest = context.mcpReq.send as unknown as (
    request: unknown,
    resultSchema: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  return {
    signal: context.mcpReq.signal,
    authInfo: context.http?.authInfo,
    sessionId: context.sessionId,
    _meta: context.mcpReq._meta,
    requestId: context.mcpReq.id,
    requestInfo: context.http?.req,
    sendNotification: context.mcpReq.notify,
    sendRequest: sendRelatedRequest,
  };
}
