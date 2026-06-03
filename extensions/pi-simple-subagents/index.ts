import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyArtifactFile, validateOutputArtifactPath, writeArtifact } from "./artifacts.ts";
import { childEnvCounts, childResultText, throwChildRunError, spawnPiRole, type ChildStatusUpdate } from "./child-runner.ts";
import { WORK_PARALLEL_ROOT_KEYS, WORK_PARALLEL_TASK_KEYS, WORKER_PURPOSES } from "./constants.ts";
import { loadConfig } from "./config.ts";
import {
	ROLE_ENV,
	REVIEW_RUNS_ENV,
	RUN_DIR_ENV,
	WORKER_RUNS_ENV,
	parseRoleEnv,
	validateRolePurpose,
} from "./roles.ts";
import {
	ArtifactParams,
	CompactSessionParams,
	MarkReviewCleanParams,
	OrchestrateParams,
	ParallelWorkersParams,
	ReviewTargetParams,
	RoleRunParams,
	ScoutAgentParams,
	WorkerAgentParams,
	type ArtifactParams as ArtifactParamsType,
	type CompactSessionParams as CompactSessionParamsType,
	type MarkReviewCleanParams as MarkReviewCleanParamsType,
	type OrchestrateParams as OrchestrateParamsType,
	type ParallelWorkersParams as ParallelWorkersParamsType,
	type ReviewTargetParams as ReviewTargetParamsType,
	type RoleRunParams as RoleRunParamsType,
	type ScoutAgentParams as ScoutAgentParamsType,
	type WorkerAgentParams as WorkerAgentParamsType,
} from "./schemas.ts";
import { readOrchestrationState, writeOrchestrationState } from "./state.ts";
import { parseReviewTargetCommand, runOrchestration, runParallelWorkers, runReviewTarget, runScoutAgent, runWorkerAgent } from "./workflows.ts";

type ToolProgressOnUpdate = ((update: { content: Array<{ type: "text"; text: string }>; details: { subagentProgress: SubagentProgressSnapshot } }) => void) | undefined;
type WidgetSetter = (content: string[] | undefined) => void;

interface SubagentProgressSnapshot {
	statuses: Array<{ key: string; text: string }>;
	current?: string;
}

const ORCHESTRATE_PLAN_GUIDELINES = [
	"Use orchestrate_plan for plan-driven implementation work that benefits from scout/worker/reviewer coordination and review/fix loops.",
	"Do not use orchestrate_plan for review-only work; use review_target instead.",
];

const REVIEW_TARGET_GUIDELINES = [
	"Use review_target for review-only work when the user asks to inspect, audit, or suggest improvements without implementing changes.",
	"Pass a prior scout-report.md or other concise background as review_target.extraContext when available, but reviewers must verify it against current files.",
	"Keep review_target.includeScout enabled unless the user explicitly asks to skip the review-specific scout.",
];

const RUN_SCOUT_AGENT_GUIDELINES = [
	"Use run_scout_agent for broad codebase or documentation reconnaissance before deciding on implementation or review.",
	"Use run_scout_agent to keep large reading out of the parent context; ask it for a compact handoff report with relevant files, risks, and next steps.",
	"Do not use run_scout_agent for implementation changes; use run_worker_agent or orchestrate_plan for source edits.",
];

const RUN_WORKER_AGENT_GUIDELINES = [
	"Use run_worker_agent for direct implementation, fix, or validation tasks that do not need a full orchestrator/reviewer loop.",
	"Do not use run_worker_agent for review-only work; use review_target instead.",
];

const RUN_PARALLEL_WORKERS_GUIDELINES = [
	"Use run_parallel_workers only for clearly independent tasks unlikely to edit the same files.",
	"Do not use run_parallel_workers for overlapping refactors, shared-file edits, or tasks that need one worker's result before another starts.",
];

