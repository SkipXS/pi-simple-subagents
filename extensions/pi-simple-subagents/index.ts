import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateOutputArtifactPath, writeArtifact } from "./artifacts.ts";
import { childEnvCounts, childResultText, throwChildRunError, spawnPiRole } from "./child-runner.ts";
import { loadConfig } from "./config.ts";
import {
	ROLE_ENV,
	REVIEW_RUNS_ENV,
	RUN_DIR_ENV,
	WORKER_RUNS_ENV,
	parseRoleEnv,
	validateRolePurpose,
	type RoleName,
} from "./roles.ts";
import {
	ArtifactParams,
	CompactSessionParams,
	MarkReviewCleanParams,
	OrchestratorParams,
	WorkersParallelParams,
	ReviewersParams,
	RoleRunParams,
	ScoutParams,
	WorkerParams,
	type ArtifactParams as ArtifactParamsType,
	type CompactSessionParams as CompactSessionParamsType,
	type MarkReviewCleanParams as MarkReviewCleanParamsType,
	type OrchestratorParams as OrchestratorParamsType,
	type WorkersParallelParams as WorkersParallelParamsType,
	type ReviewersParams as ReviewersParamsType,
	type RoleRunParams as RoleRunParamsType,
	type ScoutParams as ScoutParamsType,
	type WorkerParams as WorkerParamsType,
} from "./schemas.ts";
import { DELEGABLE_ROLE_NAMES } from "./role-registry.ts";
import { readOrchestrationState, writeOrchestrationState } from "./state.ts";
import {
	createSubagentProgress,
	formatSubagentProgress,
	trimStatusField,
	withSubagentProgress,
} from "./progress.ts";
import {
	renderArtifactCall,
	renderArtifactResult,
	renderCompactCall,
	renderCompactResult,
	renderMarkReviewCleanCall,
	renderMarkReviewCleanResult,
	renderOrchestratorCall,
	renderOrchestratorResult,
	renderParallelWorkersCall,
	renderParallelWorkersResult,
	renderReviewersCall,
	renderReviewersResult,
	renderRoleAgentCall,
	renderRoleAgentResult,
	renderScoutCall,
	renderScoutResult,
	renderWorkerCall,
	renderWorkerResult,
} from "./rendering.ts";
import { childSummary } from "./summaries.ts";
import { registerRootCommands } from "./commands.ts";
import { assertWorkerTaskWithinBudget, runOrchestrator, runReviewers, runScout, runWorker, runWorkersParallel } from "./workflows.ts";

const RUN_ORCHESTRATOR_GUIDELINES = [
	"Use run_orchestrator for plan-driven implementation or review/fix workflows that need scout/worker/verifier/reviewer coordination.",
	"The orchestrator coordinates verification plus review/fix loops; verifiers check worker packages against the plan before review, reviewers perform the review, and the orchestrator routes concrete gaps/fixes to worker.",
	"Do not use run_orchestrator for review-only work with no intended fixes; use run_reviewers instead.",
];

const RUN_REVIEWERS_GUIDELINES = [
	"Use run_reviewers for review-only work when the user asks to inspect, audit, or suggest improvements without implementing changes.",
	"Choose the reviewers array yourself based on the target and user focus: use 1 targeted reviewer for narrow/simple reviews, 2-3 for distinct risk areas, and more only when independent aspects justify the added cost. Do not rely on a fixed default fanout.",
	"Name reviewer angles concretely, e.g. 'runtime correctness for parser changes' or 'packaging/installability for npm extension'. Avoid broad duplicate reviewers.",
	"Pass a prior scout-report.md or other concise background as run_reviewers.extraContext when available, but reviewers must verify it against current files.",
	"Keep run_reviewers.includeScout enabled unless the user explicitly asks to skip the review-specific scout.",
];

const RUN_SCOUT_GUIDELINES = [
	"Prefer run_scout before implementation when the task is not obviously trivial: non-trivial scope, cross-file impact, behavior/API/security/packaging changes, unfamiliar code, ambiguity, or likely side effects.",
	"Use run_scout to keep large reading out of the parent context; ask it for a compact handoff with relevant files, current behavior, risks, and recommended next steps.",
	"Skip scouting for clearly isolated, low-risk single-location edits or when the user explicitly asks to proceed directly.",
	"Do not use run_scout for implementation changes; use run_worker or run_orchestrator for source edits.",
];

