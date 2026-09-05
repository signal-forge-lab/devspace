# Workbridge Skill routing strategy

Last reviewed: 2026-08-19

This document records the current Workbridge Skill layout, the routing policy
used by coding hosts, and the project decisions that led to the current
configuration. It is a design/operations record, not a replacement for live
runtime discovery: `open_workspace` and the files on disk remain authoritative
for the Skills currently available to a workspace.

## Current runtime layout

Workbridge Skill loading is enabled. The effective default search roots are:

- `~/.agents/skills`
- `~/.codex/skills`

`DEVSPACE_SKILL_PATHS` is currently not required for the normal configuration.
Workbridge discovers the shared user Skill root first and then the configured
agent Skill root, deduplicating paths before loading.

At the 2026-08-19 review, `~/.agents/skills` contained the following 23 Skill
directories:

- `ai-qa-review`
- `codebase-design`
- `code-review-and-quality`
- `code-simplification`
- `cross-browser-testing`
- `debugging-and-error-recovery`
- `design-taste-frontend`
- `high-end-visual-design`
- `imagegen-frontend-web`
- `image-to-code`
- `mem0-memory`
- `ponytail`
- `ponytail-audit`
- `ponytail-debt`
- `ponytail-review`
- `redesign-existing-projects`
- `security-and-hardening`
- `selector-drift-recovery`
- `source-driven-development`
- `test-driven-development`
- `test-reliability`
- `ui-ux-pro-max`
- `visual-testing`

`open_workspace` exposes these 23 Skills in the current environment. Runtime
discovery remains authoritative if source repos or junctions change later.

The important design point is that **available does not mean always active**.
The host is expected to read and apply only the smallest relevant Skill set for
the current task.

## Routing model

The current model is a layered router rather than an "apply every installed
Skill" model.

```text
                         Ponytail
                    baseline coding policy
                             |
          +------------------+------------------+
          |                  |                  |
      engineering        design / UI          memory
      specialists        specialists          specialist
          |                  |                  |
  debugging / TDD      design-taste          mem0-memory
  security             high-end-visual
  source-driven        imagegen / image-to-code
  code review          redesign
  simplification
  codebase design
          |
          +------------------+
                             |
                       conditional QA
                             |
                    visual / selector drift
                    reliability / browser
                    AI QA review
```

Read-only code intelligence is a separate layer:

- Serena: precise symbol, declaration, implementation, reference, diagnostics,
  and semantic-pattern queries.
- Graft: optional compressed repository orientation and dependency/caller
  discovery. Important conclusions must be verified with Serena, Workbridge
  reads, or `rg`.
- Workbridge: mutation and execution authority for file changes, commands,
  tests, Git/worktrees, and registered workspace actions.

This separation avoids giving multiple tools overlapping write authority.

## Baseline: Ponytail

`ponytail` is the only Skill treated as the normal baseline for coding,
design, refactor, fix, dependency-selection, and code-review work.

Its purpose is to counter recurring AI implementation failure modes:

- inventing a framework when an existing helper already solves the problem;
- adding speculative configuration and abstraction for hypothetical future use;
- introducing dependencies for standard-library or native-platform behavior;
- fixing one symptom instead of the shared root cause;
- mixing a small requested change with a broad opportunistic refactor.

The effective priority is not "fewest lines at any cost". User-approved
requirements, security boundaries, reviewed public contracts, fail-closed
behavior, and the Workbridge downstream rebase policy all outrank code-size
minimization.

Related Ponytail Skills are explicit utilities rather than always-on policy:

- `ponytail-review`: diff-focused over-engineering review;
- `ponytail-audit`: repository-wide over-engineering audit;
- `ponytail-debt`: collect explicit `ponytail:` deferrals;
- `ponytail-gain`: one-shot impact/benchmark display;
- `ponytail-help`: one-shot usage reference.

## Engineering specialists

Use these only when the task makes their additional constraints useful.

### `debugging-and-error-recovery`

Use for unexpected runtime behavior, failed builds/tests, transport errors, and
similar incidents. Its role is to identify the failing layer and root cause
before changing code.

### `test-driven-development`

Use for behavior-changing logic and bug fixes when a regression check should be
left behind. Pairing with Ponytail keeps the check small instead of generating
a large test suite for a narrow change.

### `security-and-hardening`

Use at trust boundaries such as filesystem containment, shell/process
execution, OAuth, credentials, user input, or external integrations. Security
requirements are not simplified away by Ponytail.

### `source-driven-development`

Use when implementation correctness depends on a current external protocol,
SDK, library, or framework contract. The goal is to replace remembered API
assumptions with authoritative source behavior.

### `code-review-and-quality`

Use before merging meaningful changes or when a multi-axis correctness/quality
review is requested. It is not intended to turn every one-line change into a
full review ceremony.

### `code-simplification`

Use only when simplifying existing code is itself the task or a material part
of it: reducing duplication, nesting, accidental complexity, or unclear
responsibility. Do not automatically combine it with ordinary bug fixes or
feature work.

This distinction is deliberate:

- Ponytail prevents unnecessary new complexity.
- `code-simplification` removes already-existing complexity when explicitly
  justified.

### `codebase-design`

Use for architecture/module-interface work: seam placement, module depth,
testability, and responsibility boundaries. It balances Ponytail's pressure for
minimal code with the need to put the remaining code behind a stable, deep
interface.

