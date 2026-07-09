import assert from "node:assert/strict";
import { join } from "node:path";
import { redactPathsInText, workspacePathRedactions } from "./path-redaction.js";

const workspaceRoot = join("C:", "Users", "example", "project");
const redactions = [{ path: workspaceRoot, replacement: "<workspace>" }];

assert.equal(
  redactPathsInText(`trace at ${workspaceRoot}`, redactions),
  "trace at <workspace>",
);

assert.equal(
  redactPathsInText("trace at C:/Users/example/project/file.py", redactions),
  "trace at <workspace>/file.py",
);

const currentWorkspaceRedactions = workspacePathRedactions(process.cwd());
assert.equal(
  redactPathsInText(`cwd=${process.cwd()}`, currentWorkspaceRedactions),
  "cwd=<workspace>",
);
