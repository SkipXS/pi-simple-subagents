# Pi Simple Subagents reference

Detailed reference for [Pi Simple Subagents](../README.md).

## Command reference

### `/orchestrate`

```text
/orchestrate @docs/plan.md
```

Use for plan-driven implementation that benefits from scout, worker, reviewer, fix, and validation phases.

Notes:

- The orchestrator receives the prompt plus the plan content/reference.
- Before the first worker call it is instructed to break milestones into small work packages.
- Worker and reviewer loop while useful; there is no default hard review-round cap.
- Each plan/task/target/context value supports **at most one** `@file` or `@directory` reference. Extra `@...` tokens are rejected to avoid accidental partial context loading.

### `/scout`

```text
/scout @extensions/pi-simple-subagents
/scout Find the relevant Pi extension APIs and summarize only what the parent needs
/scout Map current parser behavior, affected files, risks, and recommended next steps before implementation
```

Use before implementation or review when the task is broad, unfamiliar, cross-file, security-sensitive, behavior-changing, or ambiguous. Scouts write `scout-report.md` by default and should produce a compact handoff rather than source edits.

The corresponding root tool is `run_scout`:

```ts
{
  task: string,
  outputFile?: string,
  includeOutput?: boolean
}
```

### `/work`

```text
/work @docs/task.md
/work Fix the failing parser test and run the focused test suite
```

Use for one focused implementation, fix, or validation package. Oversized worker tasks are rejected by `orchestration.maxWorkerTaskBytes` unless that limit is set to `0`.

The corresponding root tool is `run_worker`:

```ts
{
  task: string,
  purpose?: "implementation" | "fix" | "validation",
  outputFile?: string,
  includeOutput?: boolean
}
```

### `/work-parallel`

```text
/work-parallel ["Update README usage examples","Add parser regression tests"]
/work-parallel [{"name":"docs","task":"Update README usage examples"},{"name":"tests","task":"Add parser regression tests"}]
/work-parallel {"tasks":[{"name":"docs","task":"Update README examples"},{"name":"tests","task":"Add parser regression tests"}]}
```

Use only for independent tasks unlikely to touch the same files. Each worker gets its own child run directory and `sessions/worker.jsonl`.

Accepted JSON shapes:

- array of task strings
- array of task objects
- object with a `tasks` array

Task object fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `task` | yes | Non-empty task text. |
| `name` | no | Short worker name used in artifact paths. |
| `purpose` | no | `implementation`, `fix`, or `validation`. |
| `outputFile` | no | Expected report artifact filename. |

JSON pitfalls:

- Use double quotes; single quotes, comments, and trailing commas are invalid JSON.
- Use `outputFile`, not `output_file`.
- Provide 2-8 tasks; use `/work` for one task.
- Escape Windows backslashes (`C:\\Users\\me\\task.md`) or use forward slashes.
- If your shell/TUI consumes quotes, paste JSON directly into Pi or escape it for your shell.

Setup/spawn errors abort sibling workers and wait for shutdown. Ordinary non-zero child exits are collected so siblings can finish, then `parallel-workers-summary.md` is written and the batch fails. Fanout is still limited by `children.maxConcurrentSubagents`.

### `/review`

```text
/review @extensions/pi-simple-subagents/index.ts focus on runtime bugs, security, packaging, and UX
/review --context @.pi/agent-runs/<run-id>/scout-report.md --reviewer "security boundaries" @extensions/pi-simple-subagents
/review --no-scout --continue-on-reviewer-failure @README.md docs focus
/review -- --fixture docs focus
```

Use for review-only fanout. By default a review-specific scout runs first, then fresh reviewers inspect the target, and synthesis writes `final-summary.md`.

Options:

| Option | Meaning |
| --- | --- |
| `--scout` / `--no-scout` | Enable or skip the review-specific scout. |
| `--context <inline-or-@file>` | Add compact prior context such as a scout report. |
| `--context=<inline-or-@file>` | Same as above. |
| `--reviewer <angle>` | Add a custom reviewer angle; repeatable, max 8. |
| `--reviewer=<angle>` | Same as above. |
| `--continue-on-reviewer-failure` | Synthesize from successful reviewers when at least one completed. |
| `--fail-on-reviewer-failure` | Fail the review if any reviewer fails. |
| `--` | End options when the target starts with hyphens. |

