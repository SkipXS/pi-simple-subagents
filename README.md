# Pi Simple Subagents

Small, opinionated Pi extension for plan-driven orchestration with four roles:

- `orchestrator` decides the workflow.
- `scout` gathers read-only context and writes handoff artifacts.
- `worker` is the only role allowed to modify project/source files.
- `reviewer` performs read-only post-implementation review.

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

The orchestrator receives a short prompt plus the plan content/reference, then coordinates scout/worker/reviewer. Worker and reviewer loop until there are no blockers or fixes worth doing now, up to the configured review-round cap.

Read-only review fanout for an existing target:

```text
/review-target @extensions/pi-simple-subagents/index.ts runtime bugs, security, packaging, UX
```

or let the model call `review_target`. This creates a run directory, runs an optional scout plus fresh reviewers with distinct angles, and writes a synthesized `final-summary.md`. It does not run a worker and must not modify project/source files.

## Important workflow rules

- Scout/reviewer/orchestrator may write artifacts only inside the run directory.
- Worker is the only role allowed to edit project/source files.
- In implementation orchestration, reviewer cannot run before worker implementation. The separate `review_target` workflow is explicitly review-only and can run reviewers without a worker.
- Final validation/tests/end-user checks are blocked until the orchestrator explicitly marks the latest worker implementation/fix as cleanly reviewed with `mark_review_clean` after synthesizing reviewer output. Workers may still run narrowly scoped implementation checks when needed for safe coding, but those do not replace the final validation phase.
- If final validation changes the project snapshot, the clean-review mark is invalidated and another reviewer pass is required before finalizing.
- Parallel workers are controlled by config and disabled by default.

## Tool policy

Worker child agents inherit installed Pi extensions by default, so efficient implementation tools from packages such as `context-mode` and `pi-simple-ast-grep` can be used when they are installed. Read-only roles default to `inheritExtensionsForReadOnly: false` to avoid inherited extension/tool-name collisions; opt in only if you trust all inherited extensions.

Default role allowlists:

- `orchestrator`: `read`, `write_run_artifact`, `run_role_agent`, `mark_review_clean`, `compact_session`, `ctx_search`
- `scout`: `read`, `write_run_artifact`, `ast_grep_search`, `ctx_search`
- `worker`: `read`, `bash`, `edit`, `write`, `write_run_artifact`, `compact_session`, `ast_grep_search`, `ast_grep_scan`, `ast_grep_rewrite`, `ctx_execute`, `ctx_execute_file`, `ctx_search`, `ctx_batch_execute`
- `reviewer`: `read`, `write_run_artifact`, `ast_grep_search`, `ast_grep_scan`, `ctx_search`

Runtime read-only role policy also allows explicitly configured safe navigation tools: `ast_grep_scan`, `grep`, `find`, and `ls`. Mutating modes such as `ast_grep_scan.applyFixes=true`, `ast_grep_rewrite.apply=true`, shell tools, and arbitrary-code execution tools remain blocked for non-worker roles. This read-only policy prevents project/source writes by non-worker roles; it is not a confidentiality boundary or OS/container sandbox.

Unknown tools are ignored by Pi when the backing extension is not installed. With the safer default `children.inheritExtensionsForReadOnly=false`, read-only roles usually have only Pi built-ins plus this extension's artifact tools.

For non-worker roles, tool policy is default-deny at config/load time and runtime. Shell/arbitrary execution tools (`bash`, `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`) and mutating ast-grep modes are blocked for read-only roles. They are reserved for `worker` because they can mutate files. Run this extension only on trusted projects or inside an external sandbox when workers may touch untrusted code, secrets, or generated scripts.

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

Reviewer context should be passed through curated artifacts (`input-plan.md`, `orchestration.md`, `scout.md`, worker reports, accepted fixes) plus direct inspection of the relevant current files. Orchestration gate state is also persisted in `orchestration-state.json` so resume/restart scenarios do not lose review/validation gating.

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

Example:

```json
{
  "roles": {
    "orchestrator": { "model": "openai-codex/gpt-5.5", "thinking": "high" },
    "scout": { "model": "openai-codex/gpt-5.3-codex-spark", "thinking": "low" },
    "worker": { "model": "openai-codex/gpt-5.3-codex", "thinking": "high" },
    "reviewer": { "model": "openai-codex/gpt-5.5", "thinking": "high" }
  },
  "workflow": {
    "maxReviewRounds": 5,
    "allowParallelWorkers": false,
    "parallelWorkersRequireWorktrees": true,
    "runTestsOnlyAfterReviewLoop": true
  },
  "children": {
    "inheritExtensions": true,
    "inheritExtensionsForReadOnly": false,
    "inheritSkills": false,
    "roleTimeoutMs": 1800000
  },
  "references": {
    "maxFileBytes": 524288,
    "allowOutsideCwd": false,
    "allowBinary": false
  },
  "artifacts": {
    "baseDir": ".pi/agent-runs",
    "allowOutsideCwd": false
  }
}
```

## Source layout

The extension entrypoint stays in `extensions/pi-simple-subagents/index.ts` and only wires Pi tools, commands, and runtime guards. Workflow internals are split into focused modules: `config.ts`, `roles.ts`, `artifacts.ts`, `references.ts`, `child-runner.ts`, `workflows.ts`, `snapshots.ts`, `state.ts`, `guards.ts`, `schemas.ts`, `prompts.ts`, and `text.ts`.

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

Tool responses are truncated to keep Pi context bounded. Full child transcripts, stderr logs, referenced input files, and final outputs can be stored under the run directory. By default, `artifacts.baseDir` must resolve inside the current project and must not pass through symlinked directory components; set `artifacts.allowOutsideCwd=true` only when you explicitly want an external artifact root. Keep the artifact directory ignored/private when targets may contain sensitive data.
