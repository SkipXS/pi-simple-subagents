import * as fs from "node:fs";
import * as path from "node:path";
import { copyArtifactFile, ensureDir, resolveArtifactPath, resolveRunBaseDir, runId, writeArtifact } from "./artifacts.ts";
import { childResultText, spawnPiRole, throwChildRunError, type ChildRunResult } from "./child-runner.ts";
import { loadConfig } from "./config.ts";
import { reviewTargetSystemPrompt } from "./prompts.ts";
import { formatReferenceWarnings, readPlanReference, readReference } from "./references.ts";
import { DEFAULT_REVIEW_ANGLES } from "./roles.ts";
import type { ParallelWorkerTaskParams, ParallelWorkersParams, ReviewTargetParams, WorkerAgentParams } from "./schemas.ts";

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
				current += input[++index];
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
	return `@"${target.slice(1).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function safePathLabel(value: string | undefined, fallback: string): string {
	return (value ?? fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || fallback;
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
			if (!reviewer) throw new Error("/review-target --reviewer requires an angle/focus value");
			reviewers.push(reviewer);
			cursor += 2;
			continue;
		}
		if (token.startsWith("--reviewer=")) {
			const reviewer = token.slice("--reviewer=".length).trim();
			if (!reviewer) throw new Error("/review-target --reviewer requires an angle/focus value");
			reviewers.push(reviewer);
			cursor++;
			continue;
		}
		break;
	}
	if (cursor > 0) {
		const target = tokens[cursor];
		if (!target) throw new Error("/review-target requires a target after options");
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

export async function runOrchestration(cwd: string, rawPlan: string, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<{ result: ChildRunResult; runDir: string; planSource: string }> {
	const config = loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	const { planText, planSource, warnings } = readPlanReference(cwd, rawPlan, config);
	writeArtifact(dir, "input-plan.md", `Source: ${planSource}${formatReferenceWarnings(warnings)}

${planText}
`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));
	const task = formatRunTask(planText, planSource, dir, warnings);
	const result = await spawnPiRole({ cwd, role: "orchestrator", task, runDir: dir, config, signal, onUpdate });
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

async function runWorkerInDir(cwd: string, dir: string, params: WorkerAgentParams | ParallelWorkerTaskParams, signal: AbortSignal | undefined, onUpdate: ((text: string) => void) | undefined, progressLabel = "worker"): Promise<WorkerRunRecord> {
	const config = loadConfig(cwd);
	ensureDir(dir);
	const workerTask = readReference(cwd, params.task, "worker task", config, { allowDirectory: true });
	const purpose: WorkerPurpose = params.purpose ?? "implementation";
	const outputFile = params.outputFile?.trim() || "worker-report.md";
	const outputArtifactPath = resolveArtifactPath(dir, outputFile);
	const referenceWarningText = formatReferenceWarnings(workerTask.warnings);
	const name = "name" in params && params.name?.trim() ? params.name.trim() : progressLabel;
	writeArtifact(dir, "input-worker-task.md", `Source: ${workerTask.source}\nName: ${name}\nPurpose: ${purpose}\nExpected output artifact: ${outputFile}${referenceWarningText}\n\n${workerTask.text}\n`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));
	const task = `Worker task source: ${workerTask.source}\nName: ${name}\nPurpose: ${purpose}\nExpected output artifact: ${outputFile}${referenceWarningText}\nRun directory: ${dir}\nRead input-worker-task.md, perform the requested work, run useful checks, and write ${outputFile}. If running as part of a parallel worker batch, stay within the assigned task and avoid editing files likely owned by sibling workers. If a product, architecture, or scope decision is missing, stop and report it instead of guessing.`;
	const result = await spawnPiRole({ cwd, role: "worker", task, runDir: dir, config, signal, onUpdate: (text) => onUpdate?.(`${progressLabel}: ${text}`) });
	if (result.exitCode === 0 && !fs.existsSync(outputArtifactPath)) copyArtifactFile(dir, result.outputPath, outputArtifactPath);
	return { name, runDir: dir, taskSource: workerTask.source, result: { ...result, outputPath: result.exitCode === 0 ? outputArtifactPath : result.outputPath }, outputArtifactPath, purpose };
}

export async function runWorkerAgent(cwd: string, params: WorkerAgentParams, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<WorkerRunRecord> {
	const config = loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	const record = await runWorkerInDir(cwd, dir, params, signal, onUpdate);
	if (record.result.exitCode !== 0) throwChildRunError("worker failed", record.result);
	return record;
}

export async function runParallelWorkers(cwd: string, params: ParallelWorkersParams, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<{ runDir: string; workers: WorkerRunRecord[]; failed: WorkerRunRecord[] }> {
	if (params.tasks.length < 2 || params.tasks.length > 8) throw new Error("runParallelWorkers requires 2-8 tasks");
	const config = loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	writeArtifact(dir, "parallel-workers.md", `# Parallel Workers\n\n${params.tasks.map((task, index) => `## Worker ${index + 1}: ${task.name?.trim() || `worker-${index + 1}`}\n\nPurpose: ${task.purpose ?? "implementation"}\n\n${task.task}`).join("\n\n")}\n`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));
	onUpdate?.(`parallel-workers: starting ${params.tasks.length} workers`);
	const workers = await Promise.all(params.tasks.map((task, index) => {
		const label = safePathLabel(task.name, `worker-${index + 1}`);
		const workerDir = path.join(dir, `${String(index + 1).padStart(2, "0")}-${label}`);
		return runWorkerInDir(cwd, workerDir, task, signal, onUpdate, `worker ${index + 1}/${params.tasks.length}${task.name ? ` ${task.name}` : ""}`);
	}));
	const failed = workers.filter((worker) => worker.result.exitCode !== 0);
	writeArtifact(dir, "parallel-workers-summary.md", `# Parallel Workers Summary\n\n${workers.map((worker, index) => `## Worker ${index + 1}: ${worker.name}\n\n- Exit code: ${worker.result.exitCode}\n- Run dir: ${worker.runDir}\n- Output: ${worker.outputArtifactPath}\n- Transcript: ${worker.result.transcriptPath}`).join("\n\n")}\n`);
	if (failed.length > 0) {
		throw new Error(`Parallel workers failed: ${failed.map((worker) => `${worker.name} exit ${worker.result.exitCode}`).join(", ")}\nRun dir: ${dir}`);
	}
	return { runDir: dir, workers, failed };
}

