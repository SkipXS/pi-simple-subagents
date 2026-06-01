# Pi Simple Subagents

Small, opinionated Pi extension for plan-driven orchestration with four roles:

- `orchestrator` decides the workflow.
- `scout` gathers context and writes handoff artifacts.
- `worker` is the main implementation/fix/validation role.
- `reviewer` performs post-implementation or target review.

## Installation

Requires Pi `@earendil-works/pi-coding-agent` `>=0.78.0 <1`. The Pi host API is declared as a peer dependency; runtime libraries used directly by the extension are declared in `dependencies`.

Local development install:

```bash
pi install /absolute/path/to/pi-simple-subagents
# or, from the repository parent:
pi install ./pi-simple-subagents
```

After publishing to GitHub:

```bash
pi install git:https://github.com/<owner>/pi-simple-subagents
```

Project config example:

```bash
mkdir -p .pi/pi-simple-subagents
cp /absolute/path/to/pi-simple-subagents/examples/config.json .pi/pi-simple-subagents/config.json
```

Reload Pi after install/config changes:

```text
/reload
```

## Usage

Implementation orchestration:

```text
/orchestrate @docs/plan.md
```

or ask naturally and let the model call the tool:

```text
Use orchestrate_plan for @docs/plan.md
```

The orchestrator receives a short prompt plus the plan content/reference, then coordinates scout/worker/reviewer. Worker and reviewer loop while it is useful; there is no default hard review-round cap.

Review fanout for an existing target:

```text
/review-target @extensions/pi-simple-subagents/index.ts runtime bugs, security, packaging, UX
```

The slash command also accepts a small option prefix before the target:

```text
/review-target --no-scout --reviewer "security boundaries" --reviewer "packaging UX" @extensions/pi-simple-subagents
```

or let the model call `review_target` for the full schema (`target`, `focus`, `reviewers`, `includeScout`). This creates a run directory, runs an optional scout plus fresh reviewers with distinct angles, and writes a synthesized `final-summary.md`. It does not run a worker; in YOLO mode the extension does not enforce source-write restrictions.

## Important workflow guidance

Pi is YOLO by default, and this extension follows that model. The workflow suggests roles and artifacts, but it does not impose hard file, time, snapshot, validation, review-round, or role-write guardrails.

- Scout, reviewer, orchestrator, and worker can use the normal Pi tool surface.
- Any role may run scripts, tests, benchmarks, downloads, browser/user-flow checks, or diagnostics when useful.
- Worker is still the intended role for implementation/fixes, but this is guidance rather than an enforced sandbox.
- `mark_review_clean` records the orchestrator's synthesized review state; it does not gate validation in YOLO mode.
- Parallel workers are allowed by default. Prefer serial work when coordination risk is high.
- Run artifacts remain the audit trail: plans, delegations, logs, outputs, review summaries, validation notes, and final summaries.

## Tool policy

Pi is intentionally YOLO by default, and this extension now follows that model without file-level or time-level guardrails:

- Role runs do not pass a restrictive `--tools` allowlist, even if old config files contain `roles.<role>.tools`.
- Child runs are not killed by an extension timeout; there is no timeout config.
- Plan/target references are not size-limited by default, may point outside the project by default, and binary-looking files are not blocked by default.
- Scout/reviewer/orchestrator source edits are not blocked by extension hooks.
- Scout/reviewer child runs are not fenced with source snapshots and are not auto-restored on mutation.
- Orchestration runs do not archive/restore authorized source snapshots.
- Review rounds, validation timing, and parallel workers are orchestration choices, not hard gates.

Legacy config fields are accepted but ignored for compatibility; the product stance is YOLO rather than safety-by-config.

This policy is not a confidentiality boundary or OS/container sandbox. Run this extension only on trusted projects or inside an external sandbox when agents may execute untrusted code, access secrets, or run generated scripts.

## Compaction policy

Pi auto-compaction still applies per child session. In addition, `orchestrator` and `worker` can call `compact_session` when their persistent sessions get long. The tool requests Pi compaction with instructions to preserve:

- original plan/current goal
- changed files and implementation decisions
- open reviewer findings and accepted fixes
- validation state and deferred items
- run artifact paths

Artifacts remain the source of truth after compaction.

## Session policy

- `orchestrator` uses one persistent session for the run: `sessions/orchestrator.jsonl`.
- `worker` uses one persistent session for implementation and all fix rounds: `sessions/worker.jsonl`.
- `reviewer` gets a fresh session for every review round: `sessions/reviewer-<timestamp>.jsonl`.
- `scout` gets a fresh session for each scout call: `sessions/scout-<timestamp>.jsonl`.

Reviewer context should be passed through curated artifacts (`input-plan.md`, `orchestration.md`, `scout.md`, worker reports, accepted fixes) plus direct inspection of the relevant current files. Lightweight orchestration state is persisted in `orchestration-state.json` for resume/restart continuity.

## Config

Project config lives at:

```text
.pi/pi-simple-subagents/config.json
```

Global defaults can live at:

```text
~/.pi/agent/pi-simple-subagents/config.json
```

Project config overrides global config.

Example with explicit YOLO defaults (all sections are optional; omit anything you do not want to override):

```json
{
  "roles": {
    "orchestrator": { "model": "openai-codex/gpt-5.5", "thinking": "high" },
    "scout": { "model": "openai-codex/gpt-5.3-codex-spark", "thinking": "low" },
    "worker": { "model": "openai-codex/gpt-5.3-codex", "thinking": "high" },
    "reviewer": { "model": "openai-codex/gpt-5.5", "thinking": "high" }
  },
  "children": {
    "inheritExtensions": true,
    "inheritExtensionsForReadOnly": false,
    "inheritSkills": false
  },
  "artifacts": {
    "baseDir": ".pi/agent-runs"
  }
}
```
## Source layout

The extension entrypoint stays in `extensions/pi-simple-subagents/index.ts` and wires Pi tools and commands. Workflow internals are split into focused modules: `config.ts`, `roles.ts`, `artifacts.ts`, `references.ts`, `child-runner.ts`, `workflows.ts`, `state.ts`, `schemas.ts`, `prompts.ts`, and `text.ts`.

## Run artifacts

Each orchestration/review run creates:

```text
.pi/agent-runs/<run-id>/
  input-plan.md or input-target.md
  config-effective.json
  orchestration-state.json
  orchestration.md or scout-review-context.md/review-*.md
  delegations/
  logs/
  outputs/
  prompts/
  sessions/
  tasks/
  final-summary.md
```

Full child transcripts, stderr logs, referenced input files, and final outputs can be stored under the run directory. Tool-return previews may still be concise for chat readability, but the child run itself is not limited by that preview. `artifacts.baseDir` may be inside or outside the current project; keep the artifact directory ignored/private when targets may contain sensitive data.
