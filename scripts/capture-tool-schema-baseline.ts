import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { ProcessSessionManager } from "../src/process-sessions.js";
import { createReviewCheckpointManager } from "../src/review-checkpoints.js";
import { createMcpServer } from "../src/server.js";
import { PACKAGE_VERSION } from "../src/version.js";
import { createWorkspaceStore } from "../src/workspace-store.js";
import { WorkspaceRegistry } from "../src/workspaces.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repositoryRoot, "docs", "baselines", "workbridge-codex-tool-schema.json");
const temporaryRoot = await mkdtemp(join(tmpdir(), "workbridge-tool-schema-baseline-"));
const workspaceStore = createWorkspaceStore(join(temporaryRoot, "state"));
const processSessions = new ProcessSessionManager();
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(temporaryRoot, "config"),
  DEVSPACE_STATE_DIR: join(temporaryRoot, "state"),
  DEVSPACE_ALLOWED_ROOTS: repositoryRoot,
  DEVSPACE_OAUTH_OWNER_TOKEN: "workbridge-baseline-owner-token",
});
const server = createMcpServer(
  config,
  new WorkspaceRegistry(config, workspaceStore),
  createReviewCheckpointManager(),
  processSessions,
  [],
);
const client = new Client(
  { name: "workbridge-tool-schema-baseline", version: "1.0.0" },
  { capabilities: {} },
);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const response = await client.listTools();
  const tools = response.tools
    .map((tool) => ({
      name: tool.name,
      inputProperties: schemaPropertyNames(tool, "inputSchema"),
      requiredInputProperties: schemaRequiredNames(tool, "inputSchema"),
      outputProperties: schemaPropertyNames(tool, "outputSchema"),
      requiredOutputProperties: schemaRequiredNames(tool, "outputSchema"),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const snapshot = {
    formatVersion: 2,
    packageVersion: PACKAGE_VERSION,
    source: "in-memory MCP tools/list contract summary",
    configuration: {
      toolSurface: "fixed",
      widgets: "off",
      commandMetadata: "always",
      skills: "always",
      subagents: "hidden",
      workspaceActions: "registry",
    },
    tools,
  };
  const output = `${JSON.stringify(snapshot, null, 2)}\n`;

  if (process.argv.includes("--check")) {
    const current = await readFile(baselinePath, "utf8");
    const currentContract = JSON.parse(current) as unknown;
    const generatedContract = JSON.parse(output) as unknown;
    if (JSON.stringify(currentContract) !== JSON.stringify(generatedContract)) {
      throw new Error(
        `Tool contract baseline is stale: ${baselinePath}. Run npm run baseline:tools:print and update it intentionally.`,
      );
    }
    console.log(`Tool contract baseline matches ${baselinePath}.`);
  } else {
    process.stdout.write(output);
  }
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  processSessions.shutdown();
  workspaceStore.close?.();
  await rm(temporaryRoot, { recursive: true, force: true });
}

function schemaPropertyNames(value: unknown, schemaName: string): string[] {
  const schema = recordField(value, schemaName);
  const properties = recordField(schema, "properties");
  return properties ? Object.keys(properties).sort() : [];
}

function schemaRequiredNames(value: unknown, schemaName: string): string[] {
  const schema = recordField(value, schemaName);
  const required = schema?.required;
  return Array.isArray(required)
    ? required.filter((entry): entry is string => typeof entry === "string").sort()
    : [];
}

function recordField(value: unknown, field: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "object" && fieldValue !== null && !Array.isArray(fieldValue)
    ? fieldValue as Record<string, unknown>
    : undefined;
}
