import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerMonitorControlRoutes } from "./monitor-control.js";

const app = express();
let shutdownCalls = 0;
registerMonitorControlRoutes(app, {
  token: "test-control-token",
  shutdown: () => {
    shutdownCalls += 1;
  },
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

try {
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/monitor/api/control/shutdown`;

  const forbidden = await fetch(url, { method: "POST" });
  assert.equal(forbidden.status, 403);
  assert.equal(shutdownCalls, 0);

  const forwarded = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer test-control-token",
      "x-forwarded-for": "198.51.100.4",
    },
  });
  assert.equal(forwarded.status, 404);
  assert.equal(shutdownCalls, 0);

  const accepted = await fetch(url, {
    method: "POST",
    headers: { authorization: "Bearer test-control-token" },
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { ok: true, state: "stopping" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownCalls, 1);
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

console.log("monitor control tests passed");
