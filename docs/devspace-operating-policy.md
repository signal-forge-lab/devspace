# DevSpace Operating Policy

Status: active
Version: 1.1.44

## Purpose

This policy defines the shared operating model for DevSpace work across projects. The goal is not to avoid difficult or sensitive-looking work. The goal is to make the work faster, safer, more reproducible, and easier to verify by routing each task through a structured workflow.

DevSpace is a structured workflow layer for local workspaces, not a shell-only executor. Shell commands remain useful for bounded verification and project scripts, but they should not be the default transport for large edits, sensitive integration, or broad repository inspection.

## Core principles

### Efficiency over avoidance

Do not turn incidents, host blocks, or sensitive-looking terms into blanket prohibitions. Convert them into better workflow choices, typed inputs, bounded inspection, and reusable verification.

Use this framing:

```text
inefficient: avoid the task because it mentions secret, token, webhook, or API
preferred: classify whether the value is a real secret value, an env var name, a config key, or a typed reference
```

### Typed over free-form

Prefer structured fields over large free-form text. A good request separates intent, target paths, constraints, references, transport, and verification.

### Reference over secret value

DevSpace may handle names of environment variables, config keys, credential references, and mock placeholders. DevSpace must not inspect, print, store, or commit real secret values.

Classification:

```text
secret_value: actual credential material; do not read or persist
env_var_name: symbolic name such as EXAMPLE_API_KEY; allowed as reference
config_key_name: application key such as apiKeyEnvVar; allowed as reference
credential_reference: pointer to an external secret store or env var; allowed as reference
mock_value: non-secret placeholder for tests; allowed when clearly marked
```

### Transport over workaround

Encoding, including base64, is a typed transport for preserving special characters, binary-like payloads, or large templates. It is not a safety-filter bypass. Use it only when the task benefits from transport integrity, size limits, dry-run checks, and decoded-size validation.

### Fixed verification over ad-hoc validation

Prefer fixed verification profiles and project scripts over ad-hoc chained shell commands. Keep output bounded and choose the smallest verification set that proves the change.

### Incidents as improvement input

An incident is a workflow improvement signal. Record the class of incident, the failed route, the safer route, and the proposed reusable improvement. Do not repeatedly retry the same failing shape.

### Unified over project-specific

Avoid project-specific playbooks when a shared task class or workflow policy can solve the same problem. Project names may appear as examples, not as permanent special cases.

## Task classes

### read_inspect

Use for repository reading, task-doc review, API surface inspection, or context gathering.

Preferred route:

```text
1. workspace snapshot or router snapshot
2. focused grep or indexed ranges
3. ZIP-first snapshot when reading many files or broad context
4. bounded summary of findings
```

Avoid repeated broad reads, streaming large files into chat, or reading generated/private runtime artifacts unless explicitly required and safe.

### small_edit

Use for one or two localized documentation, config, or code edits.

Preferred route:

```text
1. locate the exact anchor
2. apply a structured edit or focused patch
3. verify the edited range
4. run git_diff_check and relevant minimal tests
```

### large_edit_refactor

Use for multi-file edits, import rewrites, generated-type changes, or refactors.

Preferred route:

```text
1. define scope and non-goals
2. identify alternate execution paths
3. prefer patch/dry-run transport over long heredocs
4. apply in small batches
5. run typecheck, related tests, and build when needed
```

### validation_test

Use when the main work is verification, smoke checks, or regression confirmation.

Preferred route:

```text
1. choose a fixed verification profile
2. run bounded test commands
3. summarize pass/fail and the smallest failure excerpt
4. avoid live external calls unless explicitly approved
```

### structured_sensitive_integration

Use for work involving env var names, config keys, credential references, webhook configuration keys, or mock-first integration.

Preferred route:

```text
1. separate real secret values from references
2. use mock values or env-var references only
3. require explicit live-smoke approval for external side effects
4. verify that no real secret values are printed or committed
```

### runtime_external_side_effect

Use for actions that may post messages, send notifications, modify external services, create live browser chats, deploy, or trigger scheduled automation.

Preferred route:

```text
1. default to dry-run or configuration-only changes
2. require explicit confirmation for live side effects
3. record what was not executed
4. verify local state without leaking private runtime artifacts
```

### packaging_release

Use for version bumps, package metadata, build outputs, release preparation, or connector refresh helpers.

Preferred route:

```text
1. update package metadata consistently
2. run typecheck and build or the project-defined package checks
3. avoid committing generated archives unless the release task explicitly requires them
4. do not publish or push unless separately authorized
```

### incident_recovery

Use after tool filters, shell quoting failures, here-doc failures, stream errors, excessive output, or verification instability.

Preferred route:

```text
1. classify the incident
2. stop retrying the same failing shape
3. switch to a safer structured route
4. record the improvement candidate for future workflow changes
```

## Workflow decision matrix

| Task class | Preferred first route | Edit transport | Verification |
|---|---|---|---|
| read_inspect | router / snapshot / focused read | none | summary / status |
| small_edit | locator / focused read | structured edit or small patch | git diff check + related test |
| large_edit_refactor | plan + alternate path inventory | patch with dry-run and hash guard | typecheck + related tests + build if needed |
| validation_test | devspace_verify fixed profile | none | selected fixed profile |
| structured_sensitive_integration | typed references + mock-first | structured edit | no-secret scan + mock tests |
| runtime_external_side_effect | dry-run / config-only | structured edit | local state check + explicit unverified live step |
| packaging_release | package metadata plan | structured edit | typecheck + build + package consistency |
| incident_recovery | incident classification | safer alternate route | event/report update |