Multi-word `--context` and `--reviewer` values must be quoted. Unknown `--...` options and unmatched quotes fail before any child process starts.

The corresponding root tool is `run_reviewers`:

```ts
{
  target: string,
  focus?: string,
  extraContext?: string,
  reviewers?: string[],
  includeScout?: boolean,
  continueOnReviewerFailure?: boolean,
  includeOutput?: boolean
}
```

## Tool and role details

### Root tools

| Tool | Slash command | Key options | Use when |
| --- | --- | --- | --- |
| `run_orchestrator` | `/orchestrate <plan-or-@file>` | `plan`, `includeOutput?` | Plan-driven work should coordinate scout, worker, review, fixes, and validation. |
| `run_scout` | `/scout <task-or-@target>` | `task`, `outputFile?`, `includeOutput?` | Context gathering should be isolated into a compact handoff report. |
| `run_worker` | `/work <task-or-@file>` | `task`, `purpose?`, `outputFile?`, `includeOutput?` | Direct implementation, fix, or validation is enough. |
| `run_workers_parallel` | `/work-parallel <json>` | `tasks[{name?, task, purpose?, outputFile?}]` | Multiple tasks are independent and unlikely to edit the same files. |
| `run_reviewers` | `/review [options] <target> [focus]` | `target`, `focus?`, `extraContext?`, `reviewers?`, `includeScout?`, `continueOnReviewerFailure?`, `includeOutput?` | Existing target needs review-only fanout. |

Tool results are summary-first by default. Set `includeOutput: true` for inline child/synthesis output, or set `PI_SIMPLE_SUBAGENTS_VERBOSE_RESULTS=1` before starting Pi for verbose slash-command/debug output.

### Child-only tools

| Tool | Available to | Purpose |
| --- | --- | --- |
| `run_role_agent` | orchestrator only | Delegate a concrete child role task. |
| `mark_review_clean` | orchestrator only | Record that the latest worker changes have a clean synthesized review. Informational only. |
| `write_run_artifact` | all child roles | Write expected handoff artifacts under the run directory. |
| `compact_session` | all child roles | Ask Pi to compact the child session while preserving role-specific state. |

### Role/session policy

| Role | Purpose | Session policy | Typical artifact |
| --- | --- | --- | --- |
| `orchestrator` | workflow control | one persistent session per run | `orchestration.md`, `final-summary.md` |
| `scout` | context | fresh session per scout call | `scout.md`, `scout-report.md` |
| `worker` | implementation, fix, validation | persistent worker session per orchestration run | `worker.md`, `accepted-fixes-round-N.md`, `validation.md` |
| `reviewer` | review | fresh session per review round/reviewer | `review-round-N.md`, `review-*.md` |
| `synthesis` | review synthesis | fresh synthesis session | `final-summary.md` |

`run_role_agent` calls are serialized inside an orchestration run so the persistent worker session is not shared concurrently. Use `/work-parallel` only when tasks are intentionally independent and can use isolated child run directories.

### LLM routing guidance

The extension exposes prompt guidance on each root tool:

- Prefer `run_scout` before implementation when the task is not obviously trivial.
- Use `run_reviewers` for review-only work. Keep the review-specific scout enabled unless the user asks to skip it.
- Use `run_orchestrator` for plan-driven implementation that benefits from scout/worker/reviewer coordination.
- Use `run_worker` for direct implementation, fix, or validation tasks that do not need a full orchestration loop.
- Use `run_workers_parallel` only for clearly independent tasks unlikely to edit the same files.

## Run artifacts

Every run writes durable audit artifacts. Keep the artifact directory ignored/private when targets may contain sensitive data.

### Orchestration

```text
.pi/agent-runs/<run-id>/
  input-plan.md
  config-effective.json
  orchestration-state.json
  orchestration.md
  delegations/
  logs/
  outputs/
  prompts/
  sessions/
  tasks/
  accepted-fixes-round-N.md
  validation.md
  final-summary.md
```

### Standalone scout

```text
.pi/agent-runs/<run-id>/
  input-scout-task.md
  config-effective.json
  scout-report.md
  logs/
  outputs/
  prompts/
  sessions/
  tasks/
```

### Standalone worker

```text
.pi/agent-runs/<run-id>/
  input-worker-task.md
  config-effective.json
  worker-report.md
  logs/
  outputs/
  prompts/
  sessions/
  tasks/
```

