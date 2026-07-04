import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appMetadataFields, getAppMetadata, getRuntimeInfo, runtimeInfoFields } from "./app-metadata.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { name: string; version: string };
const metadata = getAppMetadata();

assert.equal(metadata.appName, packageJson.name);
assert.equal(metadata.displayName, "Workbridge");
assert.equal(metadata.legacyName, "DevSpace");
assert.equal(metadata.appVersion, packageJson.version);
assert.ok(metadata.gitCommit.length > 0);
assert.ok(metadata.gitBranch.length > 0);
assert.ok(metadata.buildSource.length > 0);
assert.deepEqual(appMetadataFields(), metadata);

const runtimeInfo = getRuntimeInfo();
assert.equal(runtimeInfo.displayName, "Workbridge");
assert.equal(runtimeInfo.legacyName, "DevSpace");
assert.equal(runtimeInfo.appVersion, metadata.appVersion);
assert.equal(runtimeInfo.gitCommit, metadata.gitCommit);
assert.ok(runtimeInfo.processStartedAt.length > 0);
assert.ok(runtimeInfo.processId > 0);
assert.ok(runtimeInfo.nodeVersion.startsWith("v"));
assert.ok(runtimeInfo.runtimeDistPath.length > 0);
assert.deepEqual(runtimeInfoFields(), runtimeInfo);
