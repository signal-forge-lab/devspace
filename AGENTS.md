# DevSpace

DevSpace is a local development execution layer for MCP hosts such as ChatGPT and Claude. It gives a remote host workspace-scoped tools for reading, editing, searching, running commands, managing Git worktrees, reviewing changes, and coordinating bounded subagents on the user's machine.

<!-- ponytail-workflow: v1 -->
## Ponytail workflow

- Apply the available `ponytail` Skill to every coding, design, refactor, fix,
  dependency-selection, and code-review task. Read its `SKILL.md` before making
  a non-trivial implementation decision.
- Use `ponytail-review` for an over-engineering review of a diff,
  `ponytail-audit` for a repository-wide report, and `ponytail-debt` only when
  collecting explicit `ponytail:` deferrals.
- First understand the requested behavior and trace the real code path. Then
  prefer, in order: no implementation, existing code, standard library,
  native platform behavior, an installed dependency, and finally the minimum
  new code that works.
- Fix shared root causes rather than one reported symptom. Do not add
  unrequested abstractions, generalized frameworks, dependencies, fallback
  layers, configuration, or speculative future support.
- Leave one smallest runnable regression check for non-trivial logic. Do not
  weaken security, the reviewed tool-schema baseline, fail-closed behavior, rebase policy, or
  accepted Workbridge contracts.
- Priority is: user-approved requirements and completion criteria; security
  and reviewed public contracts; downstream rebase policy and repository-specific
  rules; then Ponytail minimization.

## Graft code-intelligence policy

- Graft is an optional read-only code-intelligence accelerator available through `exec_command`; invoke the pinned CLI as `npx -y @nanonets/graft@0.10.1 ...`.
- Use `graft map` for unfamiliar repository orientation and hotspot discovery.
- Use `graft ask` only for conceptual candidate discovery; verify important conclusions with Serena, Workbridge reads, or `rg` before treating them as ground truth.
- Use `graft callers` when a compressed caller/dependency or blast-radius view is more useful than every individual reference.
- Use `graft skeleton` for a signatures-and-spans view of a file, and `graft grep` for indexed exhaustive occurrence searches.
- Keep Graft's generated graph outside the repository and pass that location with `--dir`; do not let a Graft build alter repository ignore files or pollute normal `rg` ground-truth searches.
- Prefer Serena for precise symbol/declaration/implementation/reference queries and when exact reference lines matter.
- Prefer normal Workbridge reads or `rg` when the location is already known, for localized work, and for final source verification.
- Keep all source mutations in Workbridge; Graft is not an editing authority.
- Do not invoke Graft merely because it is available, and do not run `graft init`, add Graft MCP, or install global hooks without explicit approval.

Pi's SDK currently provides mature local coding primitives. DevSpace wraps those primitives in a Streamable HTTP MCP server and adds the product-specific boundaries around them: approved roots, workspace state, instructions, process sessions, worktrees, artifacts, review checkpoints, widgets, and subagent execution.

DevSpace owns tooling mechanics. The model receives only meaningful and actionable choices. The user sees outcomes. Tool defination should not leak internal implementation or it shoudn't be giving unwanted options to model to choose from if tooling can handle this.

## Product model

These ideas should stay true as the project evolves:

The model-facing workflow is workspace based. MCP clients should call
`open_workspace` once per local project directory or worktree, then reuse the
returned `workspaceId` for subsequent tool calls in that same folder. Do not
call `open_workspace` again for the same folder unless the `workspaceId` is
rejected as unknown, the client switches folders/worktrees or checkout/worktree
mode, or the user explicitly asks to reopen. Root-level `AGENTS.md` and
`CLAUDE.md` instructions are returned by `open_workspace`. Nested instruction
files are listed in `availableAgentsFiles`; the MCP client must read the relevant
file before working in that directory.

1. **The host is the orchestrator.** DevSpace exposes clear capabilities and execution state. It should not hide the workflow inside an opaque, uninspectable agent loop.
2. **Everything happens in a workspace.** A workspace represents one local project directory or worktree plus the instructions and state accumulated while operating in it.
3. **Local authority stays explicit.** DevSpace runs with access to the user's machine. Roots, paths, commands, processes, credentials, and destructive operations must be treated as product boundaries.
4. **Subagents are bounded workers.** A subagent should have an explicit task, profile, working context, lifecycle, and result that the host can inspect and coordinate.
5. **Adapters stay at the edges.** Pi, MCP hosts, and model providers each have their own terminology and capabilities. Provider-specific behavior should not become the core domain model.
6. **Prefer composable primitives.** Build a small set of reliable operations that can be combined into larger workflows instead of baking every workflow into the server.

## Glossary

