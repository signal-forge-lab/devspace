import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { satisfies } from "semver";

interface LockfilePackage {
  version?: unknown;
}

interface Lockfile {
  packages?: Record<string, LockfilePackage>;
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
    vulnerableRange: ">=3.0.0 <5.0.7",
    advisories: ["GHSA-3jxr-9vmj-r5cp"],
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
    packageName: "protobufjs",
    vulnerableRange: ">=7.5.0 <7.6.5",
    advisories: ["GHSA-j3f2-48v5-ccww"],
  },
];

const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as Lockfile;
const packages = lockfile.packages ?? {};

for (const guard of guards) {
  const installed = Object.entries(packages).filter(([path]) => packageNameFromLockPath(path) === guard.packageName);
  assert.ok(installed.length > 0, `Expected ${guard.packageName} to be present in package-lock.json.`);

  for (const [path, metadata] of installed) {
    assert.equal(typeof metadata.version, "string", `Expected ${path} to have a version.`);
    const version = metadata.version as string;
    assert.equal(
      satisfies(version, guard.vulnerableRange),
      false,
      `${guard.packageName}@${version} matches ${guard.vulnerableRange} (${guard.advisories.join(", ")}).`,
    );
  }
}

function packageNameFromLockPath(path: string): string | undefined {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  return path.slice(index + marker.length).replaceAll("\\", "/");
}
