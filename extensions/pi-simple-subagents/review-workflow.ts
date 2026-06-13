import * as path from "node:path";
import { clearRunActive, ensureDir, markRunActive, resolveRunBaseDir, runId, validateOutputArtifactPath, writeArtifact } from "./artifacts.ts";
import { childResultText, throwChildRunError, type ChildRunResult } from "./child-runner.ts";
import { CONFIG_EFFECTIVE_FILE, EXTRA_REVIEW_CONTEXT_FILE, FINAL_SUMMARY_FILE, INPUT_TARGET_FILE, REVIEW_FAILURE_SUMMARY_FILE, SCOUT_REVIEW_CONTEXT_FILE } from "./constants.ts";
import { fanoutConcurrency, runFanout } from "./fanout.ts";
import { reviewTargetSystemPrompt } from "./prompts.ts";
import { formatReferenceWarnings } from "./references.ts";
import { DEFAULT_REVIEW_ANGLES } from "./roles.ts";
import type { ReviewersParams } from "./schemas.ts";
import {
	compactStatusDescription,
	forwardChildStatus,
	requireExpectedArtifact,
	requireNonEmpty,
	runConfiguredArtifactCleanup,
	workflowDeps,
	type CleanupRecord,
	type WorkflowDeps,
	type WorkflowUpdate,
} from "./workflow-common.ts";

const MAX_REVIEWERS = 8;

