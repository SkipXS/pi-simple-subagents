# Pi Simple Subagents

Small, opinionated Pi extension for plan-driven orchestration with four roles:

- `orchestrator` decides the workflow.
- `scout` gathers context and writes handoff artifacts.
- `worker` is the main implementation/fix/validation role.
- `reviewer` performs post-implementation or target review.

## Quickstart

1. Install dependencies for a local checkout:

   ```bash
   npm ci
   npm run check
   ```

2. Install the extension into Pi, copy the example config, and reload Pi:

   ```bash
   pi install /absolute/path/to/pi-simple-subagents
   mkdir -p .pi/pi-simple-subagents
   cp /absolute/path/to/pi-simple-subagents/examples/config.json .pi/pi-simple-subagents/config.json
   ```

   ```text
   /reload
   ```

3. Smoke-test one short command and inspect the reported run artifact path:

   ```text
   /scout Summarize the repository layout and write a compact scout report
   ```

## Installation

Requires Node.js `>=22.19.0` and Pi `@earendil-works/pi-coding-agent` `>=0.78.0 <1`. The Pi host API is declared as a peer dependency with that range; runtime libraries used directly by the extension are declared in `dependencies`. Before widening the peer range, smoke-test the package with the candidate Pi version because the extension depends on Pi host APIs for tools, slash commands, UI updates, and session compaction.

Local development install:

```bash
pi install /absolute/path/to/pi-simple-subagents
# or, from the repository parent:
pi install ./pi-simple-subagents
```

After publishing to GitHub, prefer a pinned tag or commit for reproducible installs:

```bash
pi install git:https://github.com/SkipXS/pi-simple-subagents#v0.1.0
# or a specific commit:
pi install git:https://github.com/SkipXS/pi-simple-subagents#<commit-sha>
```

For quick testing, you can also install the moving default branch:

```bash
pi install git:https://github.com/SkipXS/pi-simple-subagents
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

## Development

```bash
npm ci
npm run typecheck
npm test
npm run check
npm pack --dry-run
```

Use `npm ci` for reproducible local setup and CI validation from `package-lock.json`; missing `node_modules` will otherwise surface as dependency-resolution errors when tests import Pi packages. `npm run check` runs typecheck plus tests. `prepack` and `prepublishOnly` run the same check automatically before packing or publishing. `npm pack --dry-run` publishes the extension source, examples, README, LICENSE, and package metadata. Tests and `tsconfig.json` are development-only files in this repository.

Release/package smoke checklist:

1. `npm run check`
2. `npm pack --dry-run`
3. Install or load the checkout in a Pi version satisfying the peer range (`>=0.78.0 <1`).
4. Reload Pi, then smoke `/orchestrate`, `/scout`, `/work`, `/work-parallel`, `/review`, artifact writing, and (inside a child role session) `compact_session`.


For local Pi testing, install or load the package from this checkout, then reload Pi after source/config changes:

```bash
pi install /absolute/path/to/pi-simple-subagents
# or for a temporary one-off run:
pi -e /absolute/path/to/pi-simple-subagents/extensions/pi-simple-subagents/index.ts
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

The orchestrator receives a short prompt plus the plan content/reference, then coordinates scout/worker/reviewer. Before the first worker call it is instructed to break milestones into small work packages; one worker handoff should not be a full milestone or broad plan section. Worker and reviewer loop while it is useful; there is no default hard review-round cap.

Standalone scout for context gathering before implementation or review. Prefer a short scout when the task is not obviously trivial: non-trivial scope, cross-file impact, behavior/API/security/packaging changes, unfamiliar code, ambiguity, or likely side effects. Skip it for clearly isolated, low-risk single-location edits or when the user explicitly asks to proceed directly.

```text
/scout @extensions/pi-simple-subagents
/scout Find the relevant Pi extension APIs and summarize only what the parent needs
/scout Map current parser behavior, affected files, risks, and recommended next steps before implementation
```

or let the model call `run_scout_agent` for the full schema (`task`, optional `outputFile`, optional `includeOutput`). This creates a fresh run directory, starts one `scout`, and requires the scout to write `scout-report.md` by default via `write_run_artifact`. It does not start worker/reviewer/orchestrator and is intended to keep broad reading out of the parent context while producing a compact handoff with relevant files, current behavior, risks, and next steps.

