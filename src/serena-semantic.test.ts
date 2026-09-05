import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SERENA_REQUIRED_REVISION,
  SERENA_REQUIRED_VERSION,
  SERENA_SEMANTIC_TOOL_NAMES,
  SERENA_STARTUP_TIMEOUT_MSEC,
  SerenaSemanticManager,
  assertSerenaCheckoutVersion,
  assertSerenaRevision,
  defaultSerenaDirectory,
  diagnoseSerenaStartupError,
  serenaLaunchArguments,
  serenaLaunchEnvironment,
  toSerenaSemanticArguments,
  type SerenaSemanticClient,
  type SerenaSemanticConnector,
} from "./serena-semantic.js";

const stateDir = await mkdtemp(join(tmpdir(), "workbridge-serena-semantic-test-"));
const workspaceRoot = join(stateDir, "workspace-a");

const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
let connectorCalls = 0;
let closeCalls = 0;
let capturedSerenaHome = "";

const client: SerenaSemanticClient = {
  async listTools() {
    return SERENA_SEMANTIC_TOOL_NAMES.map((name) => ({ name }));
  },
  async callTool(input) {
    calls.push(input);
    return {
      isError: false,
      content: [{ type: "text", text: "semantic-result" }],
    };
  },
  async close() {
    closeCalls += 1;
  },
};

const connector: SerenaSemanticConnector = async (input) => {
  connectorCalls += 1;
  capturedSerenaHome = input.serenaHome;
  return client;
};

const manager = new SerenaSemanticManager({ stateDir, connector });

