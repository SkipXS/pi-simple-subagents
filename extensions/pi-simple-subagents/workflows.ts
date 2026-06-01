import * as fs from "node:fs";
import * as path from "node:path";
import { copyArtifactFile, ensureDir, resolveArtifactPath, resolveRunBaseDir, runId, writeArtifact } from "./artifacts.ts";
import { childResultText, spawnPiRole, throwChildRunError, type ChildRunResult } from "./child-runner.ts";
import { loadConfig } from "./config.ts";
import { reviewTargetSystemPrompt } from "./prompts.ts";
import { readPlanReference, readReference } from "./references.ts";
import { DEFAULT_REVIEW_ANGLES, MAX_REVIEW_ANGLES } from "./roles.ts";
import type { ReviewTargetParams } from "./schemas.ts";

function formatRunTask(planText: string, planSource: string, runDir: string): string {
	return `Run directory: ${runDir}\nPlan source: ${planSource}\n\nPlan / instruction:\n${planText}\n\nStart by writing orchestration.md. Then follow the orchestrator workflow. If the plan is unclear, stop and ask the user for clarification instead of guessing.`;
}

export function parseReviewTargetCommand(input: string): Pick<ReviewTargetParams, "target" | "focus"> {
	const trimmed = input.trim();
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
	const { planText, planSource } = readPlanReference(cwd, rawPlan, config);
	writeArtifact(dir, "input-plan.md", `Source: ${planSource}\n\n${planText}\n`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));
	const task = formatRunTask(planText, planSource, dir);
	const result = await spawnPiRole({ cwd, role: "orchestrator", task, runDir: dir, config, signal, onUpdate });
	return { result, runDir: dir, planSource };
}

export async function runReviewTarget(cwd: string, params: ReviewTargetParams, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<{ runDir: string; targetSource: string; scout?: ChildRunResult; reviews: ChildRunResult[]; synthesis: ChildRunResult; finalSummaryPath: string }> {
	const config = loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	const target = readReference(cwd, params.target, "review target", config, { allowDirectory: true });
	const focus = params.focus?.trim() || "runtime bugs, security boundaries, API/UX, packaging, and maintainability";
	const reviewers = (params.reviewers && params.reviewers.length > 0 ? params.reviewers : [...DEFAULT_REVIEW_ANGLES]).slice(0, MAX_REVIEW_ANGLES);
	writeArtifact(dir, "input-target.md", `Source: ${target.source}\nFocus: ${focus}\n\n${target.text}\n`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));

	let scout: ChildRunResult | undefined;
	if (params.includeScout ?? true) {
		onUpdate?.("review-target: scout running");
		scout = await spawnPiRole({
			cwd,
			role: "scout",
			task: `Review target source: ${target.source}\nFocus: ${focus}\nRun directory: ${dir}\nRead input-target.md, inspect the target directly, and write scout-review-context.md.`,
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

	const reviewerAbort = new AbortController();
	const abortReviewers = () => reviewerAbort.abort();
	if (signal) {
		if (signal.aborted) abortReviewers();
		else signal.addEventListener("abort", abortReviewers, { once: true });
	}
	let firstReviewFailure: unknown;
	const settledReviews = await Promise.allSettled(reviewers.map(async (angle, index) => {
		onUpdate?.(`review-target: reviewer ${index + 1}/${reviewers.length} running`);
		const safeName = angle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `review-${index + 1}`;
		const expectedFile = `review-${index + 1}-${safeName}.md`;
		const expectedPath = resolveArtifactPath(dir, expectedFile);
		let result: ChildRunResult;
		try {
			result = await spawnPiRole({
				cwd,
				role: "reviewer",
				task: `Review target source: ${target.source}\nFocus: ${focus}\nAssigned review angle: ${angle}\nRun directory: ${dir}\nRead input-target.md${scout ? " and scout-review-context.md" : ""}, inspect the target directly, and write ${expectedFile}. Do not modify project/source files.`,
				runDir: dir,
				config,
				signal: reviewerAbort.signal,
				onUpdate,
				systemPrompt: reviewTargetSystemPrompt("reviewer", dir),
			});
		} catch (error) {
			firstReviewFailure ??= error;
			reviewerAbort.abort();
			throw error;
		}
		if (result.exitCode !== 0) {
			const error = new Error(childResultText(`review-target reviewer ${index + 1} failed`, result));
			firstReviewFailure ??= error;
			reviewerAbort.abort();
			throw error;
		}
		if (!fs.existsSync(expectedPath)) copyArtifactFile(dir, result.outputPath, expectedPath);
		return { result, expectedPath, angle };
	}));
	if (signal) signal.removeEventListener("abort", abortReviewers);
	const firstFailedReview = settledReviews.find((entry) => entry.status === "rejected") as PromiseRejectedResult | undefined;
	if (firstFailedReview) throw firstReviewFailure ?? firstFailedReview.reason;
	const reviewRecords = settledReviews.map((entry) => (entry as PromiseFulfilledResult<{ result: ChildRunResult; expectedPath: string; angle: string }>).value);
	const reviews = reviewRecords.map((entry) => entry.result);

	onUpdate?.("review-target: synthesis running");
	const synthesis = await spawnPiRole({
		cwd,
		role: "reviewer",
		task: `Synthesize this review-only run.\nTarget source: ${target.source}\nFocus: ${focus}\nRun directory: ${dir}\nRead input-target.md, ${scout ? "scout-review-context.md, " : ""}the review artifacts and output logs below, then write final-summary.md.\n\nReview artifacts and outputs:\n${reviewRecords.map((r, i) => `- Reviewer ${i + 1} (${r.angle}): artifact ${r.expectedPath}; output log ${r.result.outputPath}`).join("\n")}`,
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
