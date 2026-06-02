# Pi Simple Subagents

Small, opinionated Pi extension for plan-driven orchestration with four roles:

- `orchestrator` decides the workflow.
- `scout` gathers context and writes handoff artifacts.
- `worker` is the main implementation/fix/validation role.
- `reviewer` performs post-implementation or target review.

## Installation

Requires Node.js `>=22.19.0` and Pi `@earendil-works/pi-coding-agent` `>=0.78.0 <1`. The Pi host API is declared as a peer dependency; runtime libraries used directly by the extension are declared in `dependencies`.

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
npm install
npm run typecheck
npm test
npm run check
npm pack --dry-run
```

`npm run check` runs typecheck plus tests. `prepack` and `prepublishOnly` run the same check automatically before packing or publishing. `npm pack --dry-run` publishes the extension source, examples, README, LICENSE, and package metadata. Tests and `tsconfig.json` are development-only files in this repository.

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

The orchestrator receives a short prompt plus the plan content/reference, then coordinates scout/worker/reviewer. Worker and reviewer loop while it is useful; there is no default hard review-round cap.

Standalone worker for direct implementation/fix/validation work:

```text
/work @docs/task.md
/work Fix the failing parser test and run the focused test suite
```


or let the model call `run_worker_agent` for the full schema (`task`, optional `purpose`, optional `outputFile`). This creates a fresh run directory, starts one `worker`, and writes/copies a `worker-report.md` by default. It does not start scout/reviewer/orchestrator.

Parallel workers for independent tasks:

```text
/work-parallel [{"name":"docs","task":"Update README usage examples"},{"name":"tests","task":"Add parser regression tests"}]
```

or let the model call `run_parallel_workers` with `tasks: [{ name?, task, purpose?, outputFile? }, ...]`. Each worker gets its own child run directory and `sessions/worker.jsonl`, so their transcripts do not collide. YOLO mode still does not prevent source edit conflicts; use this only when tasks are independent enough that workers are unlikely to edit the same files.

Review fanout for an existing target:

```text
/review @extensions/pi-simple-subagents/index.ts runtime bugs, security, packaging, UX
```


The slash command also accepts a small option prefix before the target:

```text
/review [--scout|--no-scout] [--reviewer <angle>|--reviewer=<angle>]... @path-or-dir [focus/instructions]
/review --no-scout --reviewer "security boundaries" --reviewer "packaging UX" @extensions/pi-simple-subagents
```

or let the model call `review_target` for the full schema (`target`, `focus`, `reviewers`, `includeScout`). This creates a run directory, runs an optional scout, then starts fresh reviewers with distinct angles in parallel, preserves their configured order for synthesis, and writes a synthesized `final-summary.md`. Custom reviewer fanout is capped at 8 reviewers. It does not run a worker; in YOLO mode the extension does not enforce source-write restrictions.

## Important workflow guidance

Pi is YOLO by default, and this extension follows that model for source edits and tool use. The workflow suggests roles and artifacts, but it does not impose hard source-file, snapshot, validation, review-round, or role-write guardrails. It does include process/reference/artifact safety guardrails to reduce accidental runaway child runs, huge/binary context ingestion, and artifact path/link surprises.

- Scout, reviewer, orchestrator, and worker can use the normal Pi tool surface.
- Any role may run scripts, tests, benchmarks, downloads, browser/user-flow checks, or diagnostics when useful.
- Worker is still the intended role for implementation/fixes, and can be used through orchestration, directly via `run_worker_agent`/`/work`, or concurrently via `run_parallel_workers`/`/work-parallel`, but this is guidance rather than an enforced sandbox.
- `mark_review_clean` records the orchestrator's synthesized review state; it does not gate validation in YOLO mode.
- `run_role_agent` calls are serialized by default so the orchestrator's persistent worker session is not shared concurrently. Use `run_parallel_workers` when you intentionally want multiple standalone workers with isolated session files.
- Run artifacts remain the audit trail: plans, delegations, logs, outputs, review summaries, validation notes, and final summaries.

## Tool policy

Pi is intentionally YOLO by default, and this extension follows that model for role tool access while adding a few operational guardrails:

- Role runs do not pass a restrictive `--tools` allowlist, even if old config files contain `roles.<role>.tools`.
- Child runs have a configurable extension timeout (`children.timeoutMs`, default 30 minutes; set `0` to disable). Timeout kills the child process tree where supported and marks `timedOut` in results.
- Child runs normally discover Pi from the installed `@earendil-works/pi-coding-agent` package `bin`. If your install layout is unusual, set `PI_SIMPLE_SUBAGENTS_PI_CLI=/absolute/path/to/pi` (or `pi.cmd` on Windows) or configure `children.piCliPath`; the environment variable wins.
- Child stdout/stderr/transcript artifacts are capped to avoid unbounded disk/context growth; chat previews remain separately truncated.
- Plan/target/task `@` file references default to project-local, non-binary, and at most 1 MiB. Configure `references.allowOutsideCwd`, `references.allowBinary`, and `references.maxFileBytes` when you intentionally need broader access.
- Artifact writes are constrained to the run directory and refuse/fence link-based append/write/copy surprises.
- Scout/reviewer/orchestrator source edits are not blocked by extension hooks.
- Scout/reviewer child runs are not fenced with source snapshots and are not auto-restored on mutation.
- Orchestration runs do not archive/restore authorized source snapshots.
- Review rounds and validation timing are orchestration choices, not hard gates. Child role-agent tool calls are serialized to protect persistent session files.

Legacy workflow/tool allowlist config fields are accepted but ignored for compatibility; current guardrail fields are documented below.

This policy is not a confidentiality boundary or OS/container sandbox. Run this extension only on trusted projects or inside an external sandbox when agents may execute untrusted code, access secrets, or run generated scripts. If child CLI discovery fails, set `PI_SIMPLE_SUBAGENTS_PI_CLI=/absolute/path/to/pi` or `children.piCliPath`.

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
- `worker` uses one persistent session for implementation and all fix rounds: `sessions/worker.jsonl`. `run_role_agent` is sequential, so this file is not written by multiple worker processes at the same time.
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
    "worker": { "model": "openai-codex/gpt-5.5", "thinking": "medium" },
    "reviewer": { "model": "openai-codex/gpt-5.5", "thinking": "high" }
  },
  "children": {
    "inheritExtensions": true,
    "inheritExtensionsForReadOnly": false,
    "inheritSkills": false,
    "forwardCurrentExtension": "auto",
    "timeoutMs": 1800000,
    "piCliPath": "/optional/path/to/pi-or-pi.cmd"
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
| `roles.<role>.model` | role-specific | Model for `orchestrator`, `scout`, `worker`, or `reviewer`. |
| `roles.<role>.thinking` | role-specific | Thinking suffix: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `children.inheritExtensions` | `true` | Worker children inherit normal Pi extensions. If `false`, the child starts with `--no-extensions --extension <this-extension>`. |
| `children.inheritExtensionsForReadOnly` | `false` | Scout/reviewer children inherit normal Pi extensions. If `false`, they start with only this extension loaded. |
| `children.inheritSkills` | `false` | Child runs inherit Pi skills. |
| `children.forwardCurrentExtension` | `"auto"` | `"auto"` forwards this extension to child runs when the parent Pi process was started with `-e/--extension`; `"always"` always adds `--extension <this-extension>` when extensions are inherited; `"never"` never does. This helps temporary extension loading expose `write_run_artifact` and `compact_session` to worker children. |
| `children.timeoutMs` | `1800000` | Child run timeout in milliseconds. Use `0` to disable. Timed-out runs return `timedOut: true` and exit code `124`. |
| `children.piCliPath` | unset | Optional Pi CLI command/path override. `PI_SIMPLE_SUBAGENTS_PI_CLI` environment variable takes precedence. Useful for unusual global installs, Windows, and troubleshooting CLI discovery. |
| `references.maxFileBytes` | `1048576` | Maximum bytes read from an `@file` reference. Larger files are truncated with a warning. Use `0` to disable truncation. |
| `references.allowOutsideCwd` | `false` | Allow `@` references outside the current project directory. Keep `false` to reduce accidental secret exposure. |
| `references.allowBinary` | `false` | Allow binary-looking `@` files to be decoded as UTF-8. |
| `artifacts.baseDir` | `.pi/agent-runs` | Directory for run artifacts. Relative paths resolve under the current project. |

## Source layout

The extension entrypoint stays in `extensions/pi-simple-subagents/index.ts` and wires Pi tools and commands. Workflow internals are split into focused modules: `config.ts`, `roles.ts`, `artifacts.ts`, `references.ts`, `child-runner.ts`, `workflows.ts`, `state.ts`, `schemas.ts`, `prompts.ts`, and `text.ts`.

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
  scout-review-context.md        # when scout is enabled
  review-*.md
  final-summary.md
  logs/
  outputs/
  prompts/
  sessions/
  tasks/
```

Child transcripts, stderr logs, referenced input files, reference warnings, and final outputs are stored under the run directory subject to artifact caps for runaway output. Tool-return previews may still be more concise for chat readability. `artifacts.baseDir` may be inside or outside the current project; keep the artifact directory ignored/private when targets may contain sensitive data.

## Subagent status display

While child agents run in interactive Pi, the extension publishes one footer status per active subagent via `ctx.ui.setStatus()`. Each status includes an animated spinner, the current activity parsed from child JSON events, and compact usage/model information when available:

```text
⠋ worker: bash npm test  ↑1.0k ↓2.0k R3.0k W4.0k $0.123 3.7%/272k (auto) - gpt-5.5 • medium
⠙ reviewer-1: read references.ts  ↑867 ↓103 R31k $0.023 11.8%/272k (auto) - gpt-5.5 • high
```

The context percentage is estimated from the latest child response token total and known model-family context windows; child processes do not currently expose Pi's exact parent footer context calculation.
