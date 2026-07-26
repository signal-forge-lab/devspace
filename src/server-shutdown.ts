export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections?(): void;
}

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
): Promise<void> {
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  await closeApplication();
  httpServer.closeIdleConnections?.();
  await httpClosed;
}
