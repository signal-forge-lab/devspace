export type HttpRequestTerminalOutcome = "finish" | "close" | "aborted";
export type HttpRequestLogOutcome = HttpRequestTerminalOutcome | "stream_cancelled";

export interface HttpRequestLogDisposition {
  outcome: HttpRequestLogOutcome;
  level: "info" | "warn";
  abnormal: boolean;
}

export interface HttpRequestLifecycleRequest {
  readonly aborted: boolean;
  once(event: "aborted", listener: () => void): unknown;
}

export interface HttpRequestLifecycleResponse {
  readonly statusCode: number;
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  readonly writableFinished: boolean;
  readonly destroyed: boolean;
  once(event: "finish" | "close", listener: () => void): unknown;
}

export interface HttpRequestLifecycleResult {
  outcome: HttpRequestTerminalOutcome;
  status: number;
  durationMs: number;
  requestAborted: boolean;
  responseHeadersSent: boolean;
  responseFinished: boolean;
  responseClosed: boolean;
  responseDestroyed: boolean;
}

export function classifyHttpRequestLifecycleForLog(input: {
  method: string;
  path: string;
  lifecycle: HttpRequestLifecycleResult;
}): HttpRequestLogDisposition {
  const { method, path, lifecycle } = input;
  const expectedLongLivedGetCancellation =
    method === "GET"
    && (path === "/mcp" || path === "/monitor/api/logs/stream")
    && lifecycle.outcome === "aborted"
    && lifecycle.status === 200
    && lifecycle.requestAborted
    && lifecycle.responseHeadersSent
    && !lifecycle.responseFinished;

  if (expectedLongLivedGetCancellation) {
    return {
      outcome: "stream_cancelled",
      level: "info",
      abnormal: false,
    };
  }

  if (lifecycle.outcome === "finish") {
    return {
      outcome: "finish",
      level: "info",
      abnormal: false,
    };
  }

  return {
    outcome: lifecycle.outcome,
    level: "warn",
    abnormal: true,
  };
}

export function trackHttpRequestLifecycle(input: {
  request: HttpRequestLifecycleRequest;
  response: HttpRequestLifecycleResponse;
  startedAt: number;
  now?: () => number;
  onTerminal(result: HttpRequestLifecycleResult): void;
}): void {
  const now = input.now ?? (() => performance.now());
  let completed = false;

  const complete = (
    outcome: HttpRequestTerminalOutcome,
    responseClosed: boolean,
  ) => {
    if (completed) return;
    completed = true;
    input.onTerminal({
      outcome,
      status: input.response.statusCode,
      durationMs: Math.max(0, Math.round(now() - input.startedAt)),
      requestAborted: input.request.aborted || outcome === "aborted",
      responseHeadersSent: input.response.headersSent,
      responseFinished: input.response.writableFinished || outcome === "finish",
      responseClosed,
      responseDestroyed: input.response.destroyed,
    });
  };

  input.request.once("aborted", () => complete("aborted", false));
  input.response.once("finish", () => complete("finish", false));
  input.response.once("close", () => {
    if (input.response.writableFinished) return;
    complete(input.request.aborted ? "aborted" : "close", true);
  });

  if (input.request.aborted) complete("aborted", false);
  else if (input.response.writableFinished) complete("finish", false);
  else if (input.response.destroyed) complete("close", true);
}
