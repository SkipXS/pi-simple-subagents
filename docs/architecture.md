# Architecture

`pi-simple-subagents` is a Pi extension that coordinates multiple child Pi processes with role-specific prompts and durable run artifacts. It is intentionally lightweight: the extension does not enforce a hard sandbox, but it does provide role guidance, artifact safety checks, run lifecycle tracking, and process cleanup.

## Module map

| Module | Responsibility |
| --- | --- |
| `index.ts` | Extension entrypoint: detects root/child role mode, registers tool groups, and owns child-role delegation/state tools. |
| `commands.ts` | Root-mode slash command registration and command-to-workflow adapters. |
| `summaries.ts` | Shared child/workflow result summary formatting for tool and slash-command responses. |
| `rendering.ts` | TUI renderers for tool calls/results. Keeps display formatting separate from registration/execution logic. |
| `progress.ts` | Live subagent status aggregation, status-table formatting, and final progress snapshots embedded in tool details. |
| `workflows.ts` | High-level workflow implementations for orchestrator, review, scout, worker, and parallel-worker runs. Owns run directory setup, task/reference preparation, fanout, expected artifact checks, and cleanup summaries. |
| `child-runner.ts` | Spawns child Pi processes, builds CLI invocations, streams/parses JSONL events, captures transcripts/stderr/output artifacts, forwards status/usage, and cleans up process trees on abort/timeout or lingering terminal output. |
| `artifacts.ts` | Run/artifact path resolution, symlink/hardlink protections, atomic writes, active-run markers, and configurable cleanup of extension-owned run directories. |
| `config.ts` | Default config, strict global/project config parsing, role timeouts, extension forwarding config, and project-local safety restrictions. |
| `references.ts` | `@file`/directory reference parsing and bounded file reading with CWD/binary/size guardrails. |
| `schemas.ts` | Tool schemas exposed to Pi. |
| `role-registry.ts`, `roles.ts`, `prompts.ts` | Role metadata, role/purpose validation, environment names, child prompts, and role-specific tool guidance. |
| `state.ts` | Orchestrator state persistence and quarantine of corrupt state files. |
| `text.ts`, `constants.ts` | Shared text truncation helpers and filenames/schema-key constants. |

## Runtime modes

The extension starts in one of two modes:

1. **Root mode**: no `PI_SUBAGENT_ROLE` env var. Registers user-facing tools and slash commands (`run_orchestrator`, `run_reviewers`, `run_scout`, `run_worker`, `run_workers_parallel`, and corresponding slash commands).
2. **Child role mode**: `PI_SUBAGENT_ROLE` is set. Registers role-scoped tools used by child agents (`write_run_artifact`, `compact_session`, and orchestrator-only delegation/state helpers).

Role sessions are cooperative behavior boundaries, not security boundaries. Child Pi processes inherit the parent user's environment and normal Pi/client tool access unless the host/client itself restricts them.

## Workflow lifecycle

A typical standalone workflow follows this sequence:

1. Load config from defaults, global config, then project config.
2. Resolve/create the run artifact base and run directory.
3. Mark the run active with `.pi-simple-subagents-active-run`.
4. Write input/config/task artifacts.
5. Spawn one or more child Pi processes through `child-runner.ts`.
6. Require expected handoff artifacts where applicable.
7. Capture child output, transcripts, stderr, usage/status, and workflow summary.
8. Clear the active marker and optionally run artifact cleanup.

Review workflows add an optional scout phase, parallel reviewer fanout, partial failure summary support, and final synthesis.

Orchestrator workflows keep state across delegated role calls so accepted fixes can reuse the right worker session and review/verification rounds can be tracked.

## Child process lifecycle

`child-runner.ts` starts child Pi with:

- `--mode json`
- a session file under the run directory
- role model/thinking settings
- role system prompt via `--append-system-prompt`
- a task file referenced with `-p @task-file`

The runner parses child JSONL stdout incrementally. It stores a capped transcript artifact, stores capped stderr, extracts final assistant output, updates live subagent status, and records protocol errors when JSONL is malformed or missing terminal assistant output.

Cleanup behavior:

- Abort/timeout sends process-tree termination (`taskkill /t /f` on Windows; process-group signals on Unix).
- Unix timeout/abort keeps the `SIGKILL` fallback alive long enough to clean descendants even if the direct child exits early.
- If a child emits terminal assistant output but its process remains alive, a short grace timer terminates the lingering process tree while preserving the valid result. This protects review/synthesis fanouts from stuck MCP child processes.

Non-terminal assistant stop reasons such as `toolUse` do **not** trigger lingering cleanup, because the child is expected to continue after tool execution.

## Artifact safety

Run artifacts are intentionally durable because they are the handoff contract between agents. Safety checks include:

- child output paths must stay inside the run directory;
- reserved files/directories are blocked for child writes;
- symlink/junction parents are rejected for artifact bases;
- hardlinked append targets are rejected;
- writes use temp-file/rename where appropriate;
- active run markers prevent cleanup of in-progress runs;
- project-local config cannot move artifact cleanup outside the workspace.

## Config precedence and trust

Config precedence:

1. built-in defaults;
2. global config: `~/.pi/agent/pi-simple-subagents/config.json`;
3. project config: `.pi/pi-simple-subagents/config.json`.

Project config is treated as less trusted than global config. For example, project config cannot set `children.piCliPath`, cannot use absolute/outside-CWD artifact bases, and cannot configure cleanup for external artifact bases.

## Testing strategy

The suite focuses on:

- strict config validation and legacy-key rejection;
- artifact path/cleanup safety;
- reference parsing and guardrails;
- child process runtime behavior and cleanup edge cases;
- workflow fanout, failure summaries, and result ordering;
- packaging metadata and pack allowlist.

Useful local gates:

```bash
npm run check
npm run smoke:pack
npm run release:check
```

CI additionally runs the check matrix across Ubuntu, Windows, and macOS, and tests the supported Pi host API range.

## Refactor guidance

Keep these seams intact when changing behavior:

- UI rendering changes belong in `rendering.ts`.
- Progress/status formatting belongs in `progress.ts`.
- Child process/protocol/lifecycle changes belong in `child-runner.ts` and should get runtime tests.
- Workflow sequencing belongs in `workflows.ts` and should preserve run artifact names/contracts.
- Tool registration and child-role state belong in `index.ts`; root slash-command registration belongs in `commands.ts`. Keep both adapter-focused.
- Safety policy changes need tests in `tests/safety.test.ts` or targeted workflow/runtime tests.