## Conditional QA layer

The QA Skills are intentionally conditional. Installing them does not justify
running all of them on every task.

| Trigger | Skill |
|---|---|
| User-visible layout/style or explicit visual-regression work | `visual-testing` |
| Actual selector/locator drift after UI change | `selector-drift-recovery` |
| Flaky or intermittently failing test | `test-reliability` |
| Important browser-compatibility requirement | `cross-browser-testing` |
| Larger AI-generated application/test change whose QA coverage needs review | `ai-qa-review` |

Use the smallest sufficient set. If one QA Skill covers the observed risk,
do not run four additional QA workflows only because they are installed.
Visual baselines must not be blindly or automatically approved.

## Design / frontend layer

The design Skills were added to address a recurring gap between strong visual
references and comparatively generic generated HTML/UI. Use one primary design
Skill for the task unless a second Skill has a distinct, necessary role.

- `ui-ux-pro-max`: default for dashboard, admin, SaaS/product UI, mobile UI,
  components, accessibility, responsive behavior, information hierarchy, and
  interaction design.
- `design-taste-frontend`: landing pages, marketing sites, portfolios,
  editorial pages, and visual-direction redesigns. Do not use it for dashboards,
  data tables, or multi-step product UI.
- `high-end-visual-design`: premium typography, spacing, composition, motion,
  and finish only when a premium/Awwwards/cinematic direction is explicit.
- `imagegen-frontend-web`: create section-level visual references before
  implementation when generating those references is itself a requested or
  distinct workflow step.
- `image-to-code`: use when a reference image/screenshot is the visual source of
  truth, or when landing/marketing/premium website work has visual fidelity as a
  primary deliverable and image-first -> analysis -> implementation clearly
  improves quality. Do not invoke it for ordinary dashboard/admin/data-heavy UI
  or code-only UI work.
- `redesign-existing-projects`: upgrade an existing application/site while
  preserving its functionality and stack; prefer `ui-ux-pro-max` for existing
  data-heavy product/dashboard redesigns.

Typical routing is therefore:

```text
dashboard / admin / product UI       -> Ponytail + ui-ux-pro-max
landing / marketing / portfolio      -> Ponytail + design-taste-frontend
visual-fidelity-first premium web    -> Ponytail + image-to-code
explicit cinematic/Awwwards finish  -> Ponytail + high-end-visual-design
existing visual site/app redesign    -> Ponytail + redesign-existing-projects
```

`visual-testing` stays in the separate conditional QA layer and is added only
when screenshot/pixel-diff or visual-regression evidence is material. When
`image-to-code` already owns image generation through implementation, do not add
`imagegen-frontend-web` automatically.

A small CSS bug should usually use only Ponytail and the smallest direct
verification needed.

## Memory layer

`mem0-memory` is deliberately external to Workbridge's core execution layer.
It is used when durable prior decisions, preferences, rejected approaches, or
troubleshooting history can materially change the current task.

Authority order remains:

```text
live runtime / repository / Git / state files
    > Mem0 memory
```

Mem0 is not authoritative for current HEADs, transaction state, process state,
or other fast-changing facts. Keeping it in `~/.agents/skills` makes it
removable and reusable without coupling the memory implementation to the
Workbridge server.

## Historical decisions

### 2026-07-30: Ponytail becomes the baseline

The project adopted Ponytail as a cross-project coding rule to reduce AI-added
abstraction, duplicated helpers, speculative configuration, and dependency
growth. This established the "minimal implementation after understanding the
real path" baseline.

### 2026-08-01 to 2026-08-04: broad Skill discovery experiment

Ponytail plus a larger set of agent Skills were made discoverable. This proved
that broad availability is useful, but applying a large Skill set to every
request makes instructions heavier and creates overlapping or competing
workflows.

### 2026-08-07: baseline + specialists

The operating model was simplified: Ponytail remains the baseline while other
Skills become specialists selected by the task. `~/.agents/skills` became the
shared canonical user Skill location for Workbridge/Codex-oriented workflows.
The frontend/design stack was added as conditional capability rather than an
always-on visual policy.

### 2026-08-09: simplification becomes explicit-only

`code-simplification` was restricted to work whose actual purpose includes
cleaning up existing code. This avoids turning ordinary fixes into broad
refactors and keeps downstream rebase diffs smaller.

### 2026-08-11: conditional QA set

QA capabilities were reduced to differentiated cases rather than a universal
pipeline: visual regression, selector drift, test reliability, cross-browser,
and AI QA review. The rule "one Skill is enough when one Skill is enough" was
made explicit.

### 2026-08-15: Mem0 stays outside the core

Mem0 was added as a local external Skill rather than embedded in Workbridge.
The decision preserves a clean execution layer and keeps live repository/state
evidence authoritative.

## Maintenance rules

When changing this strategy:

1. distinguish installed, discoverable, and actually activated Skills;
2. prefer one canonical Skill root rather than copying the same Skill into
   multiple project trees;
3. add a specialist only when it provides a distinct decision or workflow;
4. do not make a specialist always-on merely because it is useful sometimes;
5. preserve the separation between read-only intelligence and Workbridge write
   authority;
6. re-check `open_workspace` output and effective Skill paths after configuration
   changes;
7. update this document when the routing philosophy changes, not for every
   version bump of an individual Skill.