const STATUS_SPINNER_PATTERN = /^([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+(.+)$/u;

interface ParsedStatusLine {
	spinner?: string;
	label: string;
	status: string;
	action: string;
}

function parseStatusLine(text: string, fallback: string): ParsedStatusLine {
	const trimmed = text.trim();
	const spinnerMatch = STATUS_SPINNER_PATTERN.exec(trimmed);
	const spinner = spinnerMatch?.[1];
	const body = spinnerMatch?.[2] ?? trimmed;
	const separatorIndex = body.indexOf(":");
	if (separatorIndex < 0) return { spinner, label: fallback, status: "", action: body };
	const label = body.slice(0, separatorIndex).trim() || fallback;
	const rest = body.slice(separatorIndex + 1).trim();
	const actionSeparator = rest.lastIndexOf(" - ");
	if (actionSeparator < 0) return { spinner, label, status: "", action: rest };
	return {
		spinner,
		label,
		status: rest.slice(0, actionSeparator).trim(),
		action: rest.slice(actionSeparator + " - ".length).trim(),
	};
}

function finishStatusText(existing: string | undefined, fallback: string): string {
	if (!existing) return `${fallback}: finished`;
	const parsed = parseStatusLine(existing, fallback);
	const prefix = parsed.spinner ? `${parsed.spinner} ` : "";
	return `${prefix}${parsed.label}: ${parsed.status ? `${parsed.status} - finished` : "finished"}`;
}

function requireNonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must be a non-empty string`);
	return trimmed;
}

function assertKnownKeys(record: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
	const unknown = Object.keys(record).filter((key) => !allowedKeys.includes(key));
	if (unknown.length > 0) throw new Error(`${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

function formatSubagentProgress(snapshot: SubagentProgressSnapshot): string {
	if (snapshot.statuses.length === 0) return ["Subagents:", "- starting"].join("\n");
	const parsed = snapshot.statuses.map((status) => ({ key: status.key, ...parseStatusLine(status.text, status.key) }));
	const roleWidth = Math.max(...parsed.map((status) => `${status.spinner ? `${status.spinner} ` : "  "}${status.label}`.length));
	const statusWidth = Math.max(...parsed.map((status) => status.status.length));
	const lines = parsed.map((status) => {
		const role = `${status.spinner ? `${status.spinner} ` : "  "}${status.label}`.padEnd(roleWidth);
		const statusText = status.status ? `${status.status.padEnd(statusWidth)} - ${status.action}` : status.action;
		return `- ${role}: ${statusText}`;
	});
	return ["Subagents:", ...lines].join("\n");
}

function createSubagentProgress(options: { onToolUpdate?: ToolProgressOnUpdate; setWidget?: WidgetSetter }) {
	const statuses = new Map<string, string>();
	let current: string | undefined;
	let lastRendered = "";

	const snapshot = (): SubagentProgressSnapshot => ({
		statuses: [...statuses.entries()].map(([key, text]) => ({ key, text })),
		...(current ? { current } : {}),
	});
	const publish = () => {
		const state = snapshot();
		const rendered = formatSubagentProgress(state);
		if (rendered === lastRendered) return;
		lastRendered = rendered;
		options.onToolUpdate?.({ content: [{ type: "text", text: rendered }], details: { subagentProgress: state } });
		options.setWidget?.(rendered.split("\n"));
	};

	return {
		text(text: string) {
			const normalized = text.trim();
			if (!normalized) return;
			current = normalized;
			publish();
		},
		status(status: ChildStatusUpdate) {
			const existing = statuses.get(status.key);
			if (status.text === undefined) {
				if (!existing) return;
				const finished = finishStatusText(existing, status.key);
				if (finished === existing) return;
				statuses.set(status.key, finished);
				current = finished;
				publish();
				return;
			}
			const text = status.text.trim();
			if (!text || text === existing) return;
			statuses.set(status.key, text);
			current = text;
			publish();
		},
		clear() {
			options.setWidget?.(undefined);
		},
	};
}

export default function orchestratorAgentsExtension(pi: ExtensionAPI) {
	const role = parseRoleEnv(process.env[ROLE_ENV]);
	const runDir = process.env[RUN_DIR_ENV];
	const persistedState = runDir ? readOrchestrationState(runDir) : undefined;
	let workerRuns = persistedState?.workerRuns ?? (Number(process.env[WORKER_RUNS_ENV] ?? "0") || 0);
	let reviewRuns = persistedState?.reviewRuns ?? (Number(process.env[REVIEW_RUNS_ENV] ?? "0") || 0);
	let reviewRunsSinceLatestWorker = persistedState?.reviewRunsSinceLatestWorker ?? 0;
	let latestWorkerRunReviewedClean = persistedState?.latestWorkerRunReviewedClean ?? false;
	const persistState = () => {
		if (!runDir) return undefined;
		return writeOrchestrationState(runDir, { workerRuns, reviewRuns, reviewRunsSinceLatestWorker, latestWorkerRunReviewedClean });
	};

	if (!role) {
		pi.registerTool({
			name: "orchestrate_plan",
			label: "Orchestrate Plan",
			description: "Start the simple orchestrator workflow for a plan or @plan-file. The orchestrator coordinates scout, worker, reviewer, loops fixes, and runs validation only after implementation/review.",
			promptSnippet: "Run the configured orchestrator workflow for a plan or @plan-file",
			promptGuidelines: ORCHESTRATE_PLAN_GUIDELINES,
			parameters: OrchestrateParams,
			async execute(_id, params: OrchestrateParamsType, signal, onUpdate, ctx) {
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const { result, runDir, planSource } = await runOrchestration(ctx.cwd, params.plan, signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				if (result.exitCode !== 0) throwChildRunError("Orchestration failed", result);
				return {
					content: [{ type: "text", text: `Orchestration finished.\nRun dir: ${runDir}\nPlan source: ${planSource}\nOutput: ${result.outputPath}\nTranscript: ${result.transcriptPath}\n\n${result.output}` }],
					details: { runDir, planSource, result },
				};
			},
		});

		pi.registerTool({
			name: "review_target",
			label: "Review Target",
			description: "Run a scout plus fresh reviewer fanout for an existing target, optional extra context, then synthesize improvements. YOLO mode does not enforce source-write restrictions.",
			promptSnippet: "Review an existing file, directory, diff, or extension with reviewer fanout",
			promptGuidelines: REVIEW_TARGET_GUIDELINES,
			parameters: ReviewTargetParams,
			async execute(_id, params: ReviewTargetParamsType, signal, onUpdate, ctx) {
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const result = await runReviewTarget(ctx.cwd, params, signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				return {
					content: [{ type: "text", text: `Review finished.\nRun dir: ${result.runDir}\nTarget source: ${result.targetSource}\nFinal summary: ${result.finalSummaryPath}\n\n${result.synthesis.output}` }],
					details: result,
				};
			},
		});

		pi.registerTool({
			name: "run_scout_agent",
			label: "Run Scout Agent",
			description: "Run a standalone scout subagent for broad reconnaissance and compact context handoff without starting a full orchestration or review workflow.",
			promptSnippet: "Run a standalone scout subagent for context gathering and handoff reports",
			promptGuidelines: RUN_SCOUT_AGENT_GUIDELINES,
			parameters: ScoutAgentParams,
			async execute(_id, params: ScoutAgentParamsType, signal, onUpdate, ctx) {
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const result = await runScoutAgent(ctx.cwd, params, signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				return {
					content: [{ type: "text", text: `Scout finished.\nRun dir: ${result.runDir}\nTask source: ${result.taskSource}\nOutput: ${result.outputArtifactPath}\nTranscript: ${result.result.transcriptPath}\n\n${result.result.output}` }],
					details: result,
				};
			},
		});

		pi.registerTool({
			name: "run_worker_agent",
			label: "Run Worker Agent",
			description: "Run a standalone worker subagent for implementation, fixes, or validation without starting a full orchestrator workflow. YOLO mode does not enforce source-write restrictions.",
			promptSnippet: "Run a standalone worker subagent for implementation, fixes, or validation",
			promptGuidelines: RUN_WORKER_AGENT_GUIDELINES,
			executionMode: "sequential",
			parameters: WorkerAgentParams,
			async execute(_id, params: WorkerAgentParamsType, signal, onUpdate, ctx) {
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const result = await runWorkerAgent(ctx.cwd, params, signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				return {
					content: [{ type: "text", text: `Worker finished.\nRun dir: ${result.runDir}\nTask source: ${result.taskSource}\nOutput: ${result.outputArtifactPath}\nTranscript: ${result.result.transcriptPath}\n\n${result.result.output}` }],
					details: result,
				};
			},
		});

		pi.registerTool({
			name: "run_parallel_workers",
			label: "Run Parallel Workers",
			description: "Run multiple standalone worker subagents concurrently for independent implementation, fix, or validation tasks. Each worker gets its own run directory and session file; YOLO mode does not prevent source edit conflicts.",
			promptSnippet: "Run multiple standalone worker subagents concurrently for independent tasks",
			promptGuidelines: RUN_PARALLEL_WORKERS_GUIDELINES,
			parameters: ParallelWorkersParams,
			async execute(_id, params: ParallelWorkersParamsType, signal, onUpdate, ctx) {
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const result = await runParallelWorkers(ctx.cwd, params, signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				const summary = result.workers.map((worker, index) => `${index + 1}. ${worker.name}: output ${worker.outputArtifactPath}; transcript ${worker.result.transcriptPath}`).join("\n");
				return {
					content: [{ type: "text", text: `Parallel workers finished.\nRun dir: ${result.runDir}\nWorkers: ${result.workers.length}\n\n${summary}` }],
					details: result,
				};
			},
		});
	}

	if (role === "orchestrator" && runDir) {
		pi.registerTool({
			name: "run_role_agent",
			label: "Run Role Agent",
			description: "Run scout, worker, or reviewer for one concrete handoff task in the current orchestration run. YOLO by design: no file, time, validation, or snapshot guardrails are imposed. Calls are serialized so persistent child sessions are not shared concurrently.",
			promptSnippet: "Delegate a concrete task to scout, worker, or reviewer within the current orchestration run",
			promptGuidelines: [
				"Use run_role_agent from orchestrator after deciding the next workflow step.",
				"Use purpose=validation for final tests or end-user checks when useful; Pi YOLO policy applies.",
				"run_role_agent calls are serialized; do not rely on parallel worker execution in a single assistant turn.",
			],
			executionMode: "sequential",
			parameters: RoleRunParams,
			async execute(_id, params: RoleRunParamsType, signal, onUpdate, ctx) {
				validateRolePurpose(params.role, params.purpose);
				const config = loadConfig(ctx.cwd);
				const label = `${params.role}${params.round ? `-round-${params.round}` : ""}`;
				const taskInput = requireNonEmpty(params.task, "role task");
				const outputFile = params.outputFile?.trim() || `${label}.md`;
				const outputArtifactPath = validateOutputArtifactPath(runDir, outputFile);
				const task = `${taskInput}

Run directory: ${runDir}
Expected output artifact: ${outputFile}
Purpose: ${params.purpose}`;
				writeArtifact(runDir, `delegations/${label}-${Date.now()}.md`, task);
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const result = await spawnPiRole({
					cwd: ctx.cwd,
					role: params.role,
					task,
					runDir,
					config,
					signal,
					envExtra: childEnvCounts(workerRuns, reviewRuns),
					onUpdate: (text) => progress.text(text),
					onStatus: (status) => progress.status(status),
					statusKey: `subagent:${params.role}${params.round ? `-${params.round}` : ""}`,
					statusLabel: `${params.role}${params.round ? `-${params.round}` : ""}`,
				});
				const succeeded = result.exitCode === 0;
				if (result.exitCode !== 0) {
					persistState();
					throw new Error(childResultText(`${params.role} failed`, result));
				}
				validateOutputArtifactPath(runDir, outputFile);
				if (!fs.existsSync(outputArtifactPath)) copyArtifactFile(runDir, result.outputPath, outputArtifactPath);

				if (succeeded && params.role === "worker" && (params.purpose === "implementation" || params.purpose === "fix" || params.purpose === "validation")) {
					workerRuns++;
					reviewRunsSinceLatestWorker = 0;
					latestWorkerRunReviewedClean = false;
				}
				if (succeeded && params.role === "reviewer" && params.purpose === "review") {
					reviewRuns++;
					reviewRunsSinceLatestWorker++;
				}
				persistState();
				return {
					content: [{ type: "text", text: childResultText(`${params.role} finished`, { ...result, outputPath: outputArtifactPath }) }],
					details: { ...result, outputPath: outputArtifactPath, purpose: params.purpose, round: params.round, latestWorkerRunReviewedClean, workerRuns, reviewRuns, reviewRunsSinceLatestWorker },
				};

			},
		});

		pi.registerTool({
			name: "mark_review_clean",
			label: "Mark Review Clean",
			description: "Record that the latest changes have a clean synthesized review. Informational only; it does not gate validation in YOLO mode.",
			promptSnippet: "Record the latest changes as cleanly reviewed after synthesizing reviewer output",
			promptGuidelines: ["Use mark_review_clean after reviewer artifacts show no blockers and no fixes worth doing now."],
			executionMode: "sequential",
			parameters: MarkReviewCleanParams,
			async execute(_id, params: MarkReviewCleanParamsType) {
				const summary = requireNonEmpty(params.summary, "clean review summary");
				latestWorkerRunReviewedClean = true;
				const pathName = writeArtifact(runDir, `review-clean-${params.round ?? reviewRuns}.md`, `# Clean Review Mark\n\nRound: ${params.round ?? reviewRuns}\n\n${summary}\n`);
				const statePath = persistState();
				return { content: [{ type: "text", text: `Marked latest worker changes as cleanly reviewed. Artifact: ${pathName}` }], details: { latestWorkerRunReviewedClean, path: pathName, statePath, workerRuns, reviewRuns, reviewRunsSinceLatestWorker } };
			},
		});
	}

	if (role && runDir) {
		pi.registerTool({
			name: "compact_session",
			label: "Compact Session",
			description: "Request compaction for the current child session to prevent context rot while preserving orchestration state.",
			promptSnippet: "Compact the current child session with orchestration-aware summary instructions",
			promptGuidelines: ["Use compact_session when any child role session with a run directory is getting long; artifacts remain the source of truth after compaction."],
			parameters: CompactSessionParams,
			async execute(_id, params: CompactSessionParamsType, _signal, _onUpdate, ctx) {
				const defaultInstructions = [
					"Preserve the original plan and current goal.",
					"Preserve changed files, implementation decisions, and rationale.",
					"Preserve open reviewer findings, accepted fixes, deferred items, and validation state.",
					"Preserve artifact paths under the run directory and any decisions needing user approval.",
				].join(" ");
				ctx.compact({
					customInstructions: params.instructions?.trim() || defaultInstructions,
					onComplete: () => {
						try {
							writeArtifact(runDir, `compaction-${Date.now()}.md`, `Compaction completed for role ${role ?? "unknown"}.\n`);
						} catch { /* ignore artifact failures from callback */ }
					},
					onError: (error) => {
						try {
							const message = error instanceof Error ? error.message : String(error);
							writeArtifact(runDir, `compaction-error-${Date.now()}.md`, `Compaction failed for role ${role ?? "unknown"}: ${message}\n`);
						} catch { /* ignore artifact failures from callback */ }
					},
				});
				return { content: [{ type: "text", text: "Compaction requested for the current session. Continue using run artifacts as source of truth." }], details: { requested: true, runDir } };
			},
		});

		pi.registerTool({
			name: "write_run_artifact",
			label: "Write Run Artifact",
			description: "Write a handoff artifact relative to the current orchestration run directory.",
			promptSnippet: "Write a handoff artifact inside the current orchestration run directory",
			promptGuidelines: ["Use write_run_artifact for scout, worker, reviewer, and orchestrator handoff files instead of writing project files."],
			parameters: ArtifactParams,
			async execute(_id, params: ArtifactParamsType) {
				const artifactPath = requireNonEmpty(params.path, "artifact path");
				const target = validateOutputArtifactPath(runDir, artifactPath);
				writeArtifact(runDir, target, params.content);
				return { content: [{ type: "text", text: `Wrote artifact: ${target}` }], details: { path: target } };
			},
		});
	}

	if (!role) {
		const runOrchestrateCommand = async (args: string, ctx: ExtensionCommandContext) => {
			const plan = args.trim();
			if (!plan) {
				ctx.ui.notify("Usage: /orchestrate @path/to/plan.md or /orchestrate <plan>", "warning");
				return;
			}
			ctx.ui.notify("Starting orchestrator workflow...", "info");
			const progress = createSubagentProgress({ setWidget: (content) => ctx.ui.setWidget("pi-simple-subagents:orchestrate", content, { placement: "belowEditor" }) });
			try {
				const { result, runDir } = await runOrchestration(ctx.cwd, plan, ctx.signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				if (result.exitCode !== 0) throwChildRunError("Orchestration failed", result);
				pi.sendMessage({
					customType: "pi-simple-subagents-result",
					display: true,
					content: `Orchestration finished.\n\nRun dir: ${runDir}\nOutput: ${result.outputPath}\nTranscript: ${result.transcriptPath}\n\n${result.output}`,
					details: { runDir, result },
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Orchestration failed: ${message.split("\n")[0]}`, "error");
				throw error;
			} finally {
				progress.clear();
			}
		};

		const runScoutCommand = async (args: string, ctx: ExtensionCommandContext) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /scout @target-file, @directory, or inline reconnaissance instructions", "warning");
				return;
			}
			ctx.ui.notify("Starting scout...", "info");
			const progress = createSubagentProgress({ setWidget: (content) => ctx.ui.setWidget("pi-simple-subagents:scout", content, { placement: "belowEditor" }) });
			try {
				const result = await runScoutAgent(ctx.cwd, { task }, ctx.signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				pi.sendMessage({
					customType: "pi-simple-subagents-scout-result",
					display: true,
					content: `Scout finished.\n\nRun dir: ${result.runDir}\nOutput: ${result.outputArtifactPath}\nTranscript: ${result.result.transcriptPath}\n\n${result.result.output}`,
					details: result,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Scout failed: ${message.split("\n")[0]}`, "error");
				throw error;
			} finally {
				progress.clear();
			}
		};

		const runWorkCommand = async (args: string, ctx: ExtensionCommandContext) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /work @task-file, @directory, or inline implementation/fix/validation instructions", "warning");
				return;
			}
			ctx.ui.notify("Starting worker...", "info");
			const progress = createSubagentProgress({ setWidget: (content) => ctx.ui.setWidget("pi-simple-subagents:work", content, { placement: "belowEditor" }) });
			try {
				const result = await runWorkerAgent(ctx.cwd, { task }, ctx.signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				pi.sendMessage({
					customType: "pi-simple-subagents-worker-result",
					display: true,
					content: `Worker finished.\n\nRun dir: ${result.runDir}\nOutput: ${result.outputArtifactPath}\nTranscript: ${result.result.transcriptPath}\n\n${result.result.output}`,
					details: result,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Worker failed: ${message.split("\n")[0]}`, "error");
				throw error;
			} finally {
				progress.clear();
			}
		};

		const runReviewCommand = async (args: string, ctx: ExtensionCommandContext) => {
			const target = args.trim();
			if (!target) {
				ctx.ui.notify("Usage: /review [--scout|--no-scout] [--context <text-or-@file>] [--reviewer <angle>]... @path-or-dir [focus/instructions]", "warning");
				return;
			}
			ctx.ui.notify("Starting review workflow...", "info");
			const progress = createSubagentProgress({ setWidget: (content) => ctx.ui.setWidget("pi-simple-subagents:review", content, { placement: "belowEditor" }) });
			try {
				const result = await runReviewTarget(ctx.cwd, parseReviewTargetCommand(target), ctx.signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				pi.sendMessage({
					customType: "pi-simple-subagents-review-result",
					display: true,
					content: `Review finished.\n\nRun dir: ${result.runDir}\nFinal summary: ${result.finalSummaryPath}\n\n${result.synthesis.output}`,
					details: result,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Review failed: ${message.split("\n")[0]}`, "error");
				throw error;
			} finally {
				progress.clear();
			}
		};

		pi.registerCommand("orchestrate", {
			description: "Run the simple orchestrator workflow for a plan or @plan-file",
			handler: runOrchestrateCommand,
		});

		pi.registerCommand("scout", {
			description: "Run a standalone scout subagent. Usage: @target-file, @directory, or inline reconnaissance instructions",
			handler: runScoutCommand,
		});

		pi.registerCommand("work", {
			description: "Run a standalone worker subagent. Usage: @task-file, @directory, or inline implementation/fix/validation instructions",
			handler: runWorkCommand,
		});

		pi.registerCommand("work-parallel", {
			description: "Run multiple worker subagents concurrently. Usage: JSON array of strings or {name, task, purpose, outputFile} objects",
			handler: async (args, ctx) => {
				const input = args.trim();
				if (!input) {
					ctx.ui.notify("Usage: /work-parallel [{\"name\":\"docs\",\"task\":\"...\"},{\"name\":\"tests\",\"task\":\"...\"}]", "warning");
					return;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(input);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`/work-parallel expects JSON: ${message}`, "error");
					return;
				}
				let rawTasks: unknown[] | undefined;
				try {
					if (Array.isArray(parsed)) {
						rawTasks = parsed;
					} else if (typeof parsed === "object" && parsed !== null) {
						const rawObject = parsed as Record<string, unknown>;
						assertKnownKeys(rawObject, WORK_PARALLEL_ROOT_KEYS, "/work-parallel root object");
						if (Array.isArray(rawObject.tasks)) rawTasks = rawObject.tasks;
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(message, "error");
					return;
				}
				if (!rawTasks || rawTasks.length < 2 || rawTasks.length > 8) {
					ctx.ui.notify("/work-parallel requires 2-8 tasks", "warning");
					return;
				}
				let tasks: ParallelWorkersParamsType["tasks"];
				try {
					tasks = rawTasks.map((item, index) => {
						if (typeof item === "string") {
							if (item.trim() === "") throw new Error(`Invalid task at index ${index}: task must be a non-empty string`);
							return { name: `worker-${index + 1}`, task: item };
						}
						if (typeof item !== "object" || item === null) throw new Error(`Invalid task at index ${index}: expected string or object`);
						const raw = item as { name?: unknown; task?: unknown; purpose?: unknown; outputFile?: unknown };
						assertKnownKeys(raw as Record<string, unknown>, WORK_PARALLEL_TASK_KEYS, `Invalid task at index ${index}`);
						if (typeof raw.task !== "string" || raw.task.trim() === "") throw new Error(`Invalid task at index ${index}: task must be a non-empty string`);
						if (raw.name !== undefined && typeof raw.name !== "string") throw new Error(`Invalid task at index ${index}: name must be a string`);
						if (raw.outputFile !== undefined && typeof raw.outputFile !== "string") throw new Error(`Invalid task at index ${index}: outputFile must be a string`);
						if (raw.purpose !== undefined && (typeof raw.purpose !== "string" || !(WORKER_PURPOSES as readonly string[]).includes(raw.purpose))) throw new Error(`Invalid task at index ${index}: purpose must be implementation, fix, or validation`);
						return {
							...(raw.name !== undefined ? { name: raw.name } : {}),
							task: raw.task,
							...(raw.purpose !== undefined ? { purpose: raw.purpose as ParallelWorkersParamsType["tasks"][number]["purpose"] } : {}),
							...(raw.outputFile !== undefined ? { outputFile: raw.outputFile } : {}),
						};
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(message, "error");
					return;
				}
				ctx.ui.notify(`Starting ${tasks.length} workers in parallel...`, "info");
				const progress = createSubagentProgress({ setWidget: (content) => ctx.ui.setWidget("pi-simple-subagents:work-parallel", content, { placement: "belowEditor" }) });
				try {
					const result = await runParallelWorkers(ctx.cwd, { tasks }, ctx.signal, (text, status) => {
						if (text) progress.text(text);
						if (status) progress.status(status);
					});
					pi.sendMessage({
						customType: "pi-simple-subagents-parallel-workers-result",
						display: true,
						content: `Parallel workers finished.\n\nRun dir: ${result.runDir}\nWorkers: ${result.workers.length}\n\n${result.workers.map((worker, index) => `${index + 1}. ${worker.name}: ${worker.outputArtifactPath}`).join("\n")}`,
						details: result,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Parallel workers failed: ${message.split("\n")[0]}`, "error");
					throw error;
				} finally {
					progress.clear();
				}
			},
		});

		pi.registerCommand("review", {
			description: "Run scout/reviewer fanout for a target and synthesize improvements. Usage: [--scout|--no-scout] [--context <text-or-@file>] [--reviewer <angle>]... @path-or-dir [focus/instructions]",
			handler: runReviewCommand,
		});

	}
}
