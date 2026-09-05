import type { AppToolRegistrar } from "./session-monitor-integration.js";

type AppToolServer = Parameters<AppToolRegistrar>[0];
type AppToolName = Parameters<AppToolRegistrar>[1];
type AppToolDefinition = Parameters<AppToolRegistrar>[2];
type AppToolHandler = Parameters<AppToolRegistrar>[3];

export type McpToolCatalogRegistrar = (
  name: AppToolName,
  definition: AppToolDefinition,
  handler: AppToolHandler,
) => unknown;

export interface CompiledMcpToolCatalog {
  readonly entries: readonly McpToolCatalogEntry[];
}

interface McpToolCatalogEntry {
  readonly name: AppToolName;
  readonly definition: AppToolDefinition;
  readonly handler: AppToolHandler;
}

export function createMcpToolCatalogRecorder(): {
  registrar: AppToolRegistrar;
  compile(): CompiledMcpToolCatalog;
} {
  const entries: McpToolCatalogEntry[] = [];
  let catalog: CompiledMcpToolCatalog | undefined;

  const registrar = ((_server: AppToolServer, name: AppToolName, definition: AppToolDefinition, handler: AppToolHandler) => {
    if (catalog) throw new Error("Cannot record MCP tools after catalog compilation");
    entries.push(Object.freeze({ name, definition, handler }));
    return undefined;
  }) as unknown as AppToolRegistrar;

  return {
    registrar,
    compile: () => {
      catalog ??= {
        entries: Object.freeze(entries.slice()),
      };
      return catalog;
    },
  };
}

export function bindMcpToolCatalog(
  registerTool: McpToolCatalogRegistrar,
  catalog: CompiledMcpToolCatalog,
): void {
  for (const entry of catalog.entries) {
    registerTool(entry.name, entry.definition, entry.handler);
  }
}
