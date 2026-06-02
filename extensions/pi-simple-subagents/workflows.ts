import * as fs from "node:fs";
import * as path from "node:path";
import { copyArtifactFile, ensureDir, resolveArtifactPath, resolveRunBaseDir, runId, validateOutputArtifactPath, writeArtifact } from "./artifacts.ts";
import { childResultText, spawnPiRole, throwChildRunError, type ChildRunResult, type ChildStatusUpdate } from "./child-runner.ts";
import { loadConfig } from "./config.ts";
import { reviewTargetSystemPrompt } from "./prompts.ts";
import { formatReferenceWarnings, readPlanReference, readReference } from "./references.ts";
import { DEFAULT_REVIEW_ANGLES } from "./roles.ts";
import type { ParallelWorkerTaskParams, ParallelWorkersParams, ReviewTargetParams, WorkerAgentParams } from "./schemas.ts";

type WorkflowUpdate = (text: string, status?: ChildStatusUpdate) => void;

export interface WorkflowDeps {
	loadConfig?: typeof loadConfig;
	readPlanReference?: typeof readPlanReference;
	readReference?: typeof readReference;
	spawnPiRole?: typeof spawnPiRole;
	copyArtifactFile?: typeof copyArtifactFile;
	existsSync?: typeof fs.existsSync;
}

const MAX_REVIEW_TARGET_REVIEWERS = 8;

const defaultWorkflowDeps: Required<WorkflowDeps> = {
	loadConfig,
	readPlanReference,
	readReference,
	spawnPiRole,
	copyArtifactFile,
	existsSync: fs.existsSync,
};

function workflowDeps(overrides?: WorkflowDeps): Required<WorkflowDeps> {
	return { ...defaultWorkflowDeps, ...(overrides ?? {}) };
}

function formatRunTask(planText: string, planSource: string, runDir: string, warnings: readonly string[] = []): string {
	return `Run directory: ${runDir}\nPlan source: ${planSource}${formatReferenceWarnings(warnings)}\n\nPlan / instruction:\n${planText}\n\nStart by writing orchestration.md. Then follow the orchestrator workflow. If the plan is unclear, stop and ask the user for clarification instead of guessing.`;
}