export async function runReviewTarget(cwd: string, params: ReviewTargetParams, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<{ runDir: string; targetSource: string; scout?: ChildRunResult; reviews: ChildRunResult[]; synthesis: ChildRunResult; finalSummaryPath: string }> {
	const config = loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	const target = readReference(cwd, params.target, "review target", config, { allowDirectory: true });
	const focus = params.focus?.trim() || "runtime bugs, security boundaries, API/UX, packaging, and maintainability";
	const referenceWarningText = formatReferenceWarnings(target.warnings);
	const reviewers = params.reviewers && params.reviewers.length > 0 ? params.reviewers : [...DEFAULT_REVIEW_ANGLES];
	writeArtifact(dir, "input-target.md", `Source: ${target.source}\nFocus: ${focus}${referenceWarningText}\n\n${target.text}\n`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));

	let scout: ChildRunResult | undefined;
	if (params.includeScout ?? true) {
		onUpdate?.("review-target: scout running");
		scout = await spawnPiRole({
			cwd,
			role: "scout",
			task: `Review target source: ${target.source}\nFocus: ${focus}${referenceWarningText}\nRun directory: ${dir}\nRead input-target.md, inspect the target directly, and write scout-review-context.md.`,
			runDir: dir,
			config,
			signal,
			onUpdate,
			systemPrompt: reviewTargetSystemPrompt("scout", dir),
		});
		if (scout.exitCode !== 0) throwChildRunError("review-target scout failed", scout);
		const scoutArtifact = resolveArtifactPath(dir, "scout-review-context.md");
		if (!fs.existsSync(scoutArtifact)) copyArtifactFile(dir, scout.outputPath, scoutArtifact);
	}

	const reviewRecords: Array<{ result: ChildRunResult; expectedPath: string; angle: string }> = [];
	for (const [index, angle] of reviewers.entries()) {
		onUpdate?.(`review-target: reviewer ${index + 1}/${reviewers.length} running`);
		const safeName = angle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `review-${index + 1}`;
		const expectedFile = `review-${index + 1}-${safeName}.md`;
		const expectedPath = resolveArtifactPath(dir, expectedFile);
		const result = await spawnPiRole({
			cwd,
			role: "reviewer",
			task: `Review target source: ${target.source}\nFocus: ${focus}${referenceWarningText}\nAssigned review angle: ${angle}\nRun directory: ${dir}\nRead input-target.md${scout ? " and scout-review-context.md" : ""}, inspect the target directly, and write ${expectedFile}. Prefer not to modify project/source files unless that is useful evidence for the review.`,
			runDir: dir,
			config,
			signal,
			onUpdate,
			systemPrompt: reviewTargetSystemPrompt("reviewer", dir),
		});
		if (result.exitCode !== 0) throw new Error(childResultText(`review-target reviewer ${index + 1} failed`, result));
		if (!fs.existsSync(expectedPath)) copyArtifactFile(dir, result.outputPath, expectedPath);
		reviewRecords.push({ result, expectedPath, angle });
	}
	const reviews = reviewRecords.map((entry) => entry.result);

	onUpdate?.("review-target: synthesis running");
	const synthesis = await spawnPiRole({
		cwd,
		role: "reviewer",
		task: `Synthesize this review-only run.\nTarget source: ${target.source}\nFocus: ${focus}${referenceWarningText}\nRun directory: ${dir}\nRead input-target.md, ${scout ? "scout-review-context.md, " : ""}the review artifacts and output logs below, then write final-summary.md.\n\nReview artifacts and outputs:\n${reviewRecords.map((r, i) => `- Reviewer ${i + 1} (${r.angle}): artifact ${r.expectedPath}; output log ${r.result.outputPath}`).join("\n")}`,
		runDir: dir,
		config,
		signal,
		onUpdate,
		systemPrompt: reviewTargetSystemPrompt("synthesis", dir),
	});
	if (synthesis.exitCode !== 0) throwChildRunError("review-target synthesis failed", synthesis);
	const finalSummaryPath = resolveArtifactPath(dir, "final-summary.md");
	if (!fs.existsSync(finalSummaryPath)) copyArtifactFile(dir, synthesis.outputPath, finalSummaryPath);
	return { runDir: dir, targetSource: target.source, scout, reviews, synthesis, finalSummaryPath };
}