## Unified classifier

DevSpace workflow routing can use the shared efficiency classifier before choosing tools. The classifier is not a stop/go gate; it turns task shape into the shortest reusable workflow sequence.

Example output:

```json
{
  "taskClass": "structured_sensitive_integration",
  "risk": "medium",
  "efficiencyGoal": "separate_secret_reference_from_secret_value_and_generate_config_mock_first",
  "recommendedSequence": [
    "classify",
    "validate_env_var_reference",
    "structured_env_reference_patch",
    "mock_test",
    "devspace_verify:typecheck_only",
    "devspace_verify:git_diff_check"
  ],
  "requiredChecks": [
    "env_var_name_validation",
    "no_secret_value_input",
    "mock_or_config_only_default",
    "no_secret_value_logged"
  ],
  "transportRecommendation": "plain_structured_edit",
  "blockedPattern": "live_secret_value_or_live_api_call_in_first_step",
  "improvementHint": "use typed env var reference rather than free-form source insertion"
}
```

## Structured edit transport

`apply_structured_edit` and `apply_unified_patch` support typed content transport with `contentEncoding: "plain" | "base64"`. Plain is the default and preserves existing behavior. Base64 is only for preserving transport integrity for special characters, templates, or larger patch payloads; it is not a filter bypass and must not be used to carry real secret values.

Structured transport requirements:

```text
- decode content before applying the edit
- validate decoded size with maxDecodedBytes
- keep expectedSha256 / expectedBase hash guards
- run dryRun first for large or risky edits
- return dry-run summary without writing files
```

## Sensitive integration workflow

DevSpace may handle env var names, config key names, credential references, and mock labels. It must not receive, read, write, log, or commit live secret values.

Typed sensitive integration inputs should use:

```text
EnvVarReference: { kind: "env_var", name: "EXAMPLE_API_KEY", configKey?: "apiKeyEnvVar" }
secretValueHandling: "never_read_or_write" | "mock_only"
mode: "config_only" | "mock_first" | "config_and_mock_only"
```

Env var names must be symbolic names matching `/^[A-Z_][A-Z0-9_]{0,127}$/`. Live smoke is a separately approved action; config-only and mock-first sequences remain the default.

## Alternate execution paths

Large edits and refactors should check alternate execution paths before applying broad changes. The shared detector uses general categories instead of project-specific names:

```text
main_entry
fallback_entry
manual_injection
cli_entry
batch_or_script_entry
daemon_or_runtime_entry
popup_or_ui_entry
config_entry
test_entry
generated_artifact_entry
```

False positives are acceptable when the output remains bounded. The goal is to reduce rework by catching fallback, CLI, UI, runtime, config, generated, and test paths early.

## Verification policy

Verification policy maps `taskClass` to fixed `devspace_verify` profiles. It should choose the smallest sufficient profile set and should not add live external smoke by default.

Examples:

```text
read_inspect -> git_status_check
small_edit -> git_status_check, git_diff_check
large_edit_refactor -> git_status_check, git_diff_check, typecheck_only, related_tests
structured_sensitive_integration -> git_status_check, git_diff_check, typecheck_only, mock-first workflow test
packaging_release -> git_status_check, git_diff_check, npm_test, build
```

## Incident-to-improvement loop

Incidents are improvement inputs, not task abandonment. Repeating the same blocked or brittle shape is inefficient; after a repeated block or clear route failure, switch to the mapped improvement route.

Examples:

```text
schema_validation -> switch_to_structured_schema
heredoc_or_quoting_syntax -> use_structured_edit_transport
line_range_or_locator_miss -> resolve_locator_before_edit
safety_filter_block -> split_sensitive_reference_from_secret_value
alternate_path_miss -> run_alternate_execution_path_detector
live_side_effect_attempt -> require_explicit_live_smoke_flag
```

## Efficiency metrics

Log reports should show available efficiency metrics separately from unavailable metrics. Useful available metrics include bash tool calls, bash edit-like calls, heredoc-like incidents, structured edit calls, unified patch calls, devspace_verify calls and failure rate, router calls, workflow events, incident counts, improvement hints, truncation, and retries after failure. Do not infer live external service calls or unrecorded host filters when the logs cannot observe them.

## Review checklist

Before completing a DevSpace task, verify:

```text
- The task improved efficiency rather than merely avoiding work.
- Real secret values were not read, printed, stored, or committed.
- Env var names, config keys, and typed references are clearly separated from secret values.
- Large edits did not depend on brittle long shell heredocs when a structured route was available.
- Verification used the smallest sufficient fixed or project-defined profile.
- Incidents were treated as improvement input.
- The result is reusable across projects rather than a project-specific exception.
- git diff is scoped to the declared target project and task version.
```

## Migration notes

This policy is the v1.1.35 foundation for later tasks:

```text
v1.1.36: classifier should reuse the task classes and reference/secret classifications
v1.1.37: structured edit transport should support the transport rules here
v1.1.38: sensitive integration workflow should build on the reference-over-secret model
v1.1.39: alternate execution path detector should support large_edit_refactor and runtime_external_side_effect
v1.1.40: verification policy should map task classes to fixed profiles
v1.1.41: incident loop should record incident_recovery fields
v1.1.42: metrics report should measure whether these policies reduce retries and output size
```
