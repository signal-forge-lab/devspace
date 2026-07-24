import { createHash } from "node:crypto";
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
    .map((tool) => {
      const contract = canonicalizeJson(tool);
      return {
        name: tool.name,
        contractSha256: sha256(contract),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const snapshot = {
    formatVersion: 3,
    packageVersion: PACKAGE_VERSION,
    source: "SHA-256 of canonical full in-memory MCP tools/list contracts",
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

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