- **Host** — the MCP client presenting the agent experience and coordinating work.
- **Server** — the local DevSpace MCP server.
- **Workspace** — one opened directory or worktree and its accumulated instruction context.
- **`workspaceId`** — the opaque handle returned by `open_workspace` and reused for calls in that workspace.
- **Allowed root / project root** — the upstream-configured project boundary. Checkout workspaces and managed-worktree source repositories may originate here. It is not itself necessarily a workspace.
- **Auxiliary root** — a Workbridge-only, explicitly configured checkout boundary for user-level tooling such as `~/.codex` or `~/.agents`. It may run normal workspace commands but is never a managed-worktree source.
- **Managed worktree root** — the Workbridge-owned destination for generated Git worktrees. It must stay beneath an allowed/project root.
- **Checkout mode** — operating on an existing checkout supplied by the user.
- **Worktree mode** — operating in an isolated Git worktree.
- **Tool surface** — the upstream Codex profile selected by Workbridge, plus reviewed Workbridge-owned extensions and upstream review capabilities. Runtime options do not switch to the upstream minimal/full profiles, and subagents remain explicitly disabled unless approved.
- **Process session** — a long-running command tracked for later input, output, or termination.
- **Instruction file** — an `AGENTS.md` or `CLAUDE.md` discovered while navigating a workspace.
- **Subagent** — a bounded model invocation delegated and coordinated by the host.
- **Agent profile** — the model, provider, tools, and instructions used for a subagent.
- **Artifact** — an output surfaced for the host or user to inspect.
- **Review checkpoint** — stored state representing a coherent set of changes.
- **Widget** — host-rendered UI/Cards attached to an MCP response.

Use these terms precisely. In particular, do not use workspace, project root, auxiliary root, checkout, and worktree interchangeably.

## Security boundaries

Filesystem tools enforce approved-root containment. Shell commands run with the local user's authority and are not a general sandbox. Never imply that shell execution is contained merely because file tools are contained.

Resolve and validate paths before destructive actions. Do not broaden an allowed root, delete application state, expose a credential, or replace an existing process as a convenient fix.

Keep tunnel ownership and credentials with the user. Workbridge may provide opt-in helpers that launch and health-check an already provisioned user-controlled tunnel, but it must not provision or revoke tunnels, persist tunnel credentials, or silently replace tunnel configuration.

## Diagnose the correct layer

A failure may belong to the host, MCP transport, DevSpace, a Pi adapter, a provider, a model, a tool implementation, or the target project. Preserve the original error and identify the failing boundary before changing code.

An adapter exception is not evidence that a model failed. A successful command is not evidence that a GUI opened, a host refreshed, or a user-visible workflow succeeded.

Do not expand DevSpace's responsibility while fixing a local symptom. Host UI, provider model naming, tunnel management, and duplicated review experiences require an explicit product decision.

## Verify the real path

Determine how the user will consume the change and verify that path. Behavior may differ between:

- the source checkout and the packaged `npm`/`npx` installation;
- a direct terminal client and a real MCP host;
- a fresh process and a server or host that needs restarting;
- checkout mode and worktree mode;
- Linux, macOS, and Windows Bash environments;
- minimal, full, and Codex-compatible tool surfaces;
- widgets enabled, disabled, or limited to change review.

State clearly when only a narrower proxy was verified. For model-facing schemas, inspect what the host receives. For UI and artifacts, inspect the rendered result rather than inferring success from the producing command.

## Trace affected contracts

When changing a cross-cutting concept, check every surface it actually reaches:

- MCP schema, handler, description, and response;
- workspace lifecycle and instruction loading;
- allowed-root and path-containment behavior;
- checkout and worktree modes;
- process and subagent lifecycle;
- tool-surface filtering;
- widgets, artifacts, and review checkpoints;
- persistence and migrations;
- packaged entry points, documentation, and examples.

This is a map, not a requirement to touch every surface on every change. Avoid both incomplete contracts and speculative edits.

## Pull requests

Only create or update a PR when explicitly asked, and read `CONTRIBUTING.md` first. Keep a PR focused on one coherent concern and use a conventional title such as `fix:`, `feat:`, `docs:`, `refactor:`, or `chore:`.

Write the body as a few natural paragraphs explaining the problem and solution. Include verification, risk, or migration context only when it helps the reviewer. Avoid generated boilerplate, commit inventories, file-by-file narration, generic checklists, and mandatory `Testing` sections.

For UI changes, include before/after images and a short interaction video when behavior changes. Inspect the final diff before filing. When available, use the `file-pr` workflow to file the PR and `babysit-pr` to monitor CI and reviews.

## Where code lives

