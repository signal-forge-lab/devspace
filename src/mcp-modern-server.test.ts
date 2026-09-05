import assert from "node:assert/strict";
import test from "node:test";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  createModernMcpServerAdapter,
} from "./mcp-modern-server.js";
import {
  bindMcpToolCatalog,
  createMcpToolCatalogRecorder,
} from "./mcp-tool-catalog.js";

test("strict modern handler answers the 2026-07-28 discovery probe", async (t) => {
  const handler = createMcpHandler(() => new McpServer(
    { name: "workbridge-modern-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  ), { legacy: "reject" });
  t.after(async () => handler.close());

  const response = await handler.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": "server/discover",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "modern-discover",
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  }));

  assert.equal(response.status, 200);
  const body = await response.json() as {
    result?: { supportedVersions?: string[] };
  };
  assert.ok(body.result?.supportedVersions?.includes("2026-07-28"));
});

test("modern registration adapter preserves tools and request metadata", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "workbridge-modern-test",
      version: "1.0.0",
    });
    adapter.registerTool(
      "echo_scope",
      {
        description: "Echo the modern request scope.",
        inputSchema: { value: z.string() },
        _meta: {},
      },
      async (
        { value }: { value: string },
        { _meta }: { _meta?: Record<string, unknown> },
      ) => ({
        content: [{
          type: "text",
          text: `${value}:${String(_meta?.["openai/session"] ?? "missing")}`,
        }],
      }),
    );
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const listed = await postModern(handler, "tools/list", {});
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as {
    result?: { tools?: Array<{ name?: string }> };
  };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "echo_scope"));

  const called = await postModern(handler, "tools/call", {
    name: "echo_scope",
    arguments: { value: "ok" },
    _meta: { "openai/session": "modern-chat" },
  });
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await called.json() as {
    result?: { content?: Array<{ text?: string }> };
  };
  assert.equal(callBody.result?.content?.[0]?.text, "ok:modern-chat");
});

test("compiled catalog preserves definitions and metadata across fresh modern servers", async (t) => {
  const recorder = createMcpToolCatalogRecorder();
  const definition = {
    title: "Echo scope",
    description: "Echo the modern request scope.",
    inputSchema: { value: z.string() },
    _meta: { "openai/outputTemplate": "ui://echo/view.html" },
  };
  const handler = async (
    { value }: { value: string },
    { _meta }: { _meta?: Record<string, unknown> },
  ) => ({
    content: [{
      type: "text" as const,
      text: `${value}:${String(_meta?.["openai/session"] ?? "missing")}`,
    }],
  });
  recorder.registrar(
    {} as never,
    "echo_scope",
    definition as never,
    handler as never,
  );
  const catalog = recorder.compile();
  const handlerForRequest = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "workbridge-modern-test",
      version: "1.0.0",
    });
    bindMcpToolCatalog(adapter.registerTool, catalog);
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handlerForRequest.close());

  const firstList = await postModern(handlerForRequest, "tools/list", {});
  const secondList = await postModern(handlerForRequest, "tools/list", {});
  assert.equal(firstList.status, 200, await firstList.clone().text());
  assert.equal(secondList.status, 200, await secondList.clone().text());
  const firstListBody = await firstList.json() as {
    result?: { tools?: Array<{ name?: string; _meta?: Record<string, unknown> }> };
  };
  const secondListBody = await secondList.json() as {
    result?: { tools?: Array<{ name?: string; _meta?: Record<string, unknown> }> };
  };
  const firstTool = firstListBody.result?.tools?.find((tool) => tool.name === "echo_scope");
  const secondTool = secondListBody.result?.tools?.find((tool) => tool.name === "echo_scope");
  assert.ok(firstTool);
  assert.ok(secondTool);
  assert.deepEqual(firstTool, secondTool);
  assert.equal(firstTool._meta?.["openai/outputTemplate"], "ui://echo/view.html");

  const called = await postModern(handlerForRequest, "tools/call", {
    name: "echo_scope",
    arguments: { value: "ok" },
    _meta: { "openai/session": "modern-chat" },
  });
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await called.json() as {
    result?: { content?: Array<{ text?: string }> };
  };
  assert.equal(callBody.result?.content?.[0]?.text, "ok:modern-chat");
});

function postModern(
  handler: { fetch(request: Request): Promise<Response> },
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return handler.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          ...objectValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  }));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
