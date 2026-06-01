# Pi Simple Subagents

Small, opinionated Pi extension for plan-driven orchestration with four roles:

- `orchestrator` decides the workflow.
- `scout` gathers read-only context and writes handoff artifacts.
- `worker` is the only role allowed to modify project/source files.
- `reviewer` performs read-only post-implementation review.

## Installation

Local development install:

```bash
pi install /d/Projects/pi-simple-subagents
```

After publishing to GitHub:

```bash
pi install git:https://github.com/<owner>/pi-simple-subagents
```

Project config example:

```bash
mkdir -p .pi/pi-simple-subagents
cp /d/Projects/pi-simple-subagents/examples/config.json .pi/pi-simple-subagents/config.json
```

Reload Pi after install/config changes:

```text
/reload
```

## Usage

```text
/orchestrate @docs/plan.md
```

or ask naturally and let the model call the tool:

```text
Use orchestrate_plan for @docs/plan.md
```

The orchestrator receives a short prompt plus the plan content/reference, then coordinates scout/worker/reviewer. Worker and reviewer loop until there are no blockers or fixes worth doing now, up to the configured review-round cap.

## Important workflow rules

- Scout/reviewer/orchestrator may write artifacts only inside the run directory.
- Worker is the only role allowed to edit project/source files.
- Reviewer cannot run before worker implementation.
- Validation/tests/end-user checks are blocked until the latest successful worker implementation/fix has a successful review, and are instructed to happen after the review/fix loop.
- Parallel workers are controlled by config and disabled by default.

## Tool policy

Child agents inherit installed Pi extensions by default, so efficient navigation tools from packages such as `context-mode` and `pi-simple-ast-grep` can be used when they are installed.

Default role allowlists:

- `orchestrator`: `read`, `write_run_artifact`, `run_role_agent`, `compact_session`, `ctx_search`
- `scout`: `read`, `write_run_artifact`, `ast_grep_search`, `ctx_search`
- `worker`: `read`, `bash`, `edit`, `write`, `write_run_artifact`, `compact_session`, `ast_grep_search`, `ast_grep_scan`, `ast_grep_rewrite`, `ctx_execute`, `ctx_execute_file`, `ctx_search`, `ctx_batch_execute`
- `reviewer`: `read`, `write_run_artifact`, `ast_grep_search`, `ast_grep_scan`, `ctx_search`

Unknown tools are ignored by Pi when the backing extension is not installed.

For non-worker roles, shell/arbitrary execution tools (`bash`, `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`) are runtime-blocked even if a local config accidentally adds them. They are reserved for `worker` because they can mutate files.

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

Reviewer context should be passed through curated artifacts (`input-plan.md`, `orchestration.md`, `scout.md`, worker reports, accepted fixes) plus direct inspection of the relevant current files.

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
    "inheritSkills": false
  },
  "artifacts": {
    "baseDir": ".pi/agent-runs"
  }
}
```

## Run artifacts

Each orchestration creates:

```text
.pi/agent-runs/<run-id>/
  input-plan.md
  config-effective.json
  orchestration.md
  delegations/
  logs/
  outputs/
  prompts/
  sessions/
  tasks/
  final-summary.md
```