function tokenizeCommand(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else if (char === "\\" && quote === "\"" && index + 1 < input.length) {
				const next = input[index + 1];
				if (next === "\"" || next === "\\") {
					current += next;
					index++;
				} else {
					current += char;
				}
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

function quoteTargetIfNeeded(target: string): string {
	if (!target.startsWith("@") || !/\s/.test(target)) return target;
	return `@"${target.slice(1).replace(/"/g, "\\\"")}"`;
}

function safePathLabel(value: string | undefined, fallback: string): string {
	return (value ?? fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || fallback;
}

function forwardChildStatus(onUpdate: WorkflowUpdate | undefined): (status: ChildStatusUpdate) => void {
	return (status) => onUpdate?.("", status);
}

function requireNonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must be a non-empty string`);
	return trimmed;
}

export function parseReviewTargetCommand(input: string): ReviewTargetParams {
	const trimmed = input.trim();
	const tokens = tokenizeCommand(trimmed);
	const reviewers: string[] = [];
	let includeScout: boolean | undefined;
	let cursor = 0;
	while (cursor < tokens.length) {
		const token = tokens[cursor];
		if (token === "--no-scout") {
			includeScout = false;
			cursor++;
			continue;
		}
		if (token === "--scout") {
			includeScout = true;
			cursor++;
			continue;
		}
		if (token === "--reviewer") {
			const reviewer = tokens[cursor + 1];
			if (!reviewer) throw new Error("/review --reviewer requires an angle/focus value");
			reviewers.push(reviewer);
			cursor += 2;
			continue;
		}
		if (token.startsWith("--reviewer=")) {
			const reviewer = token.slice("--reviewer=".length).trim();
			if (!reviewer) throw new Error("/review --reviewer requires an angle/focus value");
			reviewers.push(reviewer);
			cursor++;
			continue;
		}
		break;
	}
	if (cursor > 0) {
		const target = tokens[cursor];
		if (!target) throw new Error("/review requires a target after options");
		const focus = tokens.slice(cursor + 1).join(" ").trim();
		return {
			target: quoteTargetIfNeeded(target),
			...(focus ? { focus } : {}),
			...(reviewers.length > 0 ? { reviewers } : {}),
			...(includeScout !== undefined ? { includeScout } : {}),
		};
	}
	const match = /^(@(?:"[^"]+"|'[^']+'|\S+))(?:\s+([\s\S]+))?$/.exec(trimmed);
	if (!match) return { target: trimmed };
	const focus = match[2]?.trim();
	return focus ? { target: match[1], focus } : { target: match[1] };
}

export async function runOrchestration(cwd: string, rawPlan: string, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps): Promise<{ result: ChildRunResult; runDir: string; planSource: string }> {
	const dep = workflowDeps(deps);
	const planInput = requireNonEmpty(rawPlan, "orchestration plan");
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	const { planText, planSource, warnings } = dep.readPlanReference(cwd, planInput, config);
	writeArtifact(dir, "input-plan.md", `Source: ${planSource}${formatReferenceWarnings(warnings)}

${planText}
`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));
	const task = formatRunTask(planText, planSource, dir, warnings);
	const result = await dep.spawnPiRole({ cwd, role: "orchestrator", task, runDir: dir, config, signal, onUpdate, onStatus: forwardChildStatus(onUpdate), statusKey: "subagent:orchestrator", statusLabel: "orchestrator" });
	return { result, runDir: dir, planSource };
}

type WorkerPurpose = NonNullable<WorkerAgentParams["purpose"]>;

interface WorkerRunRecord {
	name: string;
	runDir: string;
	taskSource: string;
	result: ChildRunResult;
	outputArtifactPath: string;
	purpose: WorkerPurpose;
}

async function runWorkerInDir(cwd: string, dir: string, params: WorkerAgentParams | ParallelWorkerTaskParams, signal: AbortSignal | undefined, onUpdate: WorkflowUpdate | undefined, progressLabel = "worker", deps?: WorkflowDeps): Promise<WorkerRunRecord> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	ensureDir(dir);
	const taskInput = requireNonEmpty(params.task, "worker task");
	const workerTask = dep.readReference(cwd, taskInput, "worker task", config, { allowDirectory: true });
	const purpose: WorkerPurpose = params.purpose ?? "implementation";
	const outputFile = params.outputFile?.trim() || "worker-report.md";
	const outputArtifactPath = validateOutputArtifactPath(dir, outputFile);
	const referenceWarningText = formatReferenceWarnings(workerTask.warnings);
	const name = "name" in params && params.name?.trim() ? params.name.trim() : progressLabel;
	writeArtifact(dir, "input-worker-task.md", `Source: ${workerTask.source}\nName: ${name}\nPurpose: ${purpose}\nExpected output artifact: ${outputFile}${referenceWarningText}\n\n${workerTask.text}\n`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));
	const task = `Worker task source: ${workerTask.source}\nName: ${name}\nPurpose: ${purpose}\nExpected output artifact: ${outputFile}${referenceWarningText}\nRun directory: ${dir}\nRead input-worker-task.md, perform the requested work, run useful checks, and write ${outputFile}. If running as part of a parallel worker batch, stay within the assigned task and avoid editing files likely owned by sibling workers. If a product, architecture, or scope decision is missing, stop and report it instead of guessing.`;
	const result = await dep.spawnPiRole({ cwd, role: "worker", task, runDir: dir, config, signal, onUpdate: (text) => onUpdate?.(`${progressLabel}: ${text}`), onStatus: forwardChildStatus(onUpdate), statusKey: `subagent:${safePathLabel(progressLabel, "worker")}`, statusLabel: progressLabel });
	if (result.exitCode === 0) {
		validateOutputArtifactPath(dir, outputFile);
		if (!dep.existsSync(outputArtifactPath)) dep.copyArtifactFile(dir, result.outputPath, outputArtifactPath);
	}
	return { name, runDir: dir, taskSource: workerTask.source, result: { ...result, outputPath: result.exitCode === 0 ? outputArtifactPath : result.outputPath }, outputArtifactPath, purpose };
}

export async function runWorkerAgent(cwd: string, params: WorkerAgentParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps): Promise<WorkerRunRecord> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	const record = await runWorkerInDir(cwd, dir, params, signal, onUpdate, "worker", dep);
	if (record.result.exitCode !== 0) throwChildRunError("worker failed", record.result);
	return record;
}

export async function runParallelWorkers(cwd: string, params: ParallelWorkersParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps): Promise<{ runDir: string; workers: WorkerRunRecord[]; failed: WorkerRunRecord[] }> {
	if (params.tasks.length < 2 || params.tasks.length > 8) throw new Error("runParallelWorkers requires 2-8 tasks");
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());

	// Validate references/output paths before spawning any children so setup errors do not leave siblings running.
	for (const [index, task] of params.tasks.entries()) {
		dep.readReference(cwd, requireNonEmpty(task.task, `worker ${index + 1} task`), `worker ${index + 1} task`, config, { allowDirectory: true });
		const label = safePathLabel(task.name, `worker-${index + 1}`);
		const workerDir = path.join(dir, `${String(index + 1).padStart(2, "0")}-${label}`);
		validateOutputArtifactPath(workerDir, task.outputFile?.trim() || "worker-report.md");
	}

	ensureDir(dir);
	writeArtifact(dir, "parallel-workers.md", `# Parallel Workers\n\n${params.tasks.map((task, index) => `## Worker ${index + 1}: ${task.name?.trim() || `worker-${index + 1}`}\n\nPurpose: ${task.purpose ?? "implementation"}\n\n${task.task}`).join("\n\n")}\n`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));
	onUpdate?.(`parallel-workers: starting ${params.tasks.length} workers`);
	const localAbort = new AbortController();
	const forwardAbort = () => localAbort.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) forwardAbort();
		else signal.addEventListener("abort", forwardAbort, { once: true });
	}
	try {
		const promises = params.tasks.map((task, index) => {
			const label = safePathLabel(task.name, `worker-${index + 1}`);
			const workerDir = path.join(dir, `${String(index + 1).padStart(2, "0")}-${label}`);
			const progress = `worker ${index + 1}/${params.tasks.length}${task.name ? ` ${task.name}` : ""}`;
			return runWorkerInDir(cwd, workerDir, task, localAbort.signal, onUpdate, progress, dep).catch((error) => {
				if (!localAbort.signal.aborted) localAbort.abort(error);
				throw error;
			});
		});
		const settled = await Promise.allSettled(promises);
		const workers = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
		const rejected = settled.flatMap((entry, index) => entry.status === "rejected" ? [{ index, reason: entry.reason }] : []);
		const failed = workers.filter((worker) => worker.result.exitCode !== 0);
		const summaryPath = writeArtifact(dir, "parallel-workers-summary.md", `# Parallel Workers Summary\n\n${workers.map((worker, index) => `## Worker ${index + 1}: ${worker.name}\n\n- Exit code: ${worker.result.exitCode}\n- Run dir: ${worker.runDir}\n- Output: ${worker.outputArtifactPath}\n- Transcript: ${worker.result.transcriptPath}`).join("\n\n")}${rejected.length > 0 ? `\n\n## Setup/spawn errors\n\n${rejected.map((entry) => `- Worker ${entry.index + 1}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`).join("\n")}` : ""}\n`);
		if (rejected.length > 0) {
			throw new Error(`Parallel workers aborted after error(s): ${rejected.map((entry) => `worker ${entry.index + 1}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`).join("; ")}\nRun dir: ${dir}\nSummary: ${summaryPath}`);
		}
		if (failed.length > 0) {
			throw new Error(`Parallel workers failed: ${failed.map((worker) => `${worker.name} exit ${worker.result.exitCode}`).join(", ")}\nRun dir: ${dir}\nSummary: ${summaryPath}`);
		}
		return { runDir: dir, workers, failed };
	} finally {
		if (signal) signal.removeEventListener("abort", forwardAbort);
	}
}

export async function runReviewTarget(cwd: string, params: ReviewTargetParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps): Promise<{ runDir: string; targetSource: string; scout?: ChildRunResult; reviews: ChildRunResult[]; synthesis: ChildRunResult; finalSummaryPath: string }> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	const target = dep.readReference(cwd, requireNonEmpty(params.target, "review target"), "review target", config, { allowDirectory: true });
	const focus = params.focus?.trim() || "runtime bugs, security boundaries, API/UX, packaging, and maintainability";
	const referenceWarningText = formatReferenceWarnings(target.warnings);
	if (params.reviewers && params.reviewers.length > MAX_REVIEW_TARGET_REVIEWERS) throw new Error(`review_target supports at most ${MAX_REVIEW_TARGET_REVIEWERS} reviewers`);
	const reviewers = params.reviewers && params.reviewers.length > 0 ? params.reviewers.map((reviewer, index) => requireNonEmpty(reviewer, `reviewer ${index + 1}`)) : [...DEFAULT_REVIEW_ANGLES];
	writeArtifact(dir, "input-target.md", `Source: ${target.source}\nFocus: ${focus}${referenceWarningText}\n\n${target.text}\n`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));

	let scout: ChildRunResult | undefined;
	if (params.includeScout ?? true) {
		onUpdate?.("review-target: scout running");
		scout = await dep.spawnPiRole({
			cwd,
			role: "scout",
			task: `Review target source: ${target.source}\nFocus: ${focus}${referenceWarningText}\nRun directory: ${dir}\nRead input-target.md, inspect the target directly, and write scout-review-context.md.`,
			runDir: dir,
			config,
			signal,
			onUpdate,
			onStatus: forwardChildStatus(onUpdate),
			statusKey: "subagent:scout",
			statusLabel: "scout",
			systemPrompt: reviewTargetSystemPrompt("scout", dir, config),
		});
		if (scout.exitCode !== 0) throwChildRunError("review-target scout failed", scout);
		const scoutArtifact = resolveArtifactPath(dir, "scout-review-context.md");
		if (!dep.existsSync(scoutArtifact)) dep.copyArtifactFile(dir, scout.outputPath, scoutArtifact);
	}

	onUpdate?.(`review-target: ${reviewers.length} reviewers running in parallel`);
	const localAbort = new AbortController();
	const forwardAbort = () => localAbort.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) forwardAbort();
		else signal.addEventListener("abort", forwardAbort, { once: true });
	}
	let reviewRecords: Array<{ result: ChildRunResult; expectedPath: string; angle: string }>;
	try {
		const reviewPromises = reviewers.map(async (angle, index) => {
			onUpdate?.(`review-target: reviewer ${index + 1}/${reviewers.length} starting`);
			const safeName = angle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `review-${index + 1}`;
			const expectedFile = `review-${index + 1}-${safeName}.md`;
			const expectedPath = resolveArtifactPath(dir, expectedFile);
			const result = await dep.spawnPiRole({
				cwd,
				role: "reviewer",
				task: `Review target source: ${target.source}\nFocus: ${focus}${referenceWarningText}\nAssigned review angle: ${angle}\nRun directory: ${dir}\nRead input-target.md${scout ? " and scout-review-context.md" : ""}, inspect the target directly, and write ${expectedFile}. Prefer not to modify project/source files unless that is useful evidence for the review.`,
				runDir: dir,
				config,
				signal: localAbort.signal,
				onUpdate,
				onStatus: forwardChildStatus(onUpdate),
				statusKey: `subagent:reviewer-${index + 1}`,
				statusLabel: `reviewer-${index + 1}`,
				systemPrompt: reviewTargetSystemPrompt("reviewer", dir, config),
			});
			if (result.exitCode !== 0) throw new Error(childResultText(`review-target reviewer ${index + 1} failed`, result));
			if (!dep.existsSync(expectedPath)) dep.copyArtifactFile(dir, result.outputPath, expectedPath);
			return { result, expectedPath, angle };
		}).map((promise) => promise.catch((error) => {
			if (!localAbort.signal.aborted) localAbort.abort(error);
			throw error;
		}));
		const settled = await Promise.allSettled(reviewPromises);
		const failures = settled.flatMap((entry, index) => entry.status === "rejected" ? [`reviewer ${index + 1}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`] : []);
		if (failures.length > 0) throw new Error(`Review target reviewer fanout failed: ${failures.join("; ")}\nRun dir: ${dir}`);
		reviewRecords = settled.map((entry) => {
			if (entry.status !== "fulfilled") throw new Error("unreachable review settlement state");
			return entry.value;
		});
	} finally {
		if (signal) signal.removeEventListener("abort", forwardAbort);
	}
	const reviews = reviewRecords.map((entry) => entry.result);

	onUpdate?.("review-target: synthesis running");
	const synthesis = await dep.spawnPiRole({
		cwd,
		role: "reviewer",
		task: `Synthesize this review-only run.\nTarget source: ${target.source}\nFocus: ${focus}${referenceWarningText}\nRun directory: ${dir}\nRead input-target.md, ${scout ? "scout-review-context.md, " : ""}the review artifacts and output logs below, then write final-summary.md.\n\nReview artifacts and outputs:\n${reviewRecords.map((r, i) => `- Reviewer ${i + 1} (${r.angle}): artifact ${r.expectedPath}; output log ${r.result.outputPath}`).join("\n")}`,
		runDir: dir,
		config,
		signal,
		onUpdate,
		onStatus: forwardChildStatus(onUpdate),
		statusKey: "subagent:synthesis",
		statusLabel: "synthesis",
		systemPrompt: reviewTargetSystemPrompt("synthesis", dir, config),
	});
	if (synthesis.exitCode !== 0) throwChildRunError("review-target synthesis failed", synthesis);
	const finalSummaryPath = resolveArtifactPath(dir, "final-summary.md");
	if (!dep.existsSync(finalSummaryPath)) dep.copyArtifactFile(dir, synthesis.outputPath, finalSummaryPath);
	return { runDir: dir, targetSource: target.source, scout, reviews, synthesis, finalSummaryPath };
}
