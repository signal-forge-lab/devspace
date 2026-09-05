export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections?(): void;
}

export type ShutdownHttpServerPhase = "application_closed" | "http_closed";

export async function runCleanupSteps(
  steps: ReadonlyArray<() => void | Promise<void>>,
): Promise<void> {
  let failed = false;
  let firstError: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
}

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
  onPhase?: (phase: ShutdownHttpServerPhase) => void,
): Promise<void> {
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  }).then(() => onPhase?.("http_closed"));

  await closeApplication();
  onPhase?.("application_closed");
  httpServer.closeIdleConnections?.();
  await httpClosed;
}