const RUN_WORKER_GUIDELINES = [
	"Use run_worker for direct implementation, fix, or validation tasks that do not need a full orchestrator/reviewer loop.",
	"Do not use run_worker for review-only work; use run_reviewers instead.",
];

const RUN_WORKERS_PARALLEL_GUIDELINES = [
	"Use run_workers_parallel only for clearly independent tasks unlikely to edit the same files.",
	"Do not use run_workers_parallel for overlapping refactors, shared-file edits, or tasks that need one worker's result before another starts.",
];

function requireNonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must be a non-empty string`);
	return trimmed;
}

function safeIdLabel(value: string, fallback: string): string {
	return (value || fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || fallback;
}

function parseStartupRole(pi: ExtensionAPI): RoleName | undefined {
	try {
		return parseRoleEnv(process.env[ROLE_ENV]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const warning = `${message}; loading pi-simple-subagents in root mode instead.`;
		console.warn(warning);
		try {
			pi.sendMessage({ customType: "pi-simple-subagents-config-error", display: true, content: `pi-simple-subagents warning: ${warning}`, details: { env: ROLE_ENV, value: process.env[ROLE_ENV] } });
		} catch { /* best-effort startup warning */ }
		return undefined;
	}
}

function roleTaskStatusDescription(purpose: string, task: string): string {
	const firstLine = task.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "delegated task";
	return trimStatusField(`${purpose}: ${firstLine}`, 72);
}

function workerDisplaySegment(workerId: string | undefined): string | undefined {
	if (!workerId) return undefined;
	return /^worker-(.+)$/.exec(workerId)?.[1] ?? workerId;
}

function workerScopedEphemeralLabels(role: "verifier" | "reviewer", latestWorkerId: string | undefined, round: number | undefined, fallbackRound: number): { artifactLabel?: string; statusLabel?: string } {
	const workerSegment = workerDisplaySegment(latestWorkerId);
	if (!workerSegment) return {};
	const workerId = latestWorkerId ?? `worker-${workerSegment}`;
	const effectiveRound = round ?? fallbackRound;
	return {
		artifactLabel: `${role}-${workerSegment}-round-${effectiveRound}`,
		statusLabel: `${role === "verifier" ? "verify" : "review"} ${workerId} r${effectiveRound}`,
	};
}

function workerPurposeLabel(purpose: string): string {
	return purpose === "implementation" ? "impl" : purpose;
}

function workerStatusLabel(workerId: string, purpose: string, round: number | undefined): string {
	return `${workerId} ${workerPurposeLabel(purpose)}${round ? ` r${round}` : ""}`;
}

function roleStatusKey(statusLabel: string, sequence: number): string {
	return `subagent:${safeIdLabel(statusLabel, "role")}-${sequence}`;
}

function roleRunLabels(role: string, purpose: string, round: number | undefined, workerId: string | undefined, latestWorkerId: string | undefined, fallbackReviewRound: number): { artifactLabel: string; statusLabel: string } {
	if (workerId) {
		const label = `${workerId}${round ? `-round-${round}` : ""}`;
		return { artifactLabel: label, statusLabel: workerStatusLabel(workerId, purpose, round) };
	}
	if (role === "verifier" || role === "reviewer") {
		const scoped = workerScopedEphemeralLabels(role, latestWorkerId, round, fallbackReviewRound);
		if (scoped.artifactLabel && scoped.statusLabel) return { artifactLabel: scoped.artifactLabel, statusLabel: scoped.statusLabel };
	}
	return {
		artifactLabel: `${role}${round ? `-round-${round}` : ""}`,
		statusLabel: `${role}${round ? ` r${round}` : ""}`,
	};
}

function requireExpectedRunArtifact(runDir: string, outputFile: string, result: { outputPath: string; transcriptPath: string }, label: string): string {
	const target = validateOutputArtifactPath(runDir, outputFile);
	if (!fs.existsSync(target)) {
		throw new Error(`${label} did not write the expected output artifact.\nExpected output artifact: ${outputFile}\nExpected path: ${target}\nRun dir: ${runDir}\nChild output log: ${result.outputPath}\nTranscript: ${result.transcriptPath}\nUse write_run_artifact with path ${JSON.stringify(outputFile)}; do not write artifacts via absolute paths or the generic write tool.`);
	}
	return validateOutputArtifactPath(runDir, outputFile);
}

function defaultRoleOutputFile(runDir: string, label: string, nextSequence: () => number): string {
	const firstCandidate = `${label}.md`;
	if (!fs.existsSync(validateOutputArtifactPath(runDir, firstCandidate))) return firstCandidate;
	for (;;) {
		const candidate = `${label}-${nextSequence()}.md`;
		if (!fs.existsSync(validateOutputArtifactPath(runDir, candidate))) return candidate;
	}
}

export default function orchestratorAgentsExtension(pi: ExtensionAPI) {
	const role = parseStartupRole(pi);
	const runDir = process.env[RUN_DIR_ENV];
	const persistedState = runDir ? readOrchestrationState(runDir) : undefined;
	let workerRuns = persistedState?.workerRuns ?? (Number(process.env[WORKER_RUNS_ENV] ?? "0") || 0);
	let reviewRuns = persistedState?.reviewRuns ?? (Number(process.env[REVIEW_RUNS_ENV] ?? "0") || 0);
	let reviewRunsSinceLatestWorker = persistedState?.reviewRunsSinceLatestWorker ?? 0;
	let latestWorkerRunReviewedClean = persistedState?.latestWorkerRunReviewedClean ?? false;
	let latestWorkerId = persistedState?.latestWorkerId;
	let nextWorkerSequence = Math.max(1, persistedState?.nextWorkerSequence ?? workerRuns + 1);
	let roleOutputSequence = 0;
	let roleStatusSequence = workerRuns + reviewRuns;
	let standaloneWorkerStatusSequence = 0;
	const persistState = () => {
		if (!runDir) return undefined;
		return writeOrchestrationState(runDir, { workerRuns, reviewRuns, reviewRunsSinceLatestWorker, latestWorkerRunReviewedClean, latestWorkerId, nextWorkerSequence });
	};
	const allocateWorkerId = (explicitWorkerId: string | undefined, purpose: string): { workerId: string; allocatedNew: boolean } => {
		if (explicitWorkerId?.trim()) return { workerId: safeIdLabel(explicitWorkerId, "worker"), allocatedNew: false };
		if ((purpose === "fix" || purpose === "validation") && latestWorkerId) return { workerId: latestWorkerId, allocatedNew: false };
		return { workerId: `worker-${nextWorkerSequence}`, allocatedNew: true };
	};

	if (!role) {
		pi.registerTool({
			name: "run_orchestrator",
			label: "Run Orchestrator",
			description: "Start the simple orchestrator workflow for a plan or review/fix instruction. The orchestrator coordinates scout, worker, verifier, reviewers, accepted fixes, and validation; verifiers check worker packages before reviewers perform the review.",
			promptSnippet: "Run the configured orchestrator workflow for a plan or review/fix instruction",
			promptGuidelines: RUN_ORCHESTRATOR_GUIDELINES,
			parameters: OrchestratorParams,
			renderCall: renderOrchestratorCall,
			renderResult: renderOrchestratorResult,
			async execute(_id, params: OrchestratorParamsType, signal, onUpdate, ctx) {
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const { result, runDir, planSource, cleanupSummary } = await runOrchestrator(ctx.cwd, params.plan, signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				if (result.exitCode !== 0) throwChildRunError("Orchestration failed", result);
				const subagentProgress = progress.snapshot();
				return {
					content: [{ type: "text", text: childSummary("Orchestration finished.", [["Run dir", runDir], ["Plan source", planSource], ["Output", result.outputPath], ["Transcript", result.transcriptPath], ["Artifact cleanup", cleanupSummary]], result.output, { includeOutput: params.includeOutput, subagentProgress }) }],
					details: withSubagentProgress({ runDir, planSource, result, cleanupSummary }, progress),
				};
			},
		});

		pi.registerTool({
			name: "run_reviewers",
			label: "Run Reviewers",
			description: "Run a scout plus fresh reviewer fanout for an existing target, optional extra context, then synthesize improvements. The caller/model should choose the reviewer angles and count for the target; if omitted, one adaptive general reviewer is used. YOLO mode does not enforce source-write restrictions.",
			promptSnippet: "Review an existing file, directory, diff, or extension with model-selected reviewer angles",
			promptGuidelines: RUN_REVIEWERS_GUIDELINES,
			parameters: ReviewersParams,
			renderCall: renderReviewersCall,
			renderResult: renderReviewersResult,
			async execute(_id, params: ReviewersParamsType, signal, onUpdate, ctx) {
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const result = await runReviewers(ctx.cwd, params, signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				const subagentProgress = progress.snapshot();
				return {
					content: [{ type: "text", text: childSummary("Review finished.", [["Run dir", result.runDir], ["Target source", result.targetSource], ["Final summary", result.finalSummaryPath], ["Synthesis transcript", result.synthesis.transcriptPath], ["Artifact cleanup", result.cleanupSummary]], result.synthesis.output, { kind: "synthesis", includeOutput: params.includeOutput, subagentProgress }) }],
					details: withSubagentProgress(result as unknown as Record<string, unknown>, progress),
				};
			},
		});

		pi.registerTool({
			name: "run_scout",
			label: "Run Scout",
			description: "Run a standalone scout subagent for context gathering before implementation/review and compact handoff without starting a full orchestration or review workflow.",
			promptSnippet: "Run a standalone scout subagent for non-trivial or uncertain tasks before implementation",
			promptGuidelines: RUN_SCOUT_GUIDELINES,
			parameters: ScoutParams,
			renderCall: renderScoutCall,
			renderResult: renderScoutResult,
			async execute(_id, params: ScoutParamsType, signal, onUpdate, ctx) {
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const result = await runScout(ctx.cwd, params, signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				const subagentProgress = progress.snapshot();
				return {
					content: [{ type: "text", text: childSummary("Scout finished.", [["Run dir", result.runDir], ["Task source", result.taskSource], ["Output", result.outputArtifactPath], ["Transcript", result.result.transcriptPath], ["Artifact cleanup", result.cleanupSummary]], result.result.output, { includeOutput: params.includeOutput, subagentProgress }) }],
					details: withSubagentProgress(result as unknown as Record<string, unknown>, progress),
				};
			},
		});

		pi.registerTool({
			name: "run_worker",
			label: "Run Worker",
			description: "Run a standalone worker subagent for implementation, fixes, or validation without starting a full orchestrator workflow. YOLO mode does not enforce source-write restrictions.",
			promptSnippet: "Run a standalone worker subagent for implementation, fixes, or validation",
			promptGuidelines: RUN_WORKER_GUIDELINES,
			executionMode: "parallel",
			parameters: WorkerParams,
			renderCall: renderWorkerCall,
			renderResult: renderWorkerResult,
			async execute(toolCallId, params: WorkerParamsType, signal, onUpdate, ctx) {
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const statusLabel = `worker ${++standaloneWorkerStatusSequence}`;
				const statusKey = `subagent:${safeIdLabel(`${statusLabel}-${toolCallId}`, "worker")}`;
				const result = await runWorker(ctx.cwd, params, signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				}, undefined, { statusKey, statusLabel });
				const subagentProgress = progress.snapshot();
				return {
					content: [{ type: "text", text: childSummary("Worker finished.", [["Run dir", result.runDir], ["Task source", result.taskSource], ["Output", result.outputArtifactPath], ["Transcript", result.result.transcriptPath], ["Artifact cleanup", result.cleanupSummary]], result.result.output, { includeOutput: params.includeOutput, subagentProgress }) }],
					details: withSubagentProgress({ ...(result as unknown as Record<string, unknown>), statusLabel, statusKey }, progress),
				};
			},
		});

		pi.registerTool({
			name: "run_workers_parallel",
			label: "Run Workers Parallel",
			description: "Run multiple standalone worker subagents concurrently for independent implementation, fix, or validation tasks. Each worker gets its own run directory and session file; YOLO mode does not prevent source edit conflicts.",
			promptSnippet: "Run multiple standalone worker subagents concurrently for independent tasks",
			promptGuidelines: RUN_WORKERS_PARALLEL_GUIDELINES,
			parameters: WorkersParallelParams,
			renderCall: renderParallelWorkersCall,
			renderResult: renderParallelWorkersResult,
			async execute(_id, params: WorkersParallelParamsType, signal, onUpdate, ctx) {
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const result = await runWorkersParallel(ctx.cwd, params, signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				const summary = result.workers.map((worker, index) => `${index + 1}. ${worker.name}: output ${worker.outputArtifactPath}; transcript ${worker.result.transcriptPath}`).join("\n");
				const subagentProgress = progress.snapshot();
				return {
					content: [{ type: "text", text: `Parallel workers finished.\nRun dir: ${result.runDir}\nWorkers: ${result.workers.length}${result.cleanupSummary ? `\nArtifact cleanup: ${result.cleanupSummary}` : ""}${subagentProgress.statuses.length > 0 ? `\n\n${formatSubagentProgress(subagentProgress)}` : ""}\n\n${summary}` }],
					details: withSubagentProgress(result as unknown as Record<string, unknown>, progress),
				};
			},
		});
	}

	if (role === "orchestrator" && runDir) {
		const delegableRoleText = DELEGABLE_ROLE_NAMES.join(", ");
		pi.registerTool({
			name: "run_role_agent",
			label: "Run Role Agent",
			description: `Run ${delegableRoleText} for one concrete handoff task in the current orchestration run. YOLO by design: no file, time, validation, or snapshot guardrails are imposed. Worker sessions are per work package; reuse the same workerId for verifier gap fixes or review fixes to that package.`,
			promptSnippet: `Delegate a concrete task to ${delegableRoleText} within the current orchestration run`,
			renderCall: renderRoleAgentCall,
			renderResult: renderRoleAgentResult,
			promptGuidelines: [
				"Use run_role_agent from orchestrator after deciding the next workflow step.",
				"Before the first worker call, split broad milestones into small work packages; never delegate a whole milestone or full plan section to one worker.",
				"A worker task should normally have one deliverable, 1-3 likely files, 3-5 acceptance criteria, explicit non-goals, and one validation check.",
				"For each new worker implementation package, omit workerId so the tool assigns worker-1, worker-2, etc.; after the worker returns, run role=verifier purpose=validation before reviewer review.",
				"If the verifier reports concrete implementation gaps, run role=worker purpose=fix with the same workerId, then run the verifier again before review.",
				"For accepted fixes after reviewing that package, pass the same workerId; run verifier again before the next reviewer round when the fix changes implementation state.",
				"Use worker purpose=validation for final tests or end-user checks when useful; Pi YOLO policy applies. If workerId is omitted for fix/validation, the latest worker is reused.",
				"run_role_agent calls are serialized; do not rely on parallel worker execution in a single assistant turn.",
				"Default output artifacts avoid overwriting existing role artifacts, but use explicit readable outputFile names for iterative loops such as verification-round-1.md, review-round-1.md, accepted-fixes-round-1.md, and validation.md.",
			],
			executionMode: "sequential",
			parameters: RoleRunParams,
			async execute(_id, params: RoleRunParamsType, signal, onUpdate, ctx) {
				validateRolePurpose(params.role, params.purpose);
				if (params.workerId !== undefined && params.role !== "worker") throw new Error("workerId is only valid when role=worker");
				const config = loadConfig(ctx.cwd);
				const workerAllocation = params.role === "worker" ? allocateWorkerId(params.workerId, params.purpose) : undefined;
				const labels = roleRunLabels(params.role, params.purpose, params.round, workerAllocation?.workerId, latestWorkerId, reviewRunsSinceLatestWorker + 1);
				const statusLabel = labels.statusLabel;
				const statusKey = roleStatusKey(statusLabel, ++roleStatusSequence);
				const label = labels.artifactLabel;
				const taskInput = requireNonEmpty(params.task, "role task");
				if (params.role === "worker") assertWorkerTaskWithinBudget(taskInput, "run_role_agent.task", config, "worker delegation task");
				const outputFile = params.outputFile?.trim() || defaultRoleOutputFile(runDir, label, () => ++roleOutputSequence);
				const outputArtifactPath = validateOutputArtifactPath(runDir, outputFile);
				const reviewBatchingWarning = params.role === "worker" && params.purpose === "implementation" && workerAllocation?.allocatedNew && latestWorkerId && !latestWorkerRunReviewedClean
					? `Starting ${workerAllocation.workerId} while ${latestWorkerId} is not marked cleanly reviewed. This is allowed, but record the rationale for batching/skipping review in orchestration.md and review the pending package(s) before final validation.`
					: undefined;
				const workerLine = workerAllocation ? `\nWorker ID: ${workerAllocation.workerId}` : "";
				const reviewWarningLine = reviewBatchingWarning ? `\nReview batching warning: ${reviewBatchingWarning}` : "";
				const task = `${taskInput}