Standalone worker for direct implementation/fix/validation work:

```text
/work @docs/task.md
/work Fix the failing parser test and run the focused test suite
```


or let the model call `run_worker_agent` for the full schema (`task`, optional `purpose`, optional `outputFile`, optional `includeOutput`). This creates a fresh run directory, starts one `worker`, and requires the worker to write `worker-report.md` by default via `write_run_artifact`. Keep worker tasks to one small work package; oversized worker tasks are rejected by `orchestration.maxWorkerTaskBytes` unless that limit is set to `0`. It does not start scout/reviewer/orchestrator.

Parallel workers for independent tasks:

```text
/work-parallel ["Update README usage examples","Add parser regression tests"]
/work-parallel [{"name":"docs","task":"Update README usage examples"},{"name":"tests","task":"Add parser regression tests"}]
/work-parallel {"tasks":[{"name":"docs","task":"Update README usage examples"},{"name":"tests","task":"Add parser regression tests"}]}
```

The slash command accepts JSON only: either an array of task strings, an array of task objects, or an object with a `tasks` array. It requires 2-8 tasks. Object fields are `task` (required non-empty string), `name` (optional string), `purpose` (optional `implementation`, `fix`, or `validation`), and `outputFile` (optional string). Unknown fields such as `output_file`, invalid JSON, wrong task count, unsupported shapes, or invalid fields are reported in the Pi UI and do not start workers.

Common `/work-parallel` JSON pitfalls:

- JSON does not allow trailing commas or comments.
- Use double quotes for JSON strings and property names; single quotes are not JSON.
- Escape literal backslashes in Windows paths, e.g. `C:\\Users\\me\\task.md`, or use forward slashes where possible.
- If your shell/TUI consumes quotes, paste the JSON directly into Pi or wrap/escape it according to your shell.
- Use `outputFile` exactly, not `output_file`; unknown fields are rejected before workers start.
- Provide at least two tasks; use `/work` for one standalone worker.

or let the model call `run_parallel_workers` with `tasks: [{ name?, task, purpose?, outputFile? }, ...]`. Each worker gets its own child run directory and `sessions/worker.jsonl`, so their transcripts do not collide. YOLO mode still does not prevent source edit conflicts; use this only when tasks are independent enough that workers are unlikely to edit the same files. Setup/spawn errors abort sibling workers and wait for shutdown; ordinary non-zero child exits are collected so siblings can finish, then `parallel-workers-summary.md` is written and the batch fails.

Review fanout for an existing target:

```text
/review @extensions/pi-simple-subagents/index.ts focus on runtime bugs, security, packaging, and UX
```

The text after the target is treated as focus/instructions. Use explicit `--reviewer` options when you want custom reviewer angles.

The slash command also accepts a small option prefix before the target. Unknown `--...` options are rejected before any review starts so typos do not turn into accidental inline targets. Use a literal `--` end-of-options sentinel when the target itself starts with hyphens, e.g. `/review -- --fixture docs focus`. Use `--context` to pass a compact prior scout report or other supplemental context; reviewers are instructed to treat it as orientation and verify it against current files. Each `--context` or `--reviewer` option consumes exactly one token, so multi-word values must be quoted. Unmatched single or double quotes are reported as command syntax errors before any review starts:

```text
/review [--scout|--no-scout] [--context <inline-or-@file>|--context=<inline-or-@file>] [--reviewer <angle>|--reviewer=<angle>]... [--] @path-or-dir [focus/instructions]
/review --context @.pi/agent-runs/<run-id>/scout-report.md --reviewer "security boundaries" --reviewer "packaging UX" @extensions/pi-simple-subagents
/review --context "prior scout notes with spaces" --reviewer "runtime correctness" @README.md docs focus
/review -- --fixture docs focus
```

or let the model call `review_target` for the full schema (`target`, `focus`, `extraContext`, `reviewers`, `includeScout`, `includeOutput`). This creates a run directory, writes optional supplemental context to `extra-review-context.md`, runs an optional review-specific scout, then starts fresh reviewers with distinct angles in parallel, preserves their configured order for synthesis, and writes a synthesized `final-summary.md`. Custom reviewer fanout is capped at 8 reviewers. If reviewer fanout fails, the extension writes `review-failure-summary.md` before throwing. It does not run a worker; in YOLO mode the extension does not enforce source-write restrictions.

