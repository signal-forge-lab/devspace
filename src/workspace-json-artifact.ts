import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export async function writeWorkspaceJsonArtifact(
  workspaceRoot: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  const normalized = normalizeArtifactPath(relativePath);
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new Error("Generated artifact value must be JSON serializable.");
  }
  const parts = normalized.split(sep);
  const fileName = parts.pop()!;
  let directory = workspaceRoot;

  for (const part of parts) {
    directory = join(directory, part);
    try {
      const entry = await lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`Artifact parent is not a safe directory: ${part}`);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await mkdir(directory);
      const entry = await lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`Artifact parent is not a safe directory: ${part}`);
      }
    }
  }

  const destination = join(directory, fileName);
  const handle = await open(
    destination,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NO_FOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${serialized}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

function normalizeArtifactPath(value: string): string {
  if (
    !value
    || value.includes("\u0000")
    || isAbsolute(value)
    || value.endsWith("/")
    || value.endsWith("\\")
  ) {
    throw new Error("Generated artifact path must be a non-empty relative path.");
  }
  const normalized = normalize(value);
  const parts = normalized.split(sep);
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
    || parts.includes("..")
    || parts.some((part) => !part || part === ".")
  ) {
    throw new Error("Generated artifact path must stay inside the workspace.");
  }
  return normalized;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
