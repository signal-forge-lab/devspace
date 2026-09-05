import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export interface PathRedaction {
  path: string;
  replacement: string;
}

export function workspacePathRedactions(workspaceRoot: string | undefined): PathRedaction[] {
  return [
    workspaceRoot ? { path: workspaceRoot, replacement: "<workspace>" } : undefined,
    { path: homedir(), replacement: "~" },
  ].filter((entry): entry is PathRedaction => entry !== undefined && entry.path.trim().length > 0);
}

export function redactPathsInText(text: string, redactions: readonly PathRedaction[] = []): string {
  if (!text || redactions.length === 0) return text;

  let redacted = text;
  for (const redaction of sortedRedactions(redactions)) {
    for (const variant of pathVariants(redaction.path)) {
      redacted = redacted.replace(pathRegex(variant), redaction.replacement);
    }
  }
  return redacted;
}

export function redactPathsInValue<T>(value: T, redactions: readonly PathRedaction[] = []): T {
  if (typeof value === "string") {
    return redactPathsInText(value, redactions) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactPathsInValue(entry, redactions)) as T;
  }
  if (value === null || typeof value !== "object") return value;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactPathsInValue(entry, redactions)]),
  ) as T;
}

function sortedRedactions(redactions: readonly PathRedaction[]): PathRedaction[] {
  return [...redactions].sort((left, right) => right.path.length - left.path.length);
}

function pathVariants(path: string): string[] {
  const resolved = resolve(path);
  const slashResolved = resolved.split(sep).join("/");
  const backslashResolved = resolved.replace(/\//g, "\\");
  const escapedBackslashResolved = backslashResolved.replaceAll("\\", "\\\\");
  return [...new Set([
    path,
    resolved,
    slashResolved,
    backslashResolved,
    escapedBackslashResolved,
  ])]
    .filter((variant) => variant.length > 0);
}

function pathRegex(path: string): RegExp {
  return new RegExp(escapeRegex(path), process.platform === "win32" ? "gi" : "g");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
