import assert from "node:assert/strict";
import test from "node:test";
import { detectModernMcpProbe } from "./mcp-modern-probe.js";

test("legacy initialize and sessionless legacy requests are not modern probes", () => {
  assert.equal(detectModernMcpProbe({
    headers: {},
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    },
  }), undefined);

  assert.equal(detectModernMcpProbe({
    headers: {},
    body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  }), undefined);

  assert.equal(detectModernMcpProbe({
    headers: { "mcp-session-id": "legacy-session" },
    body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: {} },
  }), undefined);
});

test("server/discover is a confirmed modern probe without inventing a version", () => {
  assert.deepEqual(detectModernMcpProbe({
    headers: {},
    body: { jsonrpc: "2.0", id: "discover", method: "server/discover", params: {} },
  }), {
    rpcMethod: "server/discover",
    sessionIdPresent: false,
    clientCapabilitiesPresent: false,
    signals: ["server_discover"],
  });
});

test("2026-07-28 protocol headers are matched case-insensitively", () => {
  assert.deepEqual(detectModernMcpProbe({
    headers: {
      "MCP-Protocol-Version": " 2026-07-28 ",
      "Mcp-Method": "tools/list",
      "Mcp-Name": "catalog",
      "User-Agent": "openai-mcp/test",
    },
    body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
  }), {
    protocolVersion: "2026-07-28",
    rpcMethod: "tools/list",
    mcpMethodHeader: "tools/list",
    mcpNameHeader: "catalog",
    sessionIdPresent: false,
    clientCapabilitiesPresent: false,
    userAgent: "openai-mcp/test",
    signals: ["protocol_version_header"],
  });
});

test("2026-07-28 request metadata is detected and logs only safe identity fields", () => {
  assert.deepEqual(detectModernMcpProbe({
    headers: { "mcp-session-id": "legacy-session" },
    body: {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "openai-mcp",
            version: "1.2.3",
            secret: "must-not-leak",
          },
          "io.modelcontextprotocol/clientCapabilities": { anything: true },
        },
      },
    },
  }), {
    protocolVersion: "2026-07-28",
    rpcMethod: "tools/list",
    sessionIdPresent: true,
    clientName: "openai-mcp",
    clientVersion: "1.2.3",
    clientCapabilitiesPresent: true,
    signals: ["protocol_version_meta"],
  });
});

test("multiple modern signals produce one detection with all evidence", () => {
  assert.deepEqual(detectModernMcpProbe({
    headers: { "mcp-protocol-version": "2026-07-28" },
    body: {
      jsonrpc: "2.0",
      id: 5,
      method: "server/discover",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    },
  })?.signals, [
    "server_discover",
    "protocol_version_header",
    "protocol_version_meta",
  ]);
});

test("malformed and unexpected bodies never throw or create false positives", () => {
  for (const body of [undefined, null, 1, "bad", true, {}, { params: { _meta: 1 } }]) {
    assert.doesNotThrow(() => detectModernMcpProbe({ headers: {}, body }));
    assert.equal(detectModernMcpProbe({ headers: {}, body }), undefined);
  }
});

test("modern probe text fields are bounded before logging", () => {
  const detected = detectModernMcpProbe({
    headers: {
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "m".repeat(500),
      "mcp-name": "n".repeat(500),
      "user-agent": "u".repeat(500),
    },
    body: {
      jsonrpc: "2.0",
      id: 6,
      method: "r".repeat(500),
      params: {
        _meta: {
          "io.modelcontextprotocol/clientInfo": {
            name: "c".repeat(500),
            version: "v".repeat(500),
          },
        },
      },
    },
  });

  for (const value of [
    detected?.rpcMethod,
    detected?.mcpMethodHeader,
    detected?.mcpNameHeader,
    detected?.clientName,
    detected?.clientVersion,
    detected?.userAgent,
  ]) assert.equal(value?.length, 160);
});
