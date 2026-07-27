from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    content = file_path.read_text(encoding="utf-8")
    if content.count(old) != 1:
        raise SystemExit(f"expected block in {path} was not found exactly once")
    file_path.write_text(content.replace(old, new), encoding="utf-8")


replace_once(
    "src/cli.ts",
    '''  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  registerMonitorControlRoutes(app, {
    token: process.env.WORKBRIDGE_MONITOR_CONTROL_TOKEN,
    shutdown,
  });
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
''',
    '''  httpServer.ref();

  await new Promise<void>((resolveServe, rejectServe) => {
    let shuttingDown = false;
    let handleShutdown: () => void;
    const removeShutdownHandlers = () => {
      process.removeListener("SIGINT", handleShutdown);
      process.removeListener("SIGTERM", handleShutdown);
    };
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await shutdownHttpServer(httpServer, close);
        resolveServe();
      } catch (error) {
        rejectServe(error);
      } finally {
        removeShutdownHandlers();
      }
    };
    handleShutdown = () => {
      void shutdown();
    };
    registerMonitorControlRoutes(app, {
      token: process.env.WORKBRIDGE_MONITOR_CONTROL_TOKEN,
      shutdown,
    });
    process.once("SIGINT", handleShutdown);
    process.once("SIGTERM", handleShutdown);
  });
''',
)

replace_once(
    "package.json",
    '    "build": "npm run clean && tsc -p tsconfig.build.json",\n',
    '    "build": "npm run clean && tsc -p tsconfig.build.json",\n'
    '    "test:serve-lifecycle": "node scripts/cli-serve-smoke.mjs",\n',
)
replace_once(
    "package.json",
    '    "verify:rebase": "npm run typecheck && npm run lint && npm run baseline:tools:check && npm test && npm run build && git diff --check"\n',
    '    "verify:rebase": "npm run typecheck && npm run lint && npm run baseline:tools:check && npm test && npm run build && npm run test:serve-lifecycle && git diff --check"\n',
)

for temporary_path in (
    ".github/workflows/workbridge-cli-lifecycle-fix.yml",
    ".github/workflows/workbridge-cli-lifecycle-fix-pr.yml",
    "scripts/apply-cli-lifecycle-fix.py",
):
    Path(temporary_path).unlink(missing_ok=True)
