# Workbridge Production Dependency Security Review — 2026-07-25

## Scope

This review covers the production dependency findings reported by:

```text
npm audit --omit=dev
```

The review does not use `npm audit fix --force`. That command proposes dependency
downgrades across the MCP SDK and Pi coding-agent boundary and is not an acceptable
substitute for compatibility analysis.

## Remediated findings

The following packages are pinned to non-vulnerable versions through npm
`overrides`. All selected versions remain inside the parent dependency's declared
major-version range.

| Package | Selected version | Advisory |
| --- | ---: | --- |
| `body-parser` | `2.3.0` | `GHSA-v422-hmwv-36x6` |
| `fast-uri` | `3.1.4` | `GHSA-v2hh-gcrm-f6hx`, `GHSA-4c8g-83qw-93j6` |
| `hono` | `4.12.32` | `GHSA-xgm2-5f3f-mvvc`, `GHSA-hvrm-45r6-mjfj`, `GHSA-w62v-xxxg-mg59` |

`@earendil-works/pi-coding-agent` is updated from `0.80.3` to `0.82.0`.
The published Pi package includes its own npm shrinkwrap, so Workbridge-level
overrides cannot safely replace its nested dependencies. Pi `0.81.0` updated
`brace-expansion` to `5.0.7`, and Pi `0.82.0` updated `protobufjs` to `7.6.5`.

| Package inside Pi shrinkwrap | Selected version | Advisory |
| --- | ---: | --- |
| `brace-expansion` | `5.0.7` | `GHSA-3jxr-9vmj-r5cp` |
| `protobufjs` | `7.6.5` | `GHSA-j3f2-48v5-ccww` |

`src/dependency-security.test.ts` checks every occurrence in `package-lock.json`
and fails the normal test suite if one of the reviewed vulnerable ranges returns.

## Accepted upstream finding

### `@hono/node-server < 2.0.5`

Advisory: `GHSA-frvp-7c67-39w9`

The finding concerns the `@hono/node-server/serve-static` implementation on
Windows. Workbridge does not import or register that middleware. Workbridge uses
`StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`, whose Node.js
adapter imports `getRequestListener` from the package root.

The current MCP SDK declares `@hono/node-server ^1.19.9`. The fixed line is 2.x,
which crosses the SDK's declared major-version boundary. Workbridge therefore
does not force a 2.x override in this patch. The remaining audit entries inherited
through the MCP SDK, Ext Apps, Claude SDK, Google GenAI, and Pi packages are
tracked as one upstream risk, not as separate Workbridge execution paths.

An isolated compatibility smoke test confirmed that MCP SDK `1.29.0` can create
and close `StreamableHTTPServerTransport` with `@hono/node-server 2.0.11` forced
through an override. This is not sufficient evidence to replace the SDK's
declared 1.x dependency in production; request-level and future SDK compatibility
remain unsupported by upstream.

## Result after remediation

```text
critical: 0
high:     0
moderate: 8
low:      0
```

All eight moderate entries are dependency-chain projections of
`GHSA-frvp-7c67-39w9`. They do not represent eight distinct vulnerable
Workbridge paths.

Release acceptance requires:

- no high or critical production findings;
- the accepted moderate finding remains limited to the unused `serve-static`
  path;
- MCP SDK updates are rechecked for a declared `@hono/node-server` 2.x range.

Use the following release check:

```text
npm run audit:prod:high
```

## Follow-up advisory discovered after the 1.1.7 review

`GHSA-mh99-v99m-4gvg` subsequently marked `brace-expansion <=5.0.7` as high
severity. The fixed package is `5.0.8`, but Pi `0.82.0` still ships a generated
shrinkwrap that pins `5.0.7`.

The following Workbridge-side approaches were tested and rejected because the
Pi shrinkwrap continued to install `5.0.7`:

- a global npm override;
- a Pi-scoped override;
- a Pi/minimatch-scoped override;
- adding a direct `brace-expansion 5.0.8` dependency followed by `npm dedupe`;
- editing only the Workbridge root lockfile entry.

The root-lockfile edit was specifically rejected because `npm ci` installed
`5.0.7` while leaving the edited root lockfile at `5.0.8`, producing an invalid
lock/runtime mismatch. Workbridge does not add a postinstall mutation or a
custom audit exception merely to hide this result.

Current status:

```text
critical: 0
high:     1
moderate: 8
low:      0
```

The high finding remains an upstream dependency blocker until Pi publishes a
shrinkwrap containing `brace-expansion >=5.0.8`, or Workbridge replaces the Pi
backend through a separately reviewed architectural change.
