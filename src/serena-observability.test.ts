import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { MonitorLogStream } from "./monitor-log-stream.js";
import { attachSerenaMonitorLogging } from "./serena-observability.js";

const stderr = new PassThrough();
const logs = new MonitorLogStream(10);
const detach = attachSerenaMonitorLogging(stderr, {
  workspaceId: "ws_serena",
  logs,
});

stderr.write("DEBUG 2026-08-10 05:00:00,000 [MainThread] serena.agent:boot:1 - hidden debug\n");
stderr.write("INFO  2026-08-10 05:00:01,000 [MainThread] serena.agent:boot:2 - Serena ready\n");
stderr.write("WARNING 2026-08-10 05:00:02,000 [MainThread] serena.agent:index:3 - Slow inde");
stderr.write("xing\nuv startup note\n");
const ended = once(stderr, "end");
stderr.end("ERROR 2026-08-10 05:00:03,000 [MainThread] serena.agent:call:4 - Tool failed");
await ended;

const entries = logs.snapshot().logs;
assert.equal(entries.length, 4);
assert.deepEqual(entries.map((entry) => entry.status), ["info", "warning", "info", "error"]);
assert.equal(entries[0]?.workspaceId, "ws_serena");
assert.equal(entries[0]?.operation, "Serena");
assert.equal(entries[0]?.summary, "Serena ready");
assert.equal(entries[0]?.details.source, "serena");
assert.equal(entries[0]?.details.logger, "serena.agent:boot:2");
assert.equal(entries[1]?.summary, "Slow indexing");
assert.equal(entries[2]?.summary, "uv startup note");
assert.equal(entries[3]?.summary, "Tool failed");
assert.equal(entries.some((entry) => entry.summary.includes("hidden debug")), false);

detach();
console.log("serena observability tests passed");