try {
  assert.equal(connectorCalls, 0, "Serena must not start until a semantic action is requested");
  assert.equal(SERENA_REQUIRED_VERSION, "v1.7.0");
  assert.equal(SERENA_REQUIRED_REVISION, "949a27ef1e5fda1a6e7b561e777bcece345c6ffd");
  assert.equal(SERENA_STARTUP_TIMEOUT_MSEC, 60_000);
  assert.doesNotThrow(() => assertSerenaRevision(SERENA_REQUIRED_REVISION));
  assert.throws(
    () => assertSerenaRevision("0000000000000000000000000000000000000000"),
    /Serena checkout revision mismatch.*v1\.7\.0/,
  );
  const invalidSerena = join(stateDir, "not-a-serena-checkout");
  await mkdir(invalidSerena);
  await assert.rejects(
    assertSerenaCheckoutVersion(invalidSerena),
    /Serena checkout must be a Git repository/,
  );

  const managedRoot = join(stateDir, "managed-worktrees", "workbridge-test");
  const managedModuleDir = join(managedRoot, "dist");
  const canonicalWorkbridgeRoot = join(stateDir, "github", "workbridge");
  const canonicalSerena = join(stateDir, "github", "serena");
  const gitCommonDir = join(canonicalWorkbridgeRoot, ".git");
  await mkdir(managedModuleDir, { recursive: true });
  await mkdir(canonicalSerena, { recursive: true });
  assert.equal(
    defaultSerenaDirectory(managedModuleDir, {}, () => gitCommonDir),
    canonicalSerena,
    "managed worktrees should resolve Serena beside the canonical Workbridge checkout",
  );

  assert.deepEqual(serenaLaunchArguments("C:\\serena", "C:\\workspace"), [
    "run",
    "--python",
    "3.13",
    "--directory",
    "C:\\serena",
    "serena",
    "start-mcp-server",
    "--project",
    "C:\\workspace",
    "--context",
    "ide",
    "--mode",
    "no-memories",
    "--enable-web-dashboard",
    "false",
    "--open-web-dashboard",
    "false",
  ]);
  assert.deepEqual(serenaLaunchEnvironment("C:\\state\\serena"), {
    SERENA_HOME: "C:\\state\\serena",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  });
  const genericStartupError = new Error("MCP error -32000: Connection closed");
  const diagnosedStartupError = diagnoseSerenaStartupError(
    genericStartupError,
    "error: failed to remove C:\\serena\\.venv\\Lib\\site-packages\\serena_agent-1.6.1.dist-info\\licenses: Access is denied (os error 5)",
  );
  assert.match(diagnosedStartupError.message, /generated \.venv/);
  assert.match(diagnosedStartupError.message, /Windows access denied/);
  assert.match(diagnosedStartupError.message, /delete\/recreate/);
  assert.equal(
    diagnoseSerenaStartupError(genericStartupError, "unrelated stderr"),
    genericStartupError,
  );
  assert.deepEqual(toSerenaSemanticArguments("find_symbol", {
    namePathPattern: "createServer",
    relativePath: "src/server.ts",
    includeBody: true,
    maxMatches: 1,
  }), {
    name_path_pattern: "createServer",
    relative_path: "src/server.ts",
    include_body: true,
    max_matches: 1,
  });
  assert.deepEqual(toSerenaSemanticArguments("get_diagnostics_for_file", {
    relativePath: "src/server.ts",
    minSeverity: 2,
  }), {
    relative_path: "src/server.ts",
    min_severity: 2,
  });
  assert.throws(
    () => toSerenaSemanticArguments("find_declaration", { relativePath: "src/server.ts" }),
    /regex is required/,
  );

  const health = await manager.run("workspace-a", workspaceRoot, "health", {});
  assert.equal(health, `ready: ${SERENA_SEMANTIC_TOOL_NAMES.join(", ")}`);

  const result = await manager.run("workspace-a", workspaceRoot, "find_symbol", {
    name_path_pattern: "createServer",
  });
  assert.equal(result, "semantic-result");
  assert.equal(connectorCalls, 1, "one Serena client must be shared per workspace");
  assert.deepEqual(calls, [{
    name: "find_symbol",
    arguments: { name_path_pattern: "createServer" },
  }]);

  const config = JSON.parse(await readFile(join(capturedSerenaHome, "serena_config.yml"), "utf8")) as {
    fixed_tools?: string[];
    base_modes?: string[];
    default_modes?: string[];
    trusted_project_path_patterns?: string[];
    web_dashboard?: boolean;
    project_serena_folder_location?: string;
  };
  assert.deepEqual(config.fixed_tools, [...SERENA_SEMANTIC_TOOL_NAMES]);
  assert.deepEqual(config.base_modes, []);
  assert.deepEqual(config.default_modes, []);
  assert.deepEqual(config.trusted_project_path_patterns, []);
  assert.equal(config.web_dashboard, false);
  assert.match(config.project_serena_folder_location ?? "", /project-data[\\/]\.serena$/);
  await access(config.project_serena_folder_location!);

  await assert.rejects(
    manager.run("workspace-a", join(stateDir, "different-root"), "health", {}),
    /already bound to a different root/,
  );

  await manager.close();
  assert.equal(closeCalls, 1);

  const unsafeManager = new SerenaSemanticManager({
    stateDir,
    connector: async () => ({
      ...client,
      async listTools() {
        return [...SERENA_SEMANTIC_TOOL_NAMES.map((name) => ({ name })), { name: "rename_symbol" }];
      },
    }),
  });
  await assert.rejects(
    unsafeManager.run("unsafe", workspaceRoot, "health", {}),
    /tool surface mismatch/,
  );
  await unsafeManager.close();

  const parallelHomes = new Set<string>();
  let parallelCloseCalls = 0;
  const parallelManager = new SerenaSemanticManager({
    stateDir,
    connector: async ({ serenaHome }) => {
      parallelHomes.add(serenaHome);
      return {
        async listTools() {
          return SERENA_SEMANTIC_TOOL_NAMES.map((name) => ({ name }));
        },
        async callTool() {
          return { content: [{ type: "text", text: "ok" }] };
        },
        async close() {
          parallelCloseCalls += 1;
        },
      };
    },
  });
  await Promise.all([
    parallelManager.run("parallel-a", join(stateDir, "worktree-a"), "health", {}),
    parallelManager.run("parallel-b", join(stateDir, "worktree-b"), "health", {}),
  ]);
  assert.equal(parallelHomes.size, 2, "parallel worktrees must use isolated Serena homes");
  await parallelManager.close();
  assert.equal(parallelCloseCalls, 2);

  const boundedConnectorCalls: string[] = [];
  const boundedCloseCalls: string[] = [];
  const boundedManager = new SerenaSemanticManager({
    stateDir,
    connector: async ({ workspaceId }) => {
      boundedConnectorCalls.push(workspaceId);
      return {
        async listTools() {
          return SERENA_SEMANTIC_TOOL_NAMES.map((name) => ({ name }));
        },
        async callTool() {
          return { content: [{ type: "text", text: "ok" }] };
        },
        async close() {
          boundedCloseCalls.push(workspaceId);
        },
      };
    },
  });
  for (let index = 0; index < 7; index += 1) {
    await boundedManager.run(
      `bounded-${index}`,
      join(stateDir, `bounded-worktree-${index}`),
      "health",
      {},
    );
  }
  assert.equal(boundedConnectorCalls.length, 7);
  assert.deepEqual(boundedCloseCalls, ["bounded-0"], "the oldest idle Serena session must be reclaimed");
  await boundedManager.run("bounded-0", join(stateDir, "bounded-worktree-0"), "health", {});
  assert.equal(boundedConnectorCalls.length, 8, "an evicted workspace must reconnect on demand");
  assert.deepEqual(boundedCloseCalls, ["bounded-0", "bounded-1"]);
  await boundedManager.close();
  assert.equal(boundedCloseCalls.length, 8, "every created Serena client must eventually close");

  let sharedClientClosed = false;
  const sharedManager = new SerenaSemanticManager({
    stateDir,
    connector: async () => ({
      async listTools() {
        return SERENA_SEMANTIC_TOOL_NAMES.map((name) => ({ name }));
      },
      async callTool({ name }) {
        if (name === "find_symbol") {
          return { isError: true, content: [{ type: "text", text: "expected query error" }] };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (sharedClientClosed) throw new Error("shared client closed during concurrent call");
        return { content: [{ type: "text", text: "concurrent success" }] };
      },
      async close() {
        sharedClientClosed = true;
      },
    }),
  });
  const concurrentResults = await Promise.allSettled([
    sharedManager.run("shared", workspaceRoot, "find_symbol", { name_path_pattern: "missing" }),
    sharedManager.run("shared", workspaceRoot, "get_symbols_overview", { relative_path: "src/server.ts" }),
  ]);
  assert.equal(concurrentResults[0]?.status, "rejected");
  assert.equal(concurrentResults[1]?.status, "fulfilled");
  assert.equal(
    concurrentResults[1]?.status === "fulfilled" ? concurrentResults[1].value : undefined,
    "concurrent success",
  );
  assert.equal(sharedClientClosed, false, "a Serena tool error must not close the shared workspace client");
  await sharedManager.close();

  const standaloneManager = new SerenaSemanticManager({
    stateDir,
    serenaDir: join(stateDir, "serena-not-installed"),
  });
  await standaloneManager.close();
} finally {
  await manager.close().catch(() => undefined);
  await rm(stateDir, { recursive: true, force: true });
}

console.log("serena semantic manager tests passed");