## LLM routing guidance

The extension exposes prompt guidelines on each root tool so models can choose the right workflow:

- Prefer `run_scout_agent` before implementation when the task is not obviously trivial: non-trivial scope, cross-file impact, behavior/API/security/packaging changes, unfamiliar code, ambiguity, or likely side effects. Ask for a compact handoff report and avoid implementation changes; skip it for clearly isolated low-risk single-location edits.
- Use `review_target` for review-only work. Keep the review-specific scout enabled unless the user asks to skip it, and pass a prior `scout-report.md` as `extraContext` when available.
- Use `orchestrate_plan` for plan-driven implementation that benefits from scout/worker/reviewer coordination and review/fix loops.
- Use `run_worker_agent` for direct implementation, fix, or validation tasks that do not need a full orchestration loop.
- Use `run_parallel_workers` only for clearly independent tasks unlikely to edit the same files; avoid it for overlapping refactors or ordered dependencies.

## Tool and role option reference

Root tools/commands:

| Tool | Slash command | Key options | Use when |
| --- | --- | --- | --- |
| `orchestrate_plan` | `/orchestrate <plan-or-@file>` | `plan`, `includeOutput?` | Plan-driven implementation should coordinate scout, worker, review, fixes, and validation. |
| `run_scout_agent` | `/scout <task-or-@target>` | `task`, `outputFile?`, `includeOutput?` | Context gathering for non-trivial, uncertain, cross-file, or side-effect-prone work should be isolated into a compact handoff report. |
| `review_target` | `/review [options] <target> [focus]` | `target`, `focus?`, `extraContext?`, `reviewers?`, `includeScout?`, `includeOutput?` | Review-only fanout should inspect a target and synthesize findings without running a worker. |
| `run_worker_agent` | `/work <task-or-@file>` | `task`, `purpose?`, `outputFile?`, `includeOutput?` | Direct implementation, fix, or validation is enough and no full review loop is needed. |
| `run_parallel_workers` | `/work-parallel <json>` | `tasks[{name?,task,purpose?,outputFile?}]` | Multiple implementation/fix/validation tasks are independent and unlikely to touch the same files. |

Role options available to the orchestrator through `run_role_agent`:

| Role | Allowed `purpose` | Session policy | Typical output artifact |
| --- | --- | --- | --- |
| `scout` | `context` | Fresh session per scout call | `scout.md`, then `scout-1.md` if needed, or explicit names like `scout-review-context.md` |
| `worker` | `implementation`, `fix`, `validation` | Persistent `sessions/worker.jsonl` per orchestration run | `worker.md`, then `worker-1.md` if needed, or explicit names like `accepted-fixes-round-N.md`, `validation.md` |
| `reviewer` | `review` | Fresh session per review round | `reviewer.md`, then `reviewer-1.md` if needed, or explicit names like `review-round-N.md` |

Child-only tools:

| Tool | Available to | Purpose |
| --- | --- | --- |
| `run_role_agent` | orchestrator only | Delegate a concrete role task; role/purpose combinations above are enforced. |
| `mark_review_clean` | orchestrator only | Record that the latest worker changes have a clean synthesized review; informational, not a validation gate. |
| `write_run_artifact` | all child roles | Write handoff artifacts under the run dir. Expected role outputs must use the exact relative filename from `Expected output artifact`; absolute paths and reserved internal dirs like `logs`, `outputs`, `sessions`, `tasks` are rejected. |
| `compact_session` | all child roles | Request Pi compaction while preserving role-specific task/target, scout findings, decisions, changed files, validation state, and artifact paths. |

## Important workflow guidance

Root command/tool success messages are summary-first by default: run directory, handoff/final artifact paths, transcripts, and a reminder that full child output is in artifacts. This keeps chat results short while preserving auditability. To include child/synthesis output inline for a tool call, pass `includeOutput: true`; for slash commands or debugging, set `PI_SIMPLE_SUBAGENTS_VERBOSE_RESULTS=1` before starting Pi.

