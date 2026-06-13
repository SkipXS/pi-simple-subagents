# Pi Simple Subagents reference

Detailed reference for [Pi Simple Subagents](../README.md).

## Command reference

### `/orchestrate`

```text
/orchestrate @docs/plan.md
/orchestrate Review @src/parser.ts, fix accepted findings, validate, and review again until good enough
```

Use for plan-driven implementation or review/fix workflows that benefit from scout, worker, verifier, reviewer, fix, and validation phases.

Notes:

- The orchestrator receives the prompt plus the plan content/reference or review/fix instruction.
- The orchestrator does not perform verification or review itself; it coordinates fresh verifiers and reviewers, reads their artifacts, routes concrete implementation gaps to the same worker before review, and routes evidence-backed accepted review fixes to worker.
- Before the first worker call it is instructed to break milestones or accepted fixes into small work packages.
- Worker, verifier, and reviewer loop while useful; there is no default hard verification/review-round cap.
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

Use for review-only fanout. By default a review-specific scout runs first, then fresh reviewers inspect the target, and synthesis writes `final-summary.md`. The caller/model should choose the reviewer angles and count for the requested target; use the smallest number of distinct reviewers that covers the real risks. If no reviewer is provided, the extension runs one adaptive general reviewer rather than a fixed three-reviewer checklist.

Options:

| Option | Meaning |
| --- | --- |
| `--scout` / `--no-scout` | Enable or skip the review-specific scout. |
| `--context <inline-or-@file>` | Add compact prior context such as a scout report. |
| `--context=<inline-or-@file>` | Same as above. |
| `--reviewer <angle>` | Add a reviewer angle; repeatable, max 8. Use one for narrow reviews, 2-3 for distinct risk areas, and more only when independent aspects justify the cost. |
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
| `run_orchestrator` | `/orchestrate <plan-or-review/fix-instruction>` | `plan`, `includeOutput?` | Plan-driven or review/fix work should coordinate scout, worker, verifier, reviewers, accepted fixes, and validation. |
| `run_scout` | `/scout <task-or-@target>` | `task`, `outputFile?`, `includeOutput?` | Context gathering should be isolated into a compact handoff report. |
| `run_worker` | `/work <task-or-@file>` | `task`, `purpose?`, `outputFile?`, `includeOutput?` | Direct implementation, fix, or validation is enough. |
| `run_workers_parallel` | `/work-parallel <json>` | `tasks[{name?, task, purpose?, outputFile?}]` | Multiple tasks are independent and unlikely to edit the same files. |
| `run_reviewers` | `/review [options] <target> [focus]` | `target`, `focus?`, `extraContext?`, `reviewers?`, `includeScout?`, `continueOnReviewerFailure?`, `includeOutput?` | Existing target needs one review-only fanout. |

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
| `worker` | implementation, fix, validation | one persistent worker session per work package (`worker-1`, `worker-2`, ...); reuse the same `workerId` for fixes to that package | `worker-1.md`, `accepted-fixes-round-N.md`, `validation.md` |
| `verifier` | validation | fresh session per verification round; checks the latest worker package against its plan before reviewer review | `verification-round-N.md`, `verifier-*.md` |
| `reviewer` | review | fresh session per review round/reviewer | `review-round-N.md`, `review-*.md` |
| `synthesis` | review synthesis | fresh synthesis session | `final-summary.md` |

`run_role_agent` calls are serialized inside an orchestration run. For new implementation work packages, omit `workerId` so the tool assigns the next worker session. After a worker completes, the orchestrator is prompted to run a fresh `verifier` (`purpose=validation`) against that package before starting reviewer review. If verification finds concrete implementation gaps, the orchestrator should run `worker` with `purpose=fix` and the same `workerId`, then verify again. For accepted fixes after reviewing a package, pass that package's `workerId`; if omitted for worker fix/validation, the latest worker is reused. The orchestrator is prompted to verify and review after each implementation package by default; if it starts another implementation worker before the latest package is marked cleanly reviewed, the tool emits a soft batching warning and the orchestrator should record the rationale in `orchestration.md`. Use `/work-parallel` only when tasks are intentionally independent and can use isolated child run directories.

### LLM routing guidance

The extension exposes prompt guidance on each root tool:

- Prefer `run_scout` before implementation when the task is not obviously trivial.
- Use `run_reviewers` for one review-only fanout. Choose `reviewers` explicitly based on the target/focus when calling the tool: one targeted reviewer for narrow work, multiple reviewers only for distinct independent aspects. Keep the review-specific scout enabled unless the user asks to skip it.
- Use `run_orchestrator` for plan-driven implementation or review/fix workflows that benefit from scout/worker/verifier/reviewer coordination. Verifiers check worker packages against the plan before review; reviewers review; the orchestrator sequences the loop and sends only concrete verifier gaps or evidence-backed accepted review fixes to worker.
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
  verification-round-N.md
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

### Handoff report shapes

These shapes are prompt contracts for the child handoff artifacts. The exact filename is provided by the tool call (`outputFile`) or generated by the orchestrator.

#### Scout

```md
# Scout Report
## Relevant files
## Existing behavior
## Risks / unknowns
## Recommended worker context
```

Review-target scouts use:

```md
# Scout Review Context
## Target
## Relevant files
## Existing behavior / architecture
## Risk areas for reviewers
```

#### Worker

