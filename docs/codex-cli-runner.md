# Codex CLI Runner MCP Tool

> 日本語版: [codex-cli-runner.ja.md](./codex-cli-runner.ja.md)

Workbridge now exposes `run_codex_cli`, a ChatGPT-facing MCP tool that calls the local Python wrapper:

```text
C:\path\to\your\workspace\labs\codex_cli_runner\run_codex.py
```

This is intentionally **not** a Codex Skill. It is registered as a Workbridge MCP tool, so it is visible to ChatGPT clients connected to this Workbridge server. Do not place this workflow under `.agents/skills` or `$HOME/.agents/skills` unless you also want Codex to discover it as a Codex Skill.

## Tool name

```text
run_codex_cli
```

## Inputs

- `projectDir`: target project directory for Codex CLI. Must be inside Workbridge allowed roots.
- `instructionFile`: Markdown instruction file. Absolute path or relative path.
- `sandbox`: optional. `read-only` or `workspace-write`. Defaults to `read-only`.
- `mode`: optional. `sync` or `detached`. Defaults to `sync`.
- `model`: optional. Codex model passed to the Python runner. Defaults to `gpt-5.5`.
- `serviceTier`: optional. `standard` or `fast`. Defaults to `standard`.
- `reasoningEffort`: optional. `minimal`, `low`, `medium`, `high`, or `xhigh`. Defaults to `xhigh`.
- `dryRun`: optional. If true, validate and show the command without running Codex. In `detached` mode this does not open a console.
- `json`: optional. If true, pass `--json` to the Python runner.
- `timeout`: optional. Seconds for `sync` mode. Defaults to 900, max 3600.
- `earlyWaitSeconds`: optional. Seconds for `detached` early monitoring. Defaults to `DEVSPACE_CODEX_EARLY_WAIT_SECONDS` or 10, max 300.
- `maxOutputCharacters`: optional. Maximum stdout/stderr characters returned in the MCP response.
- `maxFallbackPromptCharacters`: optional. Maximum instruction Markdown characters returned as `fallbackPrompt` when Codex fails with a limit-related error. Defaults to 120000.

`danger-full-access` is intentionally unsupported.

By default, Workbridge passes these options to the Python runner:

```text
--model gpt-5.5
--service-tier standard
--reasoning-effort xhigh
```

The Python runner then turns those into Codex CLI options:

```text
--model gpt-5.5
-c service_tier="standard"
-c features.fast_mode=false
-c model_reasoning_effort="xhigh"
```

## Execution modes

### `sync`

`sync` mode waits for the Python wrapper to finish. It returns `completed`, `failed`, `limit_error`, `timeout`, or `launch_error` based on the final process result.

### `detached`

`detached` mode creates a job directory under:

```text
<ProjectDir>\.codex\runs\devspace_codex_<jobId>\
```

It then opens a separate local console and runs Codex there. The MCP call only waits for the early monitoring window.

The detached process writes:

- `status.json`
- `codex_combined.log`
- `launch-codex.ps1` or `launch-codex.sh`

On Windows, the launcher writes `status.json` and `codex_combined.log` as UTF-8 without BOM. The reader also tolerates UTF-8 BOM and UTF-16LE logs so early Codex errors are not missed because of PowerShell encoding behavior.

If no early error is detected before `earlyWaitSeconds` expires, the tool returns:

```text
status=started_running
```

This means Codex was launched and may still be running in its own console. It does **not** mean Codex has completed successfully.

If a limit-related error is detected during the early window, the tool returns `status=limit_error`, `errorKind=codex_limit`, and `fallbackPrompt`. If the detached status file reports `failed`, the tool returns `limit_error` when the log indicates a limit error, otherwise `early_error`; it should not return `started_running` after a known failure.

## Instruction path resolution

Relative `instructionFile` values are resolved in this order:

1. `projectDir`
2. Workbridge server working directory
3. `run_codex.py` directory

The resolved instruction file must exist, be inside allowed roots, and end with `.md`.

## Runner path resolution

By default, the tool searches for the Python runner at:

```text
<Workbridge server cwd>\labs\codex_cli_runner\run_codex.py
<Workbridge server cwd>\..\..\labs\codex_cli_runner\run_codex.py
```

You can override the path with:

```text
DEVSPACE_CODEX_CLI_RUNNER=C:\path\to\your\workspace\labs\codex_cli_runner\run_codex.py
```

The resolved runner must exist and be inside Workbridge allowed roots.

## Python command

The default Python command is:

```text
python
```

You can override it with:

```text
DEVSPACE_PYTHON_COMMAND=python
```

## Recommended first call

Use dry-run first:

```json
{
  "projectDir": "C:\\path\\to\\your\\workspace\\your-project",
  "instructionFile": "tasks\\periodic_review.md",
  "sandbox": "read-only",
  "mode": "detached",
  "dryRun": true
}
```

Then execute without `dryRun` only after the command looks correct.

## Output

The tool returns:

- `status`
- `exitCode`
- `timedOut`
- `errorKind`
- `nextAction`
- `fallbackRecommended`
- `fallbackPrompt`
- `fallbackPromptSource`
- `fallbackPromptTruncated`
- `projectDir`
- `instructionFile`
- `runnerPath`
- `sandbox`
- `mode`
- `model`
- `serviceTier`
- `reasoningEffort`
- `dryRun`
- `jobId`
- `earlyWaitSeconds`
- `outputFile`
- `logFile`
- `instructionCopyFile`
- `statusFile`
- `combinedLogFile`
- `launcherFile`
- `stdout`
- `stderr`
- `command`
- `launchCommand`

The underlying Python runner writes Codex results under:

```text
<ProjectDir>\.codex\runs\
```

Detached mode additionally writes Workbridge job files under its own `devspace_codex_<jobId>` run directory.

## Limit fallback behavior

If Codex fails with a limit-related error, the tool sets:

```text
status=limit_error
errorKind=codex_limit
nextAction=continue_in_chatgpt
fallbackRecommended=true
```

In that case, the tool returns the resolved `instructionFile` content as `fallbackPrompt` so ChatGPT can continue the task using the same Markdown instruction.

When `nextAction=continue_in_chatgpt`, the MCP client should not stop after only reporting that Codex hit a limit or telling the user to retry later. It should continue the same task in ChatGPT using `fallbackPrompt`, unless the user explicitly asked not to continue.

This fallback is only recommended for limit-related errors. Other failures such as validation errors, Python startup failures, generic Codex failures, or timeouts do not include a fallback prompt by default.

## Deployment note

After changing Workbridge source, rebuild and restart the local Workbridge server. Existing ChatGPT MCP connections may need to be reconnected before the new tool appears.
