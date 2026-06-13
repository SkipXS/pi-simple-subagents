import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { throwChildRunError } from "./child-runner.ts";
import { createSubagentProgress, formatSubagentProgress, withSubagentProgress } from "./progress.ts";
import {
	OrchestratorParams,
	ReviewersParams,
	ScoutParams,
	WorkerParams,
	WorkersParallelParams,
	type OrchestratorParams as OrchestratorParamsType,
	type ReviewersParams as ReviewersParamsType,
	type ScoutParams as ScoutParamsType,
	type WorkerParams as WorkerParamsType,
	type WorkersParallelParams as WorkersParallelParamsType,
} from "./schemas.ts";
import {
	renderOrchestratorCall,
	renderOrchestratorResult,
	renderParallelWorkersCall,
	renderParallelWorkersResult,
	renderReviewersCall,
	renderReviewersResult,
	renderScoutCall,
	renderScoutResult,
	renderWorkerCall,
	renderWorkerResult,
} from "./rendering.ts";
import { childSummary } from "./summaries.ts";
import { runOrchestrator, runReviewers, runScout, runWorker, runWorkersParallel } from "./workflows.ts";

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

function safeIdLabel(value: string, fallback: string): string {
	return (value || fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || fallback;
}

export function registerRootTools(pi: ExtensionAPI): void {
	let standaloneWorkerStatusSequence = 0;

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
