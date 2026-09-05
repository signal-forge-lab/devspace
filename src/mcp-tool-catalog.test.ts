import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { SessionMonitor } from "./session-monitor.js";
import { SoftPauseController } from "./soft-pause.js";
import {
  bindMcpToolCatalog,
  createMcpToolCatalogRecorder,
  type McpToolCatalogRegistrar,
} from "./mcp-tool-catalog.js";
import { createWorkbridgeToolRegistrars } from "./workbridge-tool-registration.js";

test("compiled MCP tool catalogs bind the recorded registrations to fresh servers", async () => {
  const recorder = createMcpToolCatalogRecorder();
  const inputSchema = { value: z.string() };
  const definition = {
    title: "Echo",
    description: "Echo a value.",
    inputSchema,
    _meta: { "openai/outputTemplate": "ui://echo/view.html" },
  };
  const handler = async ({ value }: { value: string }) => ({
    content: [{ type: "text" as const, text: value }],
  });

  recorder.registrar(
    {} as never,
    "echo",
    definition as never,
    handler as never,
  );

  const catalog = recorder.compile();
  assert.equal(recorder.compile(), catalog);
  assert.equal(catalog.entries.length, 1);
  assert.equal(Object.isFrozen(definition), false);
  assert.equal(Object.isFrozen(inputSchema), false);

  const registrations: Array<{
    name: string;
    definition: unknown;
    handler: (...args: unknown[]) => unknown;
  }> = [];
  const registerTool: McpToolCatalogRegistrar = (name, registeredDefinition, registeredHandler) => {
    registrations.push({
      name,
      definition: registeredDefinition,
      handler: registeredHandler as (...args: unknown[]) => unknown,
    });
    return undefined;
  };

  bindMcpToolCatalog(registerTool, catalog);
  bindMcpToolCatalog(registerTool, catalog);

  assert.deepEqual(registrations.map(({ name }) => name), ["echo", "echo"]);
  assert.equal(registrations[0]?.definition, definition);
  assert.equal(registrations[1]?.definition, definition);
  assert.equal(registrations[0]?.handler, handler);
  assert.equal(registrations[1]?.handler, handler);
  assert.equal(
    (registrations[0]?.definition as typeof definition).inputSchema,
    inputSchema,
  );
  assert.deepEqual(
    await registrations[0]?.handler({ value: "ok" }),
    { content: [{ type: "text", text: "ok" }] },
  );
  assert.throws(
    () => recorder.registrar({} as never, "late", definition as never, handler as never),
    /after catalog compilation/,
  );
});

test("compiled wrapper handlers keep Soft Pause live and Monitor lifecycle behavior", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "workbridge-mcp-tool-catalog-test-"));
  try {
    const recorder = createMcpToolCatalogRecorder();
    const softPause = new SoftPauseController(stateDir);
    const monitor = new SessionMonitor();
    const { registerTool } = createWorkbridgeToolRegistrars({
      config: { widgets: "off" } as ServerConfig,
      softPause,
      workspaces: {} as never,
      monitorContext: {
        monitor,
        sessionId: () => "modern-session",
      },
      baseRegisterTool: recorder.registrar,
    });

    registerTool(
      {} as never,
      "echo",
      { description: "Echo a value." } as never,
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
    const catalog = recorder.compile();
    const entry = catalog.entries[0];
    assert.ok(entry);

    const beforePause = await entry.handler({}, {} as never) as {
      content?: Array<{ text?: string }>;
    };
    assert.equal(beforePause.content?.[0]?.text, "ok");

    softPause.request("hold after this call");
    const afterPause = await entry.handler({}, {} as never) as {
      content?: Array<{ text?: string }>;
    };
    assert.match(afterPause.content?.at(-1)?.text ?? "", /WORKBRIDGE_SOFT_PAUSE_REQUESTED/);

    const snapshot = monitor.snapshot();
    assert.equal(snapshot.sessions.length, 1);
    assert.match(snapshot.sessions[0]?.displayId ?? "", /^modern-s/);
    assert.equal(snapshot.sessions[0]?.totalCalls, 2);
    assert.deepEqual(snapshot.sessions[0]?.nodes.map((node) => node.state), [
      "success",
      "success",
    ]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

console.log("MCP tool catalog tests passed");