Pi is YOLO by default, and this extension follows that model for source edits and tool use. The workflow suggests roles and artifacts, but it does not impose hard source-file, snapshot, validation, review-round, or role-write guardrails. It does enforce a configurable maximum worker task/handoff size so a whole milestone is less likely to be dumped into the first worker. It also includes a configurable child process timeout plus reference/artifact safety guardrails to reduce accidental runaway child runs, huge/binary context ingestion, and artifact path/link surprises.

- Scout, reviewer, orchestrator, and worker can use the normal Pi tool surface.
- Any role may run scripts, tests, benchmarks, downloads, browser/user-flow checks, or diagnostics when useful.
- Worker is still the intended role for implementation/fixes, and can be used through orchestration, directly via `run_worker_agent`/`/work`, or concurrently via `run_parallel_workers`/`/work-parallel`, but this is guidance rather than an enforced sandbox.
- `mark_review_clean` records the orchestrator's synthesized review state; it does not gate validation in YOLO mode.
- `run_role_agent` calls are serialized by default so the orchestrator's persistent worker session is not shared concurrently. Use `run_parallel_workers` when you intentionally want multiple standalone workers with isolated session files.
- Run artifacts remain the audit trail: plans, delegations, logs, outputs, review summaries, validation notes, and final summaries.
- `run_role_agent` default handoff names avoid overwriting existing artifacts in the run directory: the first worker default is `worker.md`, then `worker-1.md`, and similarly for scout/reviewer or round labels. For iterative loops, prefer explicit readable names such as `review-round-1.md`, `accepted-fixes-round-1.md`, `review-round-2.md`, and `validation.md`.
- Expected child handoff artifacts are now required to exist at their configured relative path under the run directory. Missing artifacts fail the parent workflow instead of silently copying the child chat output, which prevents wrong-path writes such as Windows drive paths accidentally normalized to `/d/...`.

## Tool policy

Pi is intentionally YOLO by default, and this extension follows that model for role tool access while adding a few operational guardrails:

- Role runs do not pass a restrictive `--tools` allowlist; every role gets the normal inherited Pi tool surface.
- Child runs have a configurable per-child-process timeout (`children.timeoutMs`, default 30 minutes; set `0` to disable). Timeout kills that child process tree where supported and marks `timedOut` in results; multi-phase workflows can run longer than one timeout window because scout, worker, reviewer, and synthesis phases are separate children.
- Worker tasks/handoffs have a configurable maximum size (`orchestration.maxWorkerTaskBytes`, default 16 KiB; set `0` to disable). This is intended to catch accidental delegation of an entire milestone/full plan section to the first worker; split into smaller packages with one deliverable, likely files, acceptance criteria, non-goals, and validation.
- Child runs normally discover Pi from the installed `@earendil-works/pi-coding-agent` package `bin`. If your install layout is unusual, set `PI_SIMPLE_SUBAGENTS_PI_CLI=/absolute/path/to/pi` (or `pi.cmd` on Windows) or configure `children.piCliPath` in the global config; the environment variable wins. Treat both as trusted executable overrides. Project config may not set `children.piCliPath` because it is executable trust.
- Child stdout/stderr/transcript artifacts are capped to avoid unbounded disk/context growth; chat previews remain separately truncated. A single child stdout JSONL line is accepted up to the transcript artifact cap (4 MiB) and then fails clearly as oversized output.
- Plan/target/task `@` file references default to project-local, non-binary, and at most 1 MiB. Configure `references.allowOutsideCwd`, `references.allowBinary`, and `references.maxFileBytes` when you intentionally need broader access.
- Artifact writes are constrained to the run directory and refuse/fence link-based append/write/copy surprises.
- Scout/reviewer/orchestrator source edits are not blocked by extension hooks.
- Scout/reviewer child runs are not fenced with source snapshots and are not auto-restored on mutation.
- Orchestration runs do not archive/restore authorized source snapshots.
- Review rounds and validation timing are orchestration choices, not hard gates. Child role-agent tool calls are serialized to protect persistent session files.
- Parallel worker setup/spawn errors abort sibling workers; ordinary non-zero child exits are collected so sibling workers can finish before the batch reports failures.

Unknown config keys are rejected during config loading so typos are visible instead of silently ignored. Before `1.0`, obsolete/legacy config fields are not carried forward; remove them instead of relying on compatibility shims.

