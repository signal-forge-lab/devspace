import { loadConfig } from "./config.js";
import {
  armLocalActionTrigger,
  loadLocalActionTriggerManifest,
  parseLocalActionTriggerCommandArgs,
  parseLocalActionTriggerWorkerArgs,
  resolveLocalActionTrigger,
  runLocalActionTriggerWorker,
} from "./local-action-trigger.js";
import { loadWindowsLocalActionTriggerConfigSnapshot } from "./local-action-trigger-windows.js";
import {
  parseManagedRestartWorkerArgs,
  runManagedRestartWorker,
  scheduleManagedRestart,
} from "./managed-restart.js";
import { SoftPauseController } from "./soft-pause.js";
import { PACKAGE_VERSION } from "./version.js";

export type WorkbridgeCliCommand =
  | "control"
  | "action_trigger"
  | "managed_restart_worker"
  | "local_action_trigger_worker";

export const WORKBRIDGE_CLI_HELP_LINES = [
  "  devspace control pause [--reason <text>]  Request a non-blocking pause",
  "  devspace control resume                  Clear a pending soft pause",
  "  devspace control status                  Show soft-pause state",
  "  devspace control restart                 Restart Workbridge and Session Monitor",
  "  devspace action-trigger dry-run --manifest <path> --manifest-sha256 <sha256>",
  "  devspace action-trigger arm --manifest <path> --manifest-sha256 <sha256>",
  "  Restarting Workbridge clears a pending soft pause automatically",
] as const;

export function normalizeWorkbridgeCliCommand(
  command: string | undefined,
): WorkbridgeCliCommand | undefined {
  if (command === "control") return "control";
  if (command === "action-trigger") return "action_trigger";
  if (command === "__managed-restart-worker") return "managed_restart_worker";
  if (command === "__local-action-trigger-worker") return "local_action_trigger_worker";
  return undefined;
}

export function workbridgeCliCommandRequiresConfiguration(command: WorkbridgeCliCommand): boolean {
  return command === "control" || command === "action_trigger";
}

export async function runWorkbridgeCliCommand(
  command: WorkbridgeCliCommand,
  args: string[],
  currentCliPath: string,
): Promise<void> {
  switch (command) {
    case "control":
      await runControlCommand(args, currentCliPath);
      return;
    case "action_trigger":
      await runLocalActionTriggerCommand(args, currentCliPath);
      return;
    case "managed_restart_worker":
      await runManagedRestartWorker(parseManagedRestartWorkerArgs(args));
      return;
    case "local_action_trigger_worker": {
      const parsed = parseLocalActionTriggerWorkerArgs(args);
      const config = parsed.configSnapshotPath
        ? await loadWindowsLocalActionTriggerConfigSnapshot(
            parsed.configSnapshotPath,
            parsed.configSnapshotSha256 ?? "",
          )
        : loadConfig();
      const result = await runLocalActionTriggerWorker({ ...parsed, config });
      if (result.status !== "completed") process.exitCode = 1;
    }
  }
}

async function runControlCommand(args: string[], currentCliPath: string): Promise<void> {
  const [subcommand, ...rest] = args;
  const config = loadConfig();
  const controller = new SoftPauseController(config.stateDir);

  switch (subcommand) {
    case "pause":
    case "request": {
      const state = controller.request(parseReason(rest));
      console.log("Workbridge soft pause requested.");
      console.log(`Requested at: ${state.requestedAt}`);
      if (state.reason) console.log(`Reason: ${state.reason}`);
      console.log("Tools remain available; hosts are asked to stop at a convenient safe point.");
      return;
    }
    case "status": {
      const state = controller.status();
      if (!state) {
        console.log("Workbridge soft pause: inactive");
        return;
      }
      console.log("Workbridge soft pause: requested");
      console.log(`Requested at: ${state.requestedAt}`);
      if (state.reason) console.log(`Reason: ${state.reason}`);
      return;
    }
    case "resume": {
      const cleared = controller.clear();
      console.log(cleared ? "Workbridge soft pause cleared." : "Workbridge soft pause already inactive.");
      return;
    }
    case "restart": {
      const scheduled = await scheduleManagedRestart({
        currentCliPath,
        expectedVersion: PACKAGE_VERSION,
        monitorUrl: `http://127.0.0.1:${config.monitorPort}`,
      });
      console.log("Workbridge managed restart scheduled.");
      console.log(`Helper PID: ${scheduled.pid ?? "unknown"}`);
      console.log(`Progress log: ${scheduled.logFile}`);
      return;
    }
    default:
      throw new Error("Usage: devspace control <pause|resume|status|restart> [--reason <text>]");
  }
}

function parseReason(args: string[]): string | undefined {
  const reasonIndex = args.indexOf("--reason");
  if (reasonIndex === -1) return args.join(" ").trim() || undefined;
  const reason = args.slice(reasonIndex + 1).join(" ").trim();
  if (!reason) throw new Error("Missing value after --reason.");
  return reason;
}

async function runLocalActionTriggerCommand(args: string[], currentCliPath: string): Promise<void> {
  const parsed = parseLocalActionTriggerCommandArgs(args);
  const config = loadConfig();
  if (parsed.mode === "arm") {
    const armed = await armLocalActionTrigger({
      currentCliPath,
      ...parsed,
      config,
    });
    console.log(JSON.stringify({ status: "armed", ...armed }, null, 2));
    return;
  }

  const loaded = await loadLocalActionTriggerManifest({ ...parsed, config });
  const resolution = await resolveLocalActionTrigger({ loaded, config });
  console.log(JSON.stringify({
    status: "dry_run",
    triggerId: loaded.manifest.triggerId,
    manifestSha256: loaded.manifestSha256,
    action: resolution.resolved.action,
    preset: resolution.resolved.preset,
    profile: resolution.resolved.profile,
    commandSha256: resolution.commandSha256,
    processStarted: false,
  }, null, 2));
}