- `src/server.ts` — MCP server setup and response wiring.
- `src/workbridge-tool-registration.ts` — Workbridge-owned tool extensions, wrappers, and model-facing guidance layered over the upstream Codex surface.
- `src/workspaces.ts` — workspace lifecycle, instructions, skills, and profiles.
- `src/roots.ts` — allowed roots and path containment.
- `src/process-sessions.ts` — long-running process lifecycle.
- `src/git.ts` and `src/git-worktrees.ts` — Git and worktree operations.
- `src/local-agent-*.ts` — subagent configuration, providers, and execution.
- `src/artifact-*.ts` and `src/incoming-artifacts.ts` — artifact handling.
- `src/review-checkpoints.ts` — persisted change-review checkpoints.
- `src/ui/` — MCP widgets.
- `src/db/` — persisted local state and migrations.
- `src/*.test.ts`, `desktop/monitor/*.test.cjs`, and `scripts/cli-serve-smoke.mjs` — behavior and regression tests.

Start at the boundary named by the problem and follow the data. Keep policy in DevSpace, provider translation in adapters, and important behavior in schemas, types, checks, or explicit tool results rather than hidden prompt conventions.

## Project taste

- Prefer explicit lifecycle and state over hidden autonomy.
- Make tasks, inputs, outputs, failures, and ownership inspectable.
- Keep subagent execution composable and independently testable.
- Preserve host and provider data unless DevSpace has a concrete reason to normalize it.
- Add compatibility behavior only for an identified consumer with a real upgrade path.
- Reuse glossary terms in schemas, types, documentation, and errors.
- Keep the execution layer small, reliable, and unsurprising.

## Desktop Monitor lifecycle

- Tauri is the canonical Windows Desktop Monitor and the normal launch target.
  Keep `npm run monitor:launch` pointed at `monitor:tauri:launch`.
- Electron is a temporary fallback only. Do not add Electron-only features unless
  they are required to keep the fallback usable while Tauri stabilizes.
- Electron retirement is an intentional pending task, not a permanent dual-shell
  design. After the user accepts Tauri as stable in normal primary operation,
  remove the Electron-specific shell, packaging, dependencies, commands, and
  documentation.
- `desktop/monitor` still contains shared supervisor/library/memory-log code used
  by Tauri. Before Electron retirement, extract or preserve that shared code;
  deleting the Electron fallback must not delete Tauri's shared control or
  telemetry contracts.
- Until retirement is complete, every future Desktop Monitor roadmap/status
  review must surface the pending Electron cleanup explicitly so it is not
  forgotten.

## Mandatory downstream maintenance policy

This repository is a downstream Workbridge extension that is expected to be
rebased onto upstream regularly. All maintainers and coding agents must treat
rebase compatibility as a primary design constraint.

- Read and follow `docs/WORKBRIDGE_UPSTREAM_REBASE_POLICY.md` before changing
  architecture, moving code, or editing upstream-owned files.
- Keep Workbridge-specific behavior in Workbridge-owned modules whenever
  practical. Leave only small, explicit integration hooks in upstream-owned
  files.
- Do not broadly reorganize, rename, split, or reformat upstream-owned code only
  for cleanliness. Such changes increase future rebase conflicts.
- A refactor is justified when it reduces the downstream patch surface,
  isolates Workbridge behavior, fixes a concrete defect, or enables an approved
  feature. File size alone is not sufficient justification.
- Create a local backup ref before rebasing. Do not push, tag, publish, create a
  GitHub release, or add remote/publication work to the plan unless the user
  explicitly requests it.
- Perform source-code modifications in a dedicated Git worktree by default.
  Treat the primary checkout as the integration and observation surface. Direct
  edits in the primary checkout require an explicit user instruction or a
  narrowly scoped emergency correction with a documented reason.
- Preserve the upstream-derived Codex tool policy, reviewed schema baseline,
  explicit disabled capabilities, and other accepted Workbridge design decisions
  unless the user explicitly approves a change.

### Canonical integration discipline

- Treat `workbridge-fixed-surface` as the default canonical downstream branch
  unless the user explicitly selects a different integration target.
- Do not let a temporary feature, canary, performance, or runtime branch become
  a general accumulation branch. Once a change is accepted, integrate it into
  the canonical branch before stacking unrelated follow-up work.
- If a temporary runtime branch is required for live validation, keep it
  topic-scoped and reconcile accepted changes back to the canonical branch as
  soon as validation completes. Start subsequent unrelated work from the
  canonical branch, not from the temporary runtime branch.
- Normal Workbridge runtime should be launched from the canonical branch after
  validation. Keep temporary runtime branches only as short-lived canary or
  rollback references when they still have a concrete purpose.
- After integrating a dedicated managed worktree into the canonical branch,
  remove that worktree before starting unrelated work. Keep an unmerged branch
  when its commits still matter; the worktree directory itself is not an archive.
- Run `npm run maintenance:worktrees` when auditing local maintenance state and
  `npm run maintenance:worktrees -- --check` as a completion gate. The check
  fails for clean managed worktrees whose changes are already integrated and
  for integrated local branches that are no longer checked out or protected by
  an upstream tracking branch.
- Before deleting a clean detached managed worktree whose HEAD is not reachable
  from another ref, preserve that HEAD under a local non-branch ref such as
  `refs/archive/worktrees/YYYYMMDD/<worktree-name>`.
