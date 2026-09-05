import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveExecutablePath } from "./executable-resolution.js";

export const AO_OPENAI_CREDENTIAL_NAME = "IW_AO_OPENAI_API_KEY";

const SOPS_SECRET_RELATIVE_PATH = [".config", "sops", "secrets", "global.sops.json"] as const;
const SOPS_WINGET_RELATIVE_PATH = [
  "Microsoft",
  "WinGet",
  "Packages",
  "SecretsOPerationS.SOPS_Microsoft.Winget.Source_8wekyb3d8bbwe",
  "sops.exe",
] as const;

export interface AoSopsCredentialOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  sopsExecutable?: string;
  runSops?: (executable: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

export async function loadAoOpenAiApiKeyFromSops(
  options: AoSopsCredentialOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const userProfile = env.USERPROFILE;
  if (!userProfile) {
    throw new Error("USERPROFILE is required to resolve the canonical AO SOPS secret file.");
  }

  const secretFile = join(userProfile, ...SOPS_SECRET_RELATIVE_PATH);
  if (!(await isRegularFile(secretFile))) return undefined;

  const cwd = options.cwd ?? process.cwd();
  const sopsExecutable = options.sopsExecutable ?? await resolveSopsExecutable(cwd, env);
  if (!sopsExecutable) {
    throw new Error("SOPS executable is unavailable for the canonical AO credential store.");
  }

  let extracted: string;
  try {
    extracted = await (options.runSops ?? runSops)(
      sopsExecutable,
      ["decrypt", "--extract", `[\"${AO_OPENAI_CREDENTIAL_NAME}\"]`, secretFile],
      env,
    );
  } catch {
    throw new Error("Failed to read the designated AO credential from the canonical SOPS store.");
  }

  const trimmed = extracted.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    } catch {
      // SOPS may emit a raw scalar rather than JSON; fall through to the raw value.
    }
  }
  return trimmed;
}

async function resolveSopsExecutable(cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const onPath = await resolveExecutablePath("sops", { cwd, env });
  if (onPath) return onPath;
  if (process.platform !== "win32" || !env.LOCALAPPDATA) return undefined;
  const wingetPath = join(env.LOCALAPPDATA, ...SOPS_WINGET_RELATIVE_PATH);
  return await resolveExecutablePath(wingetPath, { cwd, env });
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function runSops(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      env,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
