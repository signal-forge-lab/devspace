import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  LEGACY_CLI_NAME,
  LEGACY_OAUTH_SCOPE,
  LEGACY_PACKAGE_NAME,
  LEGACY_SERVICE_NAME,
  PRODUCT_DISPLAY_NAME,
} from "./branding.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
  name?: unknown;
  bin?: Record<string, unknown>;
};

assert.equal(PRODUCT_DISPLAY_NAME, "Workbridge");
assert.equal(LEGACY_SERVICE_NAME, "devspace");
assert.equal(LEGACY_PACKAGE_NAME, "@waishnav/devspace");
assert.equal(LEGACY_CLI_NAME, "devspace");
assert.equal(LEGACY_OAUTH_SCOPE, "devspace");
assert.equal(packageJson.name, LEGACY_PACKAGE_NAME);
assert.equal(packageJson.bin?.[LEGACY_CLI_NAME], "dist/cli.js");

const displayNameRuntimeFiles = [
  "cli.ts",
  "config.ts",
  "local-agent-adapters.ts",
  "logger.ts",
  "oauth-provider.ts",
  "oauth-store.ts",
  "review-checkpoints.ts",
  "server.ts",
  "ui/workspace-app.html",
];

for (const relativePath of displayNameRuntimeFiles) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bDevSpace\b/, `${relativePath} still contains a user-visible DevSpace name`);
}
