# Workbridge Startup Smoke

Use this checklist after restarting Workbridge, especially after changes to MCP tool
schemas, `workbridge_verify`, workflow event recording, or log analysis.

## Local preflight before restart

Quick local check:

```bash
npm run smoke:startup
```

Full local check with typecheck and workflow-log JSON validation:

```bash
npm run smoke:startup:full
```

Build-inclusive check:

```bash
npm run smoke:startup:build
```

Machine-readable quick report:

```bash
node scripts/smoke-workbridge-runtime.mjs --quick --json
```

The smoke script checks local Git/diff state and prints the MCP checks that still
must be run manually from ChatGPT after restart. It does not call ChatGPT MCP
tools directly.

## Workbridge restart environment

PowerShell example:

```powershell
$env:DEVSPACE_PUBLIC_BASE_URL="https://k6.tailb6f802.ts.net"
$env:DEVSPACE_ENABLE_WORKFLOW_TOOLS="1"
$env:DEVSPACE_ENABLE_ZIP_EXPORT_TOOLS="1"
$env:DEVSPACE_ENABLE_ZIP_IMPORT_TOOLS="1"
$env:DEVSPACE_SKILLS="1"
$env:DEVSPACE_SKILL_PATHS="C:\Users\shogo\Documents\Intelligence Works\github\devspace\skills\workbridge-workflow"
npx @waishnav/devspace serve
```

## Manual MCP checks after restart

1. Confirm `workbridge_verify` is visible in ChatGPT.
2. Run `workbridge_verify` profile `git_status_check` with `workflowMode=router`.
   Expected: `status=ok`, no schema validation error, and `stdoutOmitted=false`.
3. Run `workbridge_verify` profile `git_diff_check`.
   Expected: `status=ok` and no diff-check output.
4. Run `workbridge_verify` profile `build`.
   Expected: `status=ok`, `stdoutOmitted=true`, and only bounded `stderrTail` for
   known build warnings if present.
5. Confirm workflow event recording by running at least one verify profile with
   `workflowMode=router`.
6. Run log report:

```bash
npm run logs:report
```

Expected: `reports/devspace-log-analysis.html` includes Verify Profiles and
Workflow Events sections.

## Failure handling

- `Output validation error` or `Invalid structured content` usually means MCP
  structured output and the declared output schema diverged. Add a regression to
  `src/workbridge-verify.test.ts` or the relevant tool test.
- `spawn EINVAL` for package-manager profiles usually points to Windows/Git Bash
  process spawning behavior. Keep package-manager verify profiles fixed and avoid
  arbitrary shell commands.
- Heredoc, quoting, or large generated-file failures should be recorded as
  workflow events and replaced with structured edit or unified patch workflows.