This policy is not a confidentiality boundary or OS/container sandbox. Run this extension only on trusted projects or inside an external sandbox when agents may execute untrusted code, access secrets, or run generated scripts. If child CLI discovery fails, set `PI_SIMPLE_SUBAGENTS_PI_CLI=/absolute/path/to/pi` or set `children.piCliPath` in the global config; both values are trusted executable selection and should not come from untrusted repositories or shells.

## Compaction policy

Pi auto-compaction still applies per child session. In addition, every valid child role session that has a run directory (`orchestrator`, `scout`, `worker`, `reviewer`, and `synthesis`) can call `compact_session` when its context gets long. Child-only artifact tools are not registered for a root process that merely has a stale run-directory environment variable. Compaction is most often useful for the persistent `orchestrator` and `worker` sessions, and for standalone/review scouts during broad repository or documentation reconnaissance. The tool requests Pi compaction with instructions to preserve:

- original plan/task/target and current goal
- scout-specific inspected files/docs, key findings, risks, open questions, and expected report artifact
- changed files and implementation decisions when any source work happened
- open reviewer findings and accepted fixes
- validation state and deferred items
- run artifact paths

Artifacts remain the source of truth after compaction.

## Session policy

- `orchestrator` uses one persistent session for the run: `sessions/orchestrator.jsonl`.
- `worker` uses one persistent session for implementation and all fix rounds: `sessions/worker.jsonl`. `run_role_agent` is sequential, so this file is not written by multiple worker processes at the same time.
- `reviewer` gets a fresh session for every review round: `sessions/reviewer-<timestamp>.jsonl`.
- `synthesis` gets a fresh session for review synthesis: `sessions/synthesis-<timestamp>.jsonl`.
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

Project config overrides global config, except project config is not allowed to set `children.piCliPath` because that value is executed as a child process. Put CLI path overrides in `PI_SIMPLE_SUBAGENTS_PI_CLI` or the global config only when you trust that environment/global profile. Unknown keys are treated as config errors to catch typos. Before `1.0`, legacy config fields are rejected rather than silently accepted; keep configs on the documented schema below.

Example with explicit balanced YOLO defaults (all sections are optional; omit anything you do not want to override):

```json
{
  "roles": {
    "orchestrator": { "model": "openai-codex/gpt-5.5", "thinking": "medium" },
    "scout": { "model": "openai-codex/gpt-5.3-codex-spark", "thinking": "medium" },
    "worker": { "model": "openai-codex/gpt-5.5", "thinking": "medium" },
    "reviewer": { "model": "openai-codex/gpt-5.5", "thinking": "low" },
    "synthesis": { "model": "openai-codex/gpt-5.5", "thinking": "medium" }
  },
  "children": {
    "forwardCurrentExtension": "auto",
    "timeoutMs": 1800000
  },
  "orchestration": {
    "maxWorkerTaskBytes": 16384
  },
  "references": {
    "maxFileBytes": 1048576,
    "allowOutsideCwd": false,
    "allowBinary": false
  },
  "artifacts": {
    "baseDir": ".pi/agent-runs"
  }
}
```

Config reference:

| Key | Default | Description |
| --- | --- | --- |
| `roles.<role>.model` | role-specific | Model for `orchestrator`, `scout`, `worker`, `reviewer`, or `synthesis`. |
| `roles.<role>.thinking` | role-specific | Thinking suffix: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `children.forwardCurrentExtension` | `"auto"` | `"auto"` forwards this extension to child runs when the parent Pi process was started with `-e/--extension`; `"always"` always adds `--extension <this-extension>`; `"never"` never does. This helps temporary extension loading expose `write_run_artifact` and `compact_session` to child roles. |
| `children.timeoutMs` | `1800000` | Per-child-process timeout in milliseconds. Use `0` to disable. Timed-out child runs return `timedOut: true` and exit code `124`; full multi-phase workflows may exceed this because each phase gets its own child process. |
| `children.piCliPath` | unset | Optional Pi CLI command/path override, allowed only in the global config. `PI_SIMPLE_SUBAGENTS_PI_CLI` environment variable takes precedence. Useful for unusual global installs, Windows, and troubleshooting CLI discovery. Do not accept this value or the environment override from untrusted repos/shells; it is executable trust. |
| `orchestration.maxWorkerTaskBytes` | `16384` | Maximum UTF-8 bytes allowed in one worker task/handoff, including resolved `@file` text for standalone/parallel workers. Use `0` to disable. Oversized tasks fail before spawning so the orchestrator/user can split milestones into smaller work packages. |
| `references.maxFileBytes` | `1048576` | Maximum bytes read from an `@file` reference. Larger files are truncated with a warning. Use `0` to disable truncation. |
| `references.allowOutsideCwd` | `false` | Allow `@` references outside the current project directory. Keep `false` to reduce accidental secret exposure. |
| `references.allowBinary` | `false` | Allow binary-looking `@` files to be decoded as UTF-8. |
| `artifacts.baseDir` | `.pi/agent-runs` | Directory for run artifacts. Relative paths resolve under the current project. The base path and existing parent components must not be symlinks/junctions. |

