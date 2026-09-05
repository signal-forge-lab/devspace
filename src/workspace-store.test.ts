import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
try {
  const first = new SqliteWorkspaceStore(root);
  first.createSession({ id: "old", root: "/old" });
  first.createSession({ id: "new", root: "/new" });
  first.close();

  const database = openDatabase(root);
  database.sqlite
    .prepare("update workspace_sessions set last_used_at = ? where id = ?")
    .run("2000-01-01T00:00:00.000Z", "old");
  database.close();

  const reopened = new SqliteWorkspaceStore(root, 24 * 60 * 60 * 1_000);
  try {
    assert.equal(reopened.getSession("old"), undefined);
    assert.equal(reopened.getSession("new")?.id, "new");
  } finally {
    reopened.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
