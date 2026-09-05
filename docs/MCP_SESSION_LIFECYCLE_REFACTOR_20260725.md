# MCP Session Lifecycle Refactor — 2026-07-25

## Goal

Separate MCP session orchestration from `server.ts` without changing the fixed
seven-tool surface, request semantics, cleanup policy, or log event names.

## Extracted responsibilities

`src/mcp-session-lifecycle.ts` now owns:

- response `finish` / `close` request release tracking;
- periodic pre-use, one-shot, and idle cleanup;
- cleanup overlap prevention;
- cleanup and shutdown ordering;
- session metrics and pressure warnings;
- close-result logging;
- OpenAI MCP one-shot eligibility detection.

`src/mcp-sessions.ts` remains the state registry and request classification
layer. `src/server.ts` remains responsible for HTTP routing, OAuth, MCP server
construction, and request-specific creation logs.

## Regression coverage

`src/mcp-session-lifecycle.test.ts` adds:

- real Node.js HTTP response `finish` release coverage;
- real Node.js HTTP connection `close` release coverage;
- immediate release when a response has already ended;
- cleanup timer start, unref, idempotence, and shutdown cancellation;
- cleanup coalescing while transport close is pending;
- shutdown waiting for an in-flight cleanup before closing retained sessions;
- OpenAI MCP client classification coverage.

The public MCP tool schema is unchanged. The package version moves to `1.2.0`
because this is an internal architectural milestone rather than a behavior patch.