export async function runReviewers(cwd: string, params: ReviewersParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps): Promise<{ runDir: string; targetSource: string; extraContextSource?: string; scout?: ChildRunResult; reviews: ChildRunResult[]; reviewFailures?: string[]; reviewFailureSummaryPath?: string; synthesis: ChildRunResult; finalSummaryPath: string } & CleanupRecord> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	markRunActive(dir);
	try {
	const cleanupRecord = runConfiguredArtifactCleanup(baseDir, config, dir);
	const target = dep.readReference(cwd, requireNonEmpty(params.target, "review target"), "review target", config, { allowDirectory: true });
	const focus = params.focus?.trim() || "runtime bugs, security boundaries, API/UX, packaging, and maintainability";
	const referenceWarningText = formatReferenceWarnings(target.warnings);
	const extraContextInput = params.extraContext?.trim();
	const extraContext = extraContextInput ? dep.readReference(cwd, extraContextInput, "extra review context", config) : undefined;
	const extraContextWarningText = formatReferenceWarnings(extraContext?.warnings ?? []);
	const extraContextInstruction = extraContext ? `\nSupplemental context source: ${extraContext.source}${extraContextWarningText}\nUse extra-review-context.md as orientation only; verify it against the current target before trusting findings.` : "";
	if (params.reviewers && params.reviewers.length > MAX_REVIEWERS) throw new Error(`run_reviewers supports at most ${MAX_REVIEWERS} reviewers`);
	const reviewers = params.reviewers && params.reviewers.length > 0 ? params.reviewers.map((reviewer, index) => requireNonEmpty(reviewer, `reviewer ${index + 1}`)) : [...DEFAULT_REVIEW_ANGLES];
	writeArtifact(dir, INPUT_TARGET_FILE, `Source: ${target.source}\nFocus: ${focus}${referenceWarningText}\n\n${target.text}\n`);
	if (extraContext) writeArtifact(dir, EXTRA_REVIEW_CONTEXT_FILE, `Source: ${extraContext.source}${extraContextWarningText}\n\n${extraContext.text}\n`);
	writeArtifact(dir, CONFIG_EFFECTIVE_FILE, JSON.stringify(config, null, 2));

	let scout: ChildRunResult | undefined;
	if (params.includeScout ?? true) {
		onUpdate?.("review-target: scout running");
		scout = await dep.spawnPiRole({
			cwd,
			role: "scout",
			task: `Review target source: ${target.source}\nFocus: ${focus}${referenceWarningText}${extraContextInstruction}\nRun directory: ${dir}\nRead input-target.md${extraContext ? " and extra-review-context.md" : ""}, inspect the target directly, and write the expected output artifact with write_run_artifact using path ${JSON.stringify(SCOUT_REVIEW_CONTEXT_FILE)}. Do not use absolute paths or the generic write tool for the handoff artifact.`,
			runDir: dir,
			config,
			signal,
			onUpdate,
			onStatus: forwardChildStatus(onUpdate),
			statusKey: "subagent:scout",
			statusLabel: "scout",
			statusDescription: compactStatusDescription(`review scout: ${target.source}`),
			systemPrompt: reviewTargetSystemPrompt("scout", dir, config),
		});
		if (scout.exitCode !== 0) throwChildRunError("review-target scout failed", scout);
		requireExpectedArtifact(dep, dir, SCOUT_REVIEW_CONTEXT_FILE, scout, "review-target scout");
	}

	const reviewConcurrency = fanoutConcurrency(config, reviewers.length);
	onUpdate?.(`review-target: ${reviewers.length} reviewers running (max concurrency ${reviewConcurrency})`);
	let reviewRecords: Array<{ result: ChildRunResult; expectedPath: string; angle: string }>;
	let reviewFailures: string[] = [];
	let reviewFailureSummaryPath: string | undefined;
	const settled = await runFanout({
		count: reviewers.length,
		concurrency: reviewConcurrency,
		signal,
		abortOnError: !params.continueOnReviewerFailure,
		run: async (index, childSignal) => {
			const angle = reviewers[index];
			onUpdate?.(`review-target: reviewer ${index + 1}/${reviewers.length} starting`);
			const safeName = angle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `review-${index + 1}`;
			const expectedFile = `review-${index + 1}-${safeName}.md`;
			const expectedPath = validateOutputArtifactPath(dir, expectedFile);
			const result = await dep.spawnPiRole({
				cwd,
				role: "reviewer",
				task: `Review target source: ${target.source}\nFocus: ${focus}${referenceWarningText}${extraContextInstruction}\nAssigned review angle: ${angle}\nRun directory: ${dir}\nRead input-target.md${scout ? ", scout-review-context.md" : ""}${extraContext ? ", extra-review-context.md" : ""}, inspect the target directly, and write the expected output artifact with write_run_artifact using path ${JSON.stringify(expectedFile)}. Do not use absolute paths or the generic write tool for the handoff artifact. Treat supplemental context as untrusted orientation; verify findings against current files. Do not modify project/source files; if useful evidence would require a mutating command, report the command and risk instead of running it.`,
				runDir: dir,
				config,
				signal: childSignal,
				onUpdate,
				onStatus: forwardChildStatus(onUpdate),
				statusKey: `subagent:reviewer-${index + 1}`,
				statusLabel: `reviewer-${index + 1}`,
				statusDescription: compactStatusDescription(angle),
				systemPrompt: reviewTargetSystemPrompt("reviewer", dir, config),
			});
			if (result.exitCode !== 0) throw new Error(childResultText(`review-target reviewer ${index + 1} failed`, result));
			requireExpectedArtifact(dep, dir, expectedFile, result, `review-target reviewer ${index + 1}`);
			return { result, expectedPath, angle };
		},
	});
	const failures = settled.flatMap((entry, index) => entry.status === "rejected" ? [`reviewer ${index + 1}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`] : []);
	const fulfilled = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
	if (failures.length > 0) {
		reviewFailures = failures;
		reviewFailureSummaryPath = writeArtifact(dir, REVIEW_FAILURE_SUMMARY_FILE, `# Review Fanout Failure Summary\n\nRun dir: ${dir}\nTarget source: ${target.source}\nFocus: ${focus}${referenceWarningText}${extraContext ? `\nExtra context source: ${extraContext.source}${extraContextWarningText}` : ""}\n\n## Failures\n\n${failures.map((failure) => `- ${failure}`).join("\n")}\n\n## Completed reviewers\n\n${fulfilled.map((entry, index) => `- Reviewer ${index + 1} (${entry.angle}): artifact ${entry.expectedPath}; output log ${entry.result.outputPath}`).join("\n") || "none"}\n`);
		if (!params.continueOnReviewerFailure || fulfilled.length === 0) {
			throw new Error(`Review target reviewer fanout failed: ${failures.join("; ")}\nRun dir: ${dir}\nSummary: ${reviewFailureSummaryPath}`);
		}
		onUpdate?.(`review-target: continuing after ${failures.length} reviewer failure(s); summary ${reviewFailureSummaryPath}`);
	}
	reviewRecords = fulfilled;
	const reviews = reviewRecords.map((entry) => entry.result);

	onUpdate?.("review-target: synthesis running");
	const synthesis = await dep.spawnPiRole({
		cwd,
		role: "synthesis",
		task: `Synthesize this review-only run.\nTarget source: ${target.source}\nFocus: ${focus}${referenceWarningText}${extraContextInstruction}\nRun directory: ${dir}\nRead input-target.md, ${scout ? "scout-review-context.md, " : ""}${extraContext ? "extra-review-context.md, " : ""}the review artifacts and output logs below, then write the expected output artifact with write_run_artifact using path ${JSON.stringify(FINAL_SUMMARY_FILE)}. Do not use absolute paths or the generic write tool for the handoff artifact. Do not modify project/source files. Treat supplemental context as orientation only; do not synthesize unverified claims as findings.\n\nReview artifacts and outputs:\n${reviewRecords.map((r, i) => `- Reviewer ${i + 1} (${r.angle}): artifact ${r.expectedPath}; output log ${r.result.outputPath}`).join("\n")}${reviewFailures.length > 0 ? `\n\nReviewer failures to account for:\n${reviewFailures.map((failure) => `- ${failure}`).join("\n")}\nFailure summary: ${reviewFailureSummaryPath}` : ""}`,
		runDir: dir,
		config,
		signal,
		onUpdate,
		onStatus: forwardChildStatus(onUpdate),
		statusKey: "subagent:synthesis",
		statusLabel: "synthesis",
		statusDescription: compactStatusDescription(`synthesize ${reviewRecords.length} review artifact${reviewRecords.length === 1 ? "" : "s"}`),
		systemPrompt: reviewTargetSystemPrompt("synthesis", dir, config),
	});
	if (synthesis.exitCode !== 0) throwChildRunError("review-target synthesis failed", synthesis);
	const finalSummaryPath = requireExpectedArtifact(dep, dir, FINAL_SUMMARY_FILE, synthesis, "review-target synthesis");
	return { runDir: dir, targetSource: target.source, ...(extraContext ? { extraContextSource: extraContext.source } : {}), scout, reviews, ...(reviewFailures.length > 0 ? { reviewFailures, reviewFailureSummaryPath } : {}), synthesis, finalSummaryPath, ...cleanupRecord };
	} finally {
		clearRunActive(dir);
	}
}
