import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { satisfies } from "semver";
import { parse } from "yaml";

interface Lockfile {
  packages?: Record<string, unknown>;
}

interface AdvisoryGuard {
  packageName: string;
  vulnerableRange: string;
  advisories: readonly string[];
}

const guards: readonly AdvisoryGuard[] = [
  {
    packageName: "body-parser",
    vulnerableRange: ">=2.0.0 <2.3.0",
    advisories: ["GHSA-v422-hmwv-36x6"],
  },
  {
    packageName: "brace-expansion",
    vulnerableRange: ">=3.0.0 <5.0.9",
    advisories: ["GHSA-3jxr-9vmj-r5cp", "GHSA-mh99-v99m-4gvg", "GHSA-rgw5-rvv9-x895"],
  },
  {
    packageName: "undici",
    vulnerableRange: ">=8.0.0 <8.9.0",
    advisories: [
      "GHSA-8xcm-r25x-g524",
      "GHSA-4cwx-7wf7-3272",
      "GHSA-m8rv-5g2x-5cg5",
      "GHSA-jr45-8vmc-qm54",
      "GHSA-v3r7-h72x-cjcm",
    ],
  },
  {
    packageName: "fast-uri",
    vulnerableRange: ">=3.0.0 <3.1.4",
    advisories: ["GHSA-v2hh-gcrm-f6hx", "GHSA-4c8g-83qw-93j6"],
  },
  {
    packageName: "hono",
    vulnerableRange: ">=4.0.0 <4.12.27",
    advisories: [
      "GHSA-xgm2-5f3f-mvvc",
      "GHSA-hvrm-45r6-mjfj",
      "GHSA-w62v-xxxg-mg59",
    ],
  },
  {
    packageName: "@hono/node-server",
    vulnerableRange: "<2.0.5",
    advisories: ["GHSA-frvp-7c67-39w9"],
  },
  {
    packageName: "postcss",
    vulnerableRange: "<=8.5.17",
    advisories: ["GHSA-r28c-9q8g-f849"],
  },
  {
    packageName: "protobufjs",
    vulnerableRange: ">=7.5.0 <7.6.5",
    advisories: ["GHSA-j3f2-48v5-ccww"],
  },
];

const lockfile = parse(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8")) as Lockfile;
const packages = lockfile.packages ?? {};

for (const guard of guards) {
  const installed = Object.keys(packages)
    .map((key) => ({ key, version: packageVersionFromPnpmKey(key, guard.packageName) }))
    .filter((entry): entry is { key: string; version: string } => entry.version !== undefined);
  assert.ok(installed.length > 0, `Expected ${guard.packageName} to be present in pnpm-lock.yaml.`);

  for (const { key, version } of installed) {
    assert.equal(
      satisfies(version, guard.vulnerableRange),
      false,
      `${key} matches ${guard.vulnerableRange} (${guard.advisories.join(", ")}).`,
    );
  }
}

function packageVersionFromPnpmKey(key: string, packageName: string): string | undefined {
  const prefix = `${packageName}@`;
  if (!key.startsWith(prefix)) return undefined;
  const version = key.slice(prefix.length).split("(", 1)[0];
  return version || undefined;
}
