import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAoOpenAiApiKeyFromSops } from "./ao-sops-credential.js";

const root = await mkdtemp(join(tmpdir(), "workbridge-ao-sops-test-"));
try {
  const secretDir = join(root, ".config", "sops", "secrets");
  await mkdir(secretDir, { recursive: true });
  await writeFile(join(secretDir, "global.sops.json"), "{}\n", "utf8");

  const secret = await loadAoOpenAiApiKeyFromSops({
    env: {
      ...process.env,
      USERPROFILE: root,
      PATH: process.env.PATH,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
    },
    sopsExecutable: process.execPath,
    runSops: async (_executable, args) => {
      assert.deepEqual(args.slice(0, 3), [
        "decrypt",
        "--extract",
        '["IW_AO_OPENAI_API_KEY"]',
      ]);
      return '"test-secret"\n';
    },
  });
  assert.equal(secret, "test-secret");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("AO SOPS credential tests passed");