## Source layout

The extension entrypoint stays in `extensions/pi-simple-subagents/index.ts` and wires Pi tools and commands. Workflow internals are split into focused modules: `config.ts`, `constants.ts`, `roles.ts`, `artifacts.ts`, `references.ts`, `child-runner.ts`, `workflows.ts`, `state.ts`, `schemas.ts`, `prompts.ts`, and `text.ts`.

## Run artifacts

Orchestration runs create:

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

Standalone scout runs create:

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

Standalone worker runs create:

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

Parallel worker runs create a parent directory plus one child run directory per worker:

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

Review-target runs create:

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

Child transcripts, stderr logs, referenced input files, reference warnings, and final outputs are stored under the run directory subject to artifact caps for runaway output. Tool-return previews may still be more concise for chat readability. `artifacts.baseDir` may be inside or outside the current project, but symlinked/junction base paths are rejected to avoid surprising writes elsewhere. Keep the artifact directory ignored/private when targets may contain sensitive data.

## Troubleshooting and failure recovery

- Unknown slash options/fields: `/review` rejects unknown `--...` options before the target; use `/review -- --hyphenated-target` when the target itself starts with hyphens. `/work-parallel` rejects unknown JSON keys. Fix the typo and rerun; no child workers/reviewers are started for parser errors.
- Config parse/schema errors: Pi reports the config path and key. Remove unknown/legacy keys or move trusted `children.piCliPath` overrides to the global config or `PI_SIMPLE_SUBAGENTS_PI_CLI`.
- Child CLI discovery failures: set `PI_SIMPLE_SUBAGENTS_PI_CLI=/absolute/path/to/pi` (or `pi.cmd` on Windows), then rerun the workflow.
- Timeouts/truncated output: inspect `logs/*.stderr.log`, `logs/*.jsonl`, and `outputs/*.md` in the run directory. Increase `children.timeoutMs` or caps only when you trust the workload.
- Partial parallel failures: `parallel-workers-summary.md` lists completed workers, exit codes, output artifacts, transcripts, and setup/spawn errors.
- Partial review fanout failures: `review-failure-summary.md` lists failed reviewers plus any completed reviewer artifacts. Fix the cause and rerun `/review`.
- Artifact ownership/path errors: expected output artifacts must be regular files under the run directory and cannot live in reserved subdirectories (`logs`, `outputs`, `prompts`, `sessions`, `tasks`, `delegations`). Remove accidental directories/symlinks and rerun.

## Subagent status display

While child agents run in interactive Pi, tool calls stream a stable multi-line progress block into the tool-call window. Slash commands (`/orchestrate`, `/work`, `/work-parallel`, `/review`) show the same progress as a below-editor widget instead of using the footer, so long activity lines do not make the footer jump. When an orchestrator delegates via `run_role_agent`, nested scout/worker/reviewer progress is forwarded into the parent block so the user can see which subagent is running. Only the header's working indicator animates quickly; role rows update their activity text at a calmer cadence and keep aligned role plus compact usage/model columns. Finished roles keep their final usage information:

```text
Subagents: ⠋ working
- ✓ worker     │ ↑1k ↓2k R3k W4.0k $0.123 3.7%/272k (auto) - gpt-5.5 • medium │ finished
- • reviewer-1 │ ↑867 ↓103 R31k $0.023 11.8%/272k (auto) - gpt-5.5 • low     │ read references.ts
```

The context percentage is estimated from the latest child response token total and known model-family context windows; child processes do not currently expose Pi's exact parent footer context calculation.