Run directory: ${runDir}
Expected output artifact: ${outputFile}
Purpose: ${params.purpose}${workerLine}${reviewWarningLine}

Write the expected output artifact with write_run_artifact using path ${JSON.stringify(outputFile)}. Do not use absolute paths or the generic write tool for the handoff artifact.`;
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
					statusKey,
					statusLabel,
					statusDescription: roleTaskStatusDescription(params.purpose, taskInput),
					...(workerAllocation ? { sessionLabel: workerAllocation.workerId } : {}),
				});
				const succeeded = result.exitCode === 0;
				if (result.exitCode !== 0) {
					persistState();
					throw new Error(childResultText(`${params.role} failed`, result));
				}
				requireExpectedRunArtifact(runDir, outputFile, result, params.role);

				if (succeeded && params.role === "worker" && workerAllocation && (params.purpose === "implementation" || params.purpose === "fix" || params.purpose === "validation")) {
					workerRuns++;
					if (workerAllocation.allocatedNew) nextWorkerSequence++;
					latestWorkerId = workerAllocation.workerId;
					reviewRunsSinceLatestWorker = 0;
					latestWorkerRunReviewedClean = false;
				}
				if (succeeded && params.role === "reviewer" && params.purpose === "review") {
					reviewRuns++;
					reviewRunsSinceLatestWorker++;
				}
				persistState();
				const subagentProgress = progress.snapshot();
				return {
					content: [{ type: "text", text: childSummary(`${params.role} finished with exit code ${result.exitCode}.`, [["Worker", workerAllocation?.workerId], ["Review batching warning", reviewBatchingWarning], ["Session", result.sessionFile], ["Output", outputArtifactPath], ["Transcript", result.transcriptPath], ["Stderr", result.stderrPath]], result.output, { subagentProgress }) }],
					details: withSubagentProgress({ ...result, outputPath: outputArtifactPath, purpose: params.purpose, workerId: workerAllocation?.workerId, reviewBatchingWarning, round: params.round, statusLabel, statusKey, latestWorkerRunReviewedClean, latestWorkerId, nextWorkerSequence, workerRuns, reviewRuns, reviewRunsSinceLatestWorker }, progress),
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
			renderCall: renderMarkReviewCleanCall,
			renderResult: renderMarkReviewCleanResult,
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
			description: "Request compaction for the current child session to prevent context rot while preserving role-specific task, findings, validation state, and artifact paths.",
			promptSnippet: "Compact the current child session with role-aware summary instructions",
			promptGuidelines: ["Use compact_session when any child role session with a run directory is getting long, especially scouts doing broad repo/docs reconnaissance; artifacts remain the source of truth after compaction."],
			parameters: CompactSessionParams,
			renderCall: renderCompactCall,
			renderResult: renderCompactResult,
			async execute(_id, params: CompactSessionParamsType, _signal, _onUpdate, ctx) {
				const defaultInstructions = [
					"Preserve the original plan/task/target and current goal.",
					"For scout sessions, preserve inspected files/docs, key findings, risks, open questions, and expected scout report artifact.",
					"Preserve changed files, implementation decisions, and rationale when any source work happened.",
					"Preserve verifier findings/gaps, open reviewer findings, accepted fixes, deferred items, and validation state.",
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
			promptGuidelines: ["Use write_run_artifact for scout, worker, verifier, reviewer, and orchestrator handoff files instead of the generic write tool. For expected outputs, pass the exact relative filename from 'Expected output artifact' as path; never invent absolute artifact paths."],
			parameters: ArtifactParams,
			renderCall: renderArtifactCall,
			renderResult: renderArtifactResult,
			async execute(_id, params: ArtifactParamsType) {
				const artifactPath = requireNonEmpty(params.path, "artifact path");
				const target = validateOutputArtifactPath(runDir, artifactPath);
				writeArtifact(runDir, target, params.content);
				return { content: [{ type: "text", text: `Wrote artifact: ${target}` }], details: { path: target } };
			},
		});
	}

	if (!role) registerRootCommands(pi);
}