### Parallel workers

```text
.pi/agent-runs/<run-id>/
  parallel-workers.md
  parallel-workers-summary.md
  config-effective.json
  01-<worker-name>/
    input-worker-task.md
    worker-report.md
    logs/
    outputs/
    prompts/
    sessions/worker.jsonl
    tasks/
  02-<worker-name>/
    ...
```

### Review target

```text
.pi/agent-runs/<run-id>/
  input-target.md
  config-effective.json
  extra-review-context.md        # when extraContext/--context is provided
  scout-review-context.md        # when scout is enabled
  review-*.md
  final-summary.md
  review-failure-summary.md      # only when reviewer fanout fails
  logs/
  outputs/
  prompts/
  sessions/
  tasks/
```

Artifact writes are constrained to the run directory. Expected child handoff artifacts must exist at the configured relative path. Reserved internal directories such as `logs`, `outputs`, `prompts`, `sessions`, `tasks`, and `delegations` cannot be used as child output targets.

## Configuration reference

Project config:

```text
.pi/pi-simple-subagents/config.json
```

Global defaults:

```text
~/.pi/agent/pi-simple-subagents/config.json
```

Project config overrides global config, except project config is not allowed to set `children.piCliPath` because that value is executed as a child process. Put CLI path overrides in `PI_SIMPLE_SUBAGENTS_PI_CLI` or the global config only when you trust that environment/global profile.

| Key | Default | Description |
| --- | --- | --- |
| `roles.<role>.model` | role-specific | Model for `orchestrator`, `scout`, `worker`, `reviewer`, or `synthesis`. |
| `roles.<role>.thinking` | role-specific | Thinking suffix: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `children.forwardCurrentExtension` | `"auto"` | Forward this extension to child runs when loaded with `-e/--extension`. Use `always` or `never` to force behavior. |
| `children.timeoutMs` | `1800000` | Per-child-process timeout in ms; `0` disables it. |
| `children.maxConcurrentSubagents` | `8` | Concurrency cap for parallel workers and review reviewers. |
| `children.piCliPath` | unset | Trusted Pi CLI override. Global config or env var only; must be an absolute path to an existing regular file. |
| `orchestration.maxWorkerTaskBytes` | `16384` | Max UTF-8 bytes for one worker handoff; `0` disables the limit. |
| `references.maxFileBytes` | `1048576` | Max bytes loaded from one `@file`; `0` disables truncation. |
| `references.allowOutsideCwd` | `false` | Allow references outside the current project. |
| `references.allowBinary` | `false` | Allow binary-looking files to be decoded as UTF-8. |
| `artifacts.baseDir` | `.pi/agent-runs` | Run artifact directory. Existing parent components must not be symlinks/junctions. |
| `artifacts.cleanup.maxAgeMs` | `0` | Delete extension-owned run directories older than this many milliseconds; `0` disables age cleanup. |
| `artifacts.cleanup.maxTotalBytes` | `0` | Delete oldest extension-owned run directories until total run-artifact bytes fit under this quota; `0` disables size cleanup. |

Unknown config keys are rejected so typos fail early.

## Operational guardrails

This extension adds workflow structure and auditability, not a confidentiality or OS sandbox.

- Role runs inherit the normal Pi tool surface; scout/reviewer/orchestrator source edits are not blocked.
- Child process timeout defaults to 30 minutes (`children.timeoutMs`).
- Review and parallel-worker fanout concurrency defaults to 8 (`children.maxConcurrentSubagents`).
- Worker tasks/handoffs have a configurable maximum size (`orchestration.maxWorkerTaskBytes`).
- `@file` references are project-local, non-binary, and capped at 1 MiB by default.
- Child stdout/stderr/transcript artifacts are capped to prevent runaway disk/context growth.
- Plan/review/validation gates are orchestration choices, not hard enforcement.
- Run only on trusted projects or inside an external sandbox when agents may execute untrusted code or access secrets.

Reviewers and review synthesis use an explicit finding threshold: report an item only when it is likely to produce measurable improvement in correctness, security, reliability, performance/cost, packaging/installability, user-facing behavior, documentation accuracy, or test/maintenance risk.

## Compaction policy

Pi auto-compaction still applies per child session. In addition, child roles with a run directory can call `compact_session` when context gets long.

The compaction request preserves:

