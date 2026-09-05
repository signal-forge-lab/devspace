import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PACKAGE_VERSION, SUPPORTED_NODE_RANGE } from "./version.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
  version: string;
  engines: { node: string };
};

assert.equal(PACKAGE_VERSION, packageJson.version);
assert.equal(SUPPORTED_NODE_RANGE, packageJson.engines.node);
