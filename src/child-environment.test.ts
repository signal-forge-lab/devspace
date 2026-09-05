import assert from "node:assert/strict";
import {
  buildChildProcessEnvironment,
  parseChildEnvironmentAllowlist,
} from "./child-environment.js";

assert.deepEqual(
  [...parseChildEnvironmentAllowlist("SAFE_ONE, SAFE_TWO;SAFE_THREE invalid-name")],
  ["SAFE_ONE", "SAFE_TWO", "SAFE_THREE"],
);

const environment = buildChildProcessEnvironment({
  source: {
    Path: "C:\\tools",
    HOME: "/home/example",
    COMPUTERNAME: "WORKSTATION",
    DEVSPACE_OAUTH_OWNER_TOKEN: "owner-secret",
    AUTHORIZATION: "Bearer secret",
    GENERAL_API_TOKEN: "hidden-by-default",
    DISCORD_WEBHOOK_URL: "explicitly-needed",
    SAFE_CUSTOM: "allowed-custom",
    DEVSPACE_CHILD_ENV_ALLOWLIST: "DISCORD_WEBHOOK_URL,SAFE_CUSTOM,DEVSPACE_OAUTH_OWNER_TOKEN",
  },
  workspaceId: "workspace-a",
  workspaceRoot: "/workspace/a",
});

assert.equal(environment.Path, "C:\\tools");
assert.equal(environment.HOME, "/home/example");
assert.equal(environment.COMPUTERNAME, "WORKSTATION");
assert.equal(environment.GENERAL_API_TOKEN, undefined);
assert.equal(environment.DISCORD_WEBHOOK_URL, "explicitly-needed");
assert.equal(environment.SAFE_CUSTOM, "allowed-custom");
assert.equal(environment.DEVSPACE_OAUTH_OWNER_TOKEN, undefined);
assert.equal(environment.AUTHORIZATION, undefined);
assert.equal(environment.DEVSPACE_CHILD_ENV_ALLOWLIST, undefined);
assert.equal(environment.DEVSPACE_WORKSPACE_ID, "workspace-a");
assert.equal(environment.DEVSPACE_WORKSPACE_ROOT, "/workspace/a");
assert.equal(environment.NO_COLOR, "1");
assert.equal(environment.TERM, "dumb");