- original plan/task/target and current goal
- scout-specific inspected files/docs, key findings, risks, open questions, and expected report artifact
- changed files and implementation decisions when source work happened
- open reviewer findings and accepted fixes
- validation state and deferred items
- run artifact paths

Artifacts remain the source of truth after compaction.

## Development and release

```bash
npm ci
npm run typecheck
npm test
npm run check
npm run release:check
npm pack --dry-run
```

Release smoke checklist:

1. `npm run check`
2. `npm run release:check`
3. Install or load the checkout in a compatible Pi runtime.
4. Reload Pi.
5. Smoke `/orchestrate`, `/scout`, `/work`, `/work-parallel`, `/review`, artifact writing, and child `compact_session`.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Unknown slash option or JSON field | Fix the option/key and rerun; parser errors happen before child processes start. |
| Config schema error | Remove unknown/legacy keys; keep `children.piCliPath` in global config/env only. |
| Child CLI discovery failure | Set `PI_SIMPLE_SUBAGENTS_PI_CLI=/absolute/path/to/pi` or global `children.piCliPath`; inspect `logs/*.invocation.json`. |
| Timeout or truncated output | Inspect `logs/*.stderr.log`, `logs/*.jsonl`, and `outputs/*.md`; adjust caps only for trusted workloads. |
| Unexpected model/API cost | Lower `children.maxConcurrentSubagents`. |
| Partial parallel failure | Read `parallel-workers-summary.md`. |
| Partial review fanout failure | Read `review-failure-summary.md`; optionally rerun with `--continue-on-reviewer-failure`. |
| Artifact path/ownership error | Ensure expected output artifacts are regular files under the run directory and not in reserved dirs. |

## Cleanup and retention

Run artifacts are intentionally durable and may contain sensitive data. By default the extension does not auto-delete `.pi/agent-runs` because both cleanup knobs default to `0`.

Optional automatic cleanup can be enabled in config:

```json
{
  "artifacts": {
    "cleanup": {
      "maxAgeMs": 2592000000,
      "maxTotalBytes": 1073741824
    }
  }
}
```

Behavior and safety constraints:

- Cleanup runs at the start of root workflows after the new active run directory is created and marked active.
- The current active run and other concurrently active runs are always excluded, even if they are older than `maxAgeMs` or larger than `maxTotalBytes`.
- Active runs are identified by the `.pi-simple-subagents-active-run` marker file, which is created when a root workflow starts and removed when it finishes where practical. If a process crashes, a stale marker fails safe by preserving that run for manual cleanup.
- Only immediate child directories under the configured `artifacts.baseDir` that look like this extension's run directories are eligible. A directory must contain `config-effective.json`; unrelated/foreign directories are left alone.
- Symlink entries are not followed for size accounting and are not considered owned run directories.
- Age cleanup deletes eligible runs whose directory mtime is older than `Date.now() - artifacts.cleanup.maxAgeMs`.
- Size cleanup computes total bytes for eligible owned runs plus the active run, then deletes the oldest non-active eligible runs until the quota is met or no more eligible runs remain.
- When cleanup is configured, command/tool summaries include an `Artifact cleanup` line with deleted run count, deleted bytes, retained runs, and error count when applicable. No cleanup line is shown when both cleanup knobs are `0`.

Manual cleanup is still fine when you prefer to review first:

```bash
# review old runs first
find .pi/agent-runs -mindepth 1 -maxdepth 1 -type d -mtime +30 -print

# delete after review
find .pi/agent-runs -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

PowerShell:

```powershell
Get-ChildItem .pi/agent-runs -Directory | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30)
Get-ChildItem .pi/agent-runs -Directory | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item -Recurse -Force
```

If `artifacts.baseDir` points outside the project, prune or configure cleanup for that directory instead.

## Status display

Interactive Pi shows child-agent progress in a stable multi-line block. Slash commands use the same progress as a below-editor widget so long activity lines do not make the footer jump.

```text
Subagents: ⠋ working
- ✓ worker     │ ↑1k ↓2k R3k W4.0k $0.123 3.7%/272k (auto) - gpt-5.5 • medium │ finished
- • reviewer-1 │ ↑867 ↓103 R31k $0.023 11.8%/272k (auto) - gpt-5.5 • low     │ read references.ts
```

The context percentage is estimated from the latest child response token total and known model-family context windows; child processes do not currently expose Pi's exact parent footer context calculation.
