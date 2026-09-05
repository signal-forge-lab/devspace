import { loadDevspaceFiles, type DevspaceFiles } from "./user-config.js";

export type WorkbridgeConfigSource =
  | "environment"
  | "config.jsonc"
  | "auth.json"
  | "default"
  | "derived"
  | "missing";

export interface WorkbridgeConfigProvenance {
  publicBaseUrl: WorkbridgeConfigSource;
  allowedRoots: WorkbridgeConfigSource;
  auxiliaryRoots: WorkbridgeConfigSource;
  worktreeRoot: WorkbridgeConfigSource;
  stateDir: WorkbridgeConfigSource;
  trustProxy: WorkbridgeConfigSource;
  oauthOwnerToken: WorkbridgeConfigSource;
  oauthClientRegistrationKey: WorkbridgeConfigSource;
}

export function configProvenance(
  env: NodeJS.ProcessEnv = process.env,
  files: DevspaceFiles = loadDevspaceFiles(env),
): WorkbridgeConfigProvenance {
  const ownerSource = sourceFor(
    env.DEVSPACE_OAUTH_OWNER_TOKEN,
    files.auth.ownerToken,
    "auth.json",
    "missing",
  );
  return {
    publicBaseUrl: sourceFor(env.DEVSPACE_PUBLIC_BASE_URL, files.config.server.publicBaseUrl, "config.jsonc", "derived"),
    allowedRoots: sourceFor(env.DEVSPACE_ALLOWED_ROOTS, files.config.workspaces.allowedRoots, "config.jsonc", "default"),
    auxiliaryRoots: sourceFor(env.WORKBRIDGE_AUXILIARY_ROOTS, files.config.workspaces.auxiliaryRoots, "config.jsonc", "default"),
    worktreeRoot: sourceFor(env.DEVSPACE_WORKTREE_ROOT, files.config.workspaces.worktreeRoot, "config.jsonc", "derived"),
    stateDir: sourceFor(env.DEVSPACE_STATE_DIR, files.config.storage.stateDir, "config.jsonc", "default"),
    trustProxy: sourceFor(env.DEVSPACE_TRUST_PROXY, files.config.server.trustProxy, "config.jsonc", "default"),
    oauthOwnerToken: ownerSource,
    oauthClientRegistrationKey: env.DEVSPACE_OAUTH_CLIENT_REGISTRATION_KEY !== undefined
      ? "environment"
      : files.auth.clientRegistrationKey !== undefined
        ? "auth.json"
        : ownerSource === "missing" ? "missing" : "derived",
  };
}

function sourceFor(
  environmentValue: unknown,
  fileValue: unknown,
  fileSource: "config.jsonc" | "auth.json",
  fallback: "default" | "derived" | "missing",
): WorkbridgeConfigSource {
  if (environmentValue !== undefined) return "environment";
  if (fileValue !== undefined && fileValue !== null) return fileSource;
  return fallback;
}
