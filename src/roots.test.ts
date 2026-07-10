import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertAllowedPath,
  expandHomePath,
  resolveAllowedPath,
  resolveAllowedRealPath,
} from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/devspace"), resolve(home, "personal", "devspace"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/devspace", [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  assertAllowedPath("~/personal/devspace", ["~/personal"]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\devspace"]),
    /Path is outside allowed roots/,
  );
}

const boundaryRoot = await mkdtemp(join(tmpdir(), "devspace-root-boundary-test-"));
const workspaceRoot = join(boundaryRoot, "workspace");
const outsideRoot = join(boundaryRoot, "outside");

try {
  await mkdir(workspaceRoot);
  await mkdir(outsideRoot);
  await writeFile(join(outsideRoot, "secret.txt"), "outside secret\n", "utf8");
  await mkdir(join(workspaceRoot, "inside"));
  await writeFile(join(workspaceRoot, "inside", "safe.txt"), "safe\n", "utf8");

  const outsideDirectoryLink = join(workspaceRoot, "outside-link");
  await symlink(outsideRoot, outsideDirectoryLink, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    () => resolveAllowedRealPath("outside-link/secret.txt", workspaceRoot, [workspaceRoot]),
    /Path resolves outside allowed roots/,
  );

  await assert.rejects(
    () => resolveAllowedRealPath("outside-link/new.txt", workspaceRoot, [workspaceRoot]),
    /Path resolves outside allowed roots/,
  );

  const insideDirectoryLink = join(workspaceRoot, "inside-link");
  await symlink(join(workspaceRoot, "inside"), insideDirectoryLink, process.platform === "win32" ? "junction" : "dir");

  assert.equal(
    await resolveAllowedRealPath("inside-link/safe.txt", workspaceRoot, [workspaceRoot]),
    join(workspaceRoot, "inside-link", "safe.txt"),
  );

  assert.equal(
    await resolveAllowedRealPath("new-directory/new.txt", workspaceRoot, [workspaceRoot]),
    join(workspaceRoot, "new-directory", "new.txt"),
  );

  assert.equal(
    await resolveAllowedRealPath(join(outsideRoot, "secret.txt"), workspaceRoot, [workspaceRoot, outsideRoot]),
    join(outsideRoot, "secret.txt"),
  );

  if (process.platform !== "win32") {
    const outsideFileLink = join(workspaceRoot, "outside-file.txt");
    await symlink(join(outsideRoot, "secret.txt"), outsideFileLink);
    await assert.rejects(
      () => resolveAllowedRealPath("outside-file.txt", workspaceRoot, [workspaceRoot]),
      /Path resolves outside allowed roots/,
    );
  }
} finally {
  await rm(boundaryRoot, { recursive: true, force: true });
}
