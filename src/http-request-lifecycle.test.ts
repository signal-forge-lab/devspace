import assert from "node:assert/strict";
import {
  classifyHttpRequestLifecycleForLog,
  trackHttpRequestLifecycle,
  type HttpRequestLifecycleResult,
} from "./http-request-lifecycle.js";

class FakeRequest {
  aborted = false;
  private readonly listeners: Array<() => void> = [];

  once(event: "aborted", listener: () => void): void {
    assert.equal(event, "aborted");
    this.listeners.push(listener);
  }

  abort(): void {
    this.aborted = true;
    for (const listener of this.listeners.splice(0)) listener();
  }
}

class FakeResponse {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  private readonly finishListeners: Array<() => void> = [];
  private readonly closeListeners: Array<() => void> = [];

  once(event: "finish" | "close", listener: () => void): void {
    (event === "finish" ? this.finishListeners : this.closeListeners).push(listener);
  }

  finish(): void {
    this.headersSent = true;
    this.writableEnded = true;
    this.writableFinished = true;
    for (const listener of this.finishListeners.splice(0)) listener();
  }

  close(): void {
    this.destroyed = true;
    for (const listener of this.closeListeners.splice(0)) listener();
  }
}

testFinishWinsOverSubsequentClose();
testPrematureCloseIsReported();
testAbortIsReportedOnce();
testAlreadyDestroyedResponseIsReportedImmediately();
testExpectedMcpGetCancellationIsInformational();
testExpectedMonitorStreamCancellationIsInformational();
testPostAbortRemainsWarning();
testGetAbortBeforeHeadersRemainsWarning();
testOtherGetAbortRemainsWarning();

console.log("http request lifecycle tests passed");

function testFinishWinsOverSubsequentClose(): void {
  const request = new FakeRequest();
  const response = new FakeResponse();
  const results: HttpRequestLifecycleResult[] = [];
  let now = 10;
  trackHttpRequestLifecycle({
    request,
    response,
    startedAt: 0,
    now: () => now,
    onTerminal: (result) => results.push(result),
  });

  now = 25;
  response.finish();
  response.close();

  assert.deepEqual(results, [{
    outcome: "finish",
    status: 200,
    durationMs: 25,
    requestAborted: false,
    responseHeadersSent: true,
    responseFinished: true,
    responseClosed: false,
    responseDestroyed: false,
  }]);
}

function testPrematureCloseIsReported(): void {
  const request = new FakeRequest();
  const response = new FakeResponse();
  response.statusCode = 503;
  response.headersSent = true;
  const results: HttpRequestLifecycleResult[] = [];
  trackHttpRequestLifecycle({
    request,
    response,
    startedAt: 100,
    now: () => 145,
    onTerminal: (result) => results.push(result),
  });

  response.close();
  assert.deepEqual(results, [{
    outcome: "close",
    status: 503,
    durationMs: 45,
    requestAborted: false,
    responseHeadersSent: true,
    responseFinished: false,
    responseClosed: true,
    responseDestroyed: true,
  }]);
}

function testAbortIsReportedOnce(): void {
  const request = new FakeRequest();
  const response = new FakeResponse();
  const results: HttpRequestLifecycleResult[] = [];
  trackHttpRequestLifecycle({
    request,
    response,
    startedAt: 200,
    now: () => 275,
    onTerminal: (result) => results.push(result),
  });

  request.abort();
  response.close();
  assert.deepEqual(results, [{
    outcome: "aborted",
    status: 200,
    durationMs: 75,
    requestAborted: true,
    responseHeadersSent: false,
    responseFinished: false,
    responseClosed: false,
    responseDestroyed: false,
  }]);
}

function testAlreadyDestroyedResponseIsReportedImmediately(): void {
  const request = new FakeRequest();
  const response = new FakeResponse();
  response.destroyed = true;
  const results: HttpRequestLifecycleResult[] = [];
  trackHttpRequestLifecycle({
    request,
    response,
    startedAt: 300,
    now: () => 310,
    onTerminal: (result) => results.push(result),
  });

  assert.equal(results[0]?.outcome, "close");
  assert.equal(results[0]?.responseClosed, true);
}

function testExpectedMcpGetCancellationIsInformational(): void {
  const lifecycle: HttpRequestLifecycleResult = {
    outcome: "aborted",
    status: 200,
    durationMs: 2_000,
    requestAborted: true,
    responseHeadersSent: true,
    responseFinished: false,
    responseClosed: false,
    responseDestroyed: false,
  };

  assert.deepEqual(
    classifyHttpRequestLifecycleForLog({ method: "GET", path: "/mcp", lifecycle }),
    { outcome: "stream_cancelled", level: "info", abnormal: false },
  );
}

function testExpectedMonitorStreamCancellationIsInformational(): void {
  const lifecycle: HttpRequestLifecycleResult = {
    outcome: "aborted",
    status: 200,
    durationMs: 5_714_093,
    requestAborted: true,
    responseHeadersSent: true,
    responseFinished: false,
    responseClosed: false,
    responseDestroyed: false,
  };

  assert.deepEqual(
    classifyHttpRequestLifecycleForLog({
      method: "GET",
      path: "/monitor/api/logs/stream",
      lifecycle,
    }),
    { outcome: "stream_cancelled", level: "info", abnormal: false },
  );
}

function testPostAbortRemainsWarning(): void {
  const lifecycle: HttpRequestLifecycleResult = {
    outcome: "aborted",
    status: 200,
    durationMs: 250,
    requestAborted: true,
    responseHeadersSent: true,
    responseFinished: false,
    responseClosed: false,
    responseDestroyed: false,
  };

  assert.deepEqual(
    classifyHttpRequestLifecycleForLog({ method: "POST", path: "/mcp", lifecycle }),
    { outcome: "aborted", level: "warn", abnormal: true },
  );
}

function testGetAbortBeforeHeadersRemainsWarning(): void {
  const lifecycle: HttpRequestLifecycleResult = {
    outcome: "aborted",
    status: 200,
    durationMs: 10,
    requestAborted: true,
    responseHeadersSent: false,
    responseFinished: false,
    responseClosed: false,
    responseDestroyed: false,
  };

  assert.deepEqual(
    classifyHttpRequestLifecycleForLog({ method: "GET", path: "/mcp", lifecycle }),
    { outcome: "aborted", level: "warn", abnormal: true },
  );
}

function testOtherGetAbortRemainsWarning(): void {
  const lifecycle: HttpRequestLifecycleResult = {
    outcome: "aborted",
    status: 200,
    durationMs: 1_000,
    requestAborted: true,
    responseHeadersSent: true,
    responseFinished: false,
    responseClosed: false,
    responseDestroyed: false,
  };

  assert.deepEqual(
    classifyHttpRequestLifecycleForLog({ method: "GET", path: "/other-stream", lifecycle }),
    { outcome: "aborted", level: "warn", abnormal: true },
  );
}
