import assert from "node:assert/strict";
import { runCleanupSteps, shutdownHttpServer } from "./server-shutdown.js";

const cleanupFailure = new Error("cleanup failed");
const cleanupOrder: string[] = [];
await assert.rejects(
  runCleanupSteps([
    () => {
      cleanupOrder.push("first");
      throw cleanupFailure;
    },
    async () => {
      cleanupOrder.push("second");
    },
    () => {
      cleanupOrder.push("third");
    },
  ]),
  cleanupFailure,
);
assert.deepEqual(
  cleanupOrder,
  ["first", "second", "third"],
  "one cleanup failure must not skip later cleanup steps",
);

let finishHttpClose: (() => void) | undefined;
let applicationCloseStarted = false;
const phases: string[] = [];

const drainingHttpServer = {
  close(callback: (error?: Error) => void) {
    finishHttpClose = () => callback();
  },
};

const drainingShutdown = shutdownHttpServer(drainingHttpServer, async () => {
  applicationCloseStarted = true;
  assert.ok(
    finishHttpClose,
    "HTTP draining must start before application cleanup",
  );
  finishHttpClose();
}, (phase) => phases.push(phase));

await Promise.resolve();
assert.equal(
  applicationCloseStarted,
  true,
  "application cleanup must start while the HTTP server is draining",
);
await drainingShutdown;
assert.deepEqual(phases.sort(), ["application_closed", "http_closed"]);

let idleConnectionsClosed = false;
await shutdownHttpServer(
  {
    close(callback: (error?: Error) => void) {
      setImmediate(() => callback());
    },
    closeIdleConnections() {
      idleConnectionsClosed = true;
    },
  },
  async () => {},
);
assert.equal(
  idleConnectionsClosed,
  true,
  "idle keep-alive connections must close after application cleanup",
);

let finishApplicationClose: (() => void) | undefined;
let shutdownResolved = false;

const immediatelyClosedHttpServer = {
  close(callback: (error?: Error) => void) {
    callback();
  },
};

const delayedApplicationClose = () =>
  new Promise<void>((resolve) => {
    finishApplicationClose = resolve;
  });

const delayedShutdown = shutdownHttpServer(
  immediatelyClosedHttpServer,
  delayedApplicationClose,
);
void delayedShutdown.then(() => {
  shutdownResolved = true;
});

await Promise.resolve();
assert.equal(
  shutdownResolved,
  false,
  "shutdown must wait for asynchronous application cleanup",
);
finishApplicationClose?.();
await delayedShutdown;
assert.equal(shutdownResolved, true);

let finishDelayedHttpClose: (() => void) | undefined;
let httpDrainResolved = false;
const delayedHttpDrain = shutdownHttpServer(
  {
    close(callback: (error?: Error) => void) {
      finishDelayedHttpClose = () => callback();
    },
  },
  async () => {},
);
void delayedHttpDrain.then(() => {
  httpDrainResolved = true;
});

await Promise.resolve();
assert.equal(
  httpDrainResolved,
  false,
  "shutdown must wait for active HTTP responses to drain",
);
finishDelayedHttpClose?.();
await delayedHttpDrain;
assert.equal(httpDrainResolved, true);

const httpCloseError = new Error("http close failed");
await assert.rejects(
  shutdownHttpServer(
    {
      close(callback: (error?: Error) => void) {
        callback(httpCloseError);
      },
    },
    async () => {},
  ),
  httpCloseError,
);
