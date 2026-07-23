import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
  version?: unknown;
  engines?: { node?: unknown };
};

export const PACKAGE_VERSION = readRequiredString(packageJson.version, "package version");
export const SUPPORTED_NODE_RANGE = readRequiredString(packageJson.engines?.node, "package engines.node");

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Unable to read ${label}.`);
  }
  return value;
}