```md
# Worker Report
## Changed files
## What was implemented
## Implementation checks run
## Open issues / decisions needed
## Residual risks
```

#### Verifier

Verifier artifacts such as `verification-round-N.md` or `verifier-<worker>-round-N.md` check the assigned worker package against its task and acceptance criteria before reviewer review.

```md
# Verification Report
## Scope checked
## Acceptance criteria status
## Implementation gaps to send back to worker
## Validation evidence / gaps
## Verdict
```

#### Reviewer and synthesis

Orchestration reviewers use:

```md
# Review Report
## Blockers
## Fixes worth doing now
## Optional / deferred
## Validation gaps
## Verdict
```

Review-only target reviewers replace `Validation gaps` with `Evidence`. Synthesis artifacts use:

```md
# Review Synthesis
## Overall verdict
## Blockers
## Fixes worth doing now
## Optional / deferred
## Positive findings / existing strengths
## Evidence reviewed
## Recommended next steps
```

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
| `roles.<role>.model` | role-specific | Model for `orchestrator`, `scout`, `worker`, `verifier`, `reviewer`, or `synthesis`. |
| `roles.<role>.thinking` | role-specific | Thinking suffix: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `roles.<role>.timeoutMs` | orchestrator: `0`; others: unset | Override `children.timeoutMs` for one role; `0` disables that role's timeout. |
| `children.forwardCurrentExtension` | `"auto"` | Forward this extension to child runs when loaded with `-e/--extension`. Use `always` or `never` to force behavior. |
| `children.timeoutMs` | `1800000` | Fallback per-child-process timeout in ms; `0` disables it for roles without `roles.<role>.timeoutMs`. |
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

This extension adds workflow structure and auditability, not a confidentiality, read-only, or OS sandbox.

Verification/review workflows are cooperative by design: `/review`, scout, verifier, reviewer, and synthesis prompts instruct child agents not to modify target/source/generated project files, but the extension intentionally does not enforce a separate read-only tool policy. The normal Pi tool surface remains available so verifiers and reviewers can run diagnostics, tests, benchmarks, and repository-specific evidence-gathering commands when useful. Use an external sandbox/container when the target or commands are untrusted.

### Child environment and credentials

Child Pi processes inherit the parent process environment. This is deliberate for compatibility with normal Pi/model authentication and common developer tooling, but it also forwards any ambient secrets present in the parent shell, such as `*_API_KEY`, `*_TOKEN`, `*_SECRET`, cloud credentials, package registry tokens, proxy credentials, and CI variables.

Pi credentials stored in `~/.pi/agent/auth.json` are not environment variables, but they remain available to child processes that run as the same OS user with the same home/config directory. This includes subscription/OAuth credentials created by `/login` and API keys stored through Pi. Keeping `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` available is usually enough for child Pi processes to use those credentials.

Filtering the inherited environment can reduce accidental exposure of shell-provided secrets, but it is not a complete security boundary in this extension's YOLO model: child agents can still use normal tools, read same-user files, run commands, and access network resources unless an external sandbox prevents it. Use a container, separate user, isolated home directory, restricted credential profile, or other OS-level sandbox when reviewing untrusted repositories or prompts.

- Role runs inherit the normal Pi tool surface; scout/verifier/reviewer/orchestrator source edits are not blocked by the extension.
- Child process timeout defaults to 30 minutes (`children.timeoutMs`) for roles without an override; the orchestrator disables its own timeout by default (`roles.orchestrator.timeoutMs=0`) so long workflows can keep coordinating bounded children.
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
- verifier gaps, open reviewer findings, and accepted fixes
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
✓ worker     │ implementation: fix parser regression      │ finished
             │ ↑1k ↓2k R3k W4.0k CH37.5% $0.123 (sub) 3.7%/272k (auto) │ gpt-5.5 • medium
• verify worker-2 r1 │ validation: check package acceptance criteria │ inspect files
                     │ ↑640 ↓90 R28k CH98.0% $0.018 (sub) 10.4%/272k (auto) │ gpt-5.5 • low
• review worker-2 r1 │ packaging/installability for npm extension   │ read package.json
                     │ ↑867 ↓103 R31k CH98.0% $0.023 (sub) 11.8%/272k (auto) │ gpt-5.5 • low
```

Each subagent shows two lines: role label, short prompt/assignment description, and current activity first; usage/context metrics and model/thinking second. Orchestrated verifier and reviewer status labels are scoped to the latest worker package as `verify worker-N rM` / `review worker-N rM` (for example, `verify worker-2 r1` and `review worker-2 r1` are verification/review round 1 for `worker-2`) so later packages do not overwrite earlier status rows. The model separator on the second line is aligned with the activity separator on the first line, using one shared detail-column width across descriptions and usage metrics. The description is populated for orchestrator, scout, worker, parallel worker, verifier, reviewer, and synthesis roles so verification/review and delegation fanouts are less opaque.

Tool results and slash-command completion messages also preserve the latest `subagentProgress` snapshot and render the same status block in the final summary. This connects the live progress widget with the stable result card so completed runs are not a black box after the widget clears.

Usage metrics follow Pi's current footer order: input/output tokens (`↑`/`↓`), cache read/write (`R`/`W`), latest cache hit rate (`CH`), cost with `(sub)` when the model provider uses OAuth/subscription credentials, and context usage.

The context percentage is estimated from the latest child response token total and known model-family context windows; child processes do not currently expose Pi's exact parent footer context calculation.
