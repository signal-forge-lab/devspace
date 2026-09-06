import assert from "node:assert/strict";
import {
  CODEBASE_MEMORY_ACTIONS,
  CodebaseMemoryManager,
  toCodebaseMemoryCall,
  type CodebaseMemoryClient,
} from "./codebase-memory-code-intelligence.js";

assert.deepEqual(CODEBASE_MEMORY_ACTIONS, [
  "architecture",
  "search",
  "trace",
  "impact",
  "snippet",
  "coverage",
  "query",
]);

assert.deepEqual(
  toCodebaseMemoryCall("architecture", { path: "src", aspects: ["overview"] }, "project-a"),
  {
    name: "get_architecture",
    arguments: { project: "project-a", path: "src", aspects: ["overview"] },
  },
);
assert.deepEqual(
  toCodebaseMemoryCall("search", {
    semanticQuery: ["blast", "radius"],
    label: "Function",
    limit: 12,
  }, "project-a"),
  {
    name: "search_graph",
    arguments: {
      project: "project-a",
      semantic_query: ["blast", "radius"],
      label: "Function",
      limit: 12,
    },
  },
);
assert.deepEqual(
  toCodebaseMemoryCall("trace", {
    functionName: "greetUser",
    direction: "both",
    depth: 3,
  }, "project-a"),
  {
    name: "trace_path",
    arguments: { project: "project-a", function_name: "greetUser", direction: "both", depth: 3 },
  },
);
assert.deepEqual(
  toCodebaseMemoryCall("impact", { direction: "inbound", depth: 2 }, "project-a"),
  {
    name: "detect_changes",
    arguments: { project: "project-a", scope: "impact", direction: "inbound", depth: 2 },
  },
);
assert.deepEqual(
  toCodebaseMemoryCall("coverage", { paths: ["src/a.ts", "src/b.ts"] }, "project-a"),
  {
    name: "check_index_coverage",
    arguments: { project: "project-a", paths: ["src/a.ts", "src/b.ts"] },
  },
);
assert.deepEqual(
  toCodebaseMemoryCall("query", { cypher: "MATCH (n) RETURN n LIMIT 5" }, "project-a"),
  {
    name: "query_graph",
    arguments: { project: "project-a", query: "MATCH (n) RETURN n LIMIT 5" },
  },
);
assert.throws(
  () => toCodebaseMemoryCall("trace", {}, "project-a"),
  /functionName is required/,
);
assert.throws(
  () => toCodebaseMemoryCall("coverage", {}, "project-a"),
  /paths or scopes is required/,
);

const requiredTools = [
  "index_repository",
  "get_architecture",
  "search_graph",
  "trace_path",
  "detect_changes",
  "get_code_snippet",
  "check_index_coverage",
  "query_graph",
];
const calls: Array<{ client: number; name: string; arguments?: Record<string, unknown> }> = [];
let connects = 0;
let closes = 0;

const connector = async (): Promise<CodebaseMemoryClient> => {
  const client = ++connects;
  return {
    async listTools() {
      return requiredTools.map((name) => ({ name }));
    },
    async callTool(input) {
      calls.push({ client, ...input });
      if (input.name === "index_repository") {
        return {
          content: [{ type: "text", text: '{"project":"project-a","status":"indexed"}' }],
        };
      }
      return { content: [{ type: "text", text: `${input.name}:ok` }] };
    },
    async close() {
      closes++;
    },
  };
};

const manager = new CodebaseMemoryManager({
  stateDir: "C:/state",
  connector,
});

assert.equal(
  await manager.run("ws-a", "C:/repo", "architecture", { aspects: ["overview"] }),
  "get_architecture:ok",
);
assert.equal(connects, 2, "first use bootstraps the index then reconnects so the watcher sees it");
assert.equal(closes, 1, "bootstrap connection is closed after indexing");
assert.deepEqual(calls[0], {
  client: 1,
  name: "index_repository",
  arguments: { repo_path: "C:\\repo", mode: "moderate", persistence: false },
});
assert.deepEqual(calls[1], {
  client: 2,
  name: "get_architecture",
  arguments: { project: "project-a", aspects: ["overview"] },
});

assert.equal(await manager.run("ws-a", "C:/repo", "search", { query: "handler" }), "search_graph:ok");
assert.equal(connects, 2, "warm calls reuse the bound MCP session");

await manager.close();
assert.equal(closes, 2, "close releases the warm MCP client");

console.log("codebase-memory code-intelligence tests passed");
