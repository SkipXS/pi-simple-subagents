import * as fs from "node:fs";
import * as path from "node:path";
import { copyArtifactFile, ensureDir, resolveArtifactPath, resolveRunBaseDir, runId, writeArtifact } from "./artifacts.ts";
import { childResultText, spawnPiRole, throwChildRunError, type ChildRunResult } from "./child-runner.ts";
import { loadConfig } from "./config.ts";
import { reviewTargetSystemPrompt } from "./prompts.ts";
import { readPlanReference, readReference } from "./references.ts";
import { createProjectSnapshot, restoreProjectSnapshotArchive, writeProjectSnapshotArchive, type ProjectSnapshot } from "./snapshots.ts";
import { DEFAULT_REVIEW_ANGLES, MAX_REVIEW_ANGLES } from "./roles.ts";
import type { ReviewTargetParams } from "./schemas.ts";

function formatRunTask(planText: string, planSource: string, runDir: string): string {
	return `Run directory: ${runDir}\nPlan source: ${planSource}\n\nPlan / instruction:\n${planText}\n\nStart by writing orchestration.md. Then follow the orchestrator workflow. If the plan is unclear, stop and ask the user for clarification instead of guessing.`;
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

function authorizedArchiveDir(runDir: string): string {
	return resolveArtifactPath(runDir, "source-snapshot-authorized.archive");
}

function writeAuthorizedSourceSnapshot(cwd: string, runDir: string): ProjectSnapshot {
	const snapshot = writeProjectSnapshotArchive(cwd, authorizedArchiveDir(runDir), [runDir]);
	writeArtifact(runDir, "source-snapshot-authorized.json", JSON.stringify(snapshot, null, 2));
	return snapshot;
}

function readAuthorizedSourceSnapshot(runDir: string): ProjectSnapshot | undefined {
	const snapshotPath = resolveArtifactPath(runDir, "source-snapshot-authorized.json");
	if (!fs.existsSync(snapshotPath)) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Partial<ProjectSnapshot>;
		if ((parsed.kind === "git" || parsed.kind === "filesystem") && typeof parsed.hash === "string" && typeof parsed.fileCount === "number") {
			return { kind: parsed.kind, hash: parsed.hash, fileCount: parsed.fileCount };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export async function runOrchestration(cwd: string, rawPlan: string, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<{ result: ChildRunResult; runDir: string; planSource: string }> {
	const config = loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	const initialSnapshot = writeAuthorizedSourceSnapshot(cwd, dir);
	const { planText, planSource } = readPlanReference(cwd, rawPlan, config);
	writeArtifact(dir, "input-plan.md", `Source: ${planSource}\n\n${planText}\n`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));
	const task = formatRunTask(planText, planSource, dir);
	const result = await spawnPiRole({ cwd, role: "orchestrator", task, runDir: dir, config, signal, onUpdate });
	const authorizedSnapshot = readAuthorizedSourceSnapshot(dir) ?? initialSnapshot;
	const finalSnapshot = createProjectSnapshot(cwd, [dir]);
	if (authorizedSnapshot.hash !== finalSnapshot.hash) {
		let restoreResult: ReturnType<typeof restoreProjectSnapshotArchive> | undefined;
		let restoreError: string | undefined;
		try {
			restoreResult = restoreProjectSnapshotArchive(cwd, authorizedArchiveDir(dir), [dir]);
		} catch (error) {
			restoreError = error instanceof Error ? error.message : String(error);
		}
		const artifact = writeArtifact(dir, `orchestrator-source-write-policy-violation-${Date.now()}.md`, `# Orchestrator Source Write Policy Violation\n\nThe orchestrator is not allowed to persist project/source changes directly. Only successful worker implementation/fix runs and validation runs that mutate source may authorize project/source changes.\n\nThe extension attempted to restore the last authorized source snapshot.\n\nRestored: ${restoreResult?.restored ?? false}\n${restoreResult?.error ? `Restore error: ${restoreResult.error}\n` : ""}${restoreError ? `Restore error: ${restoreError}\n` : ""}\nAuthorized snapshot: ${JSON.stringify(authorizedSnapshot)}\n\nFinal snapshot before restore: ${JSON.stringify(finalSnapshot)}\n\nSnapshot after restore: ${JSON.stringify(restoreResult?.restoredSnapshot)}\n`);
		const output = `[Policy] Orchestrator left project/source changes that were not authorized by a worker run. Restore attempted: ${restoreResult?.restored ?? false}. Artifact: ${artifact}\n\n${result.output}`;
		const outputPath = writeArtifact(dir, `outputs/orchestrator-source-write-policy-${Date.now()}.md`, output);
		return { result: { ...result, exitCode: 1, output, outputPath }, runDir: dir, planSource };
	}
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

	const reviewRecords: Array<{ result: ChildRunResult; expectedPath: string; angle: string }> = [];
	for (const [index, angle] of reviewers.entries()) {
		onUpdate?.(`review-target: reviewer ${index + 1}/${reviewers.length} running`);
		const safeName = angle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `review-${index + 1}`;
		const expectedFile = `review-${index + 1}-${safeName}.md`;
		const expectedPath = resolveArtifactPath(dir, expectedFile);
		const result = await spawnPiRole({
			cwd,
			role: "reviewer",
			task: `Review target source: ${target.source}\nFocus: ${focus}\nAssigned review angle: ${angle}\nRun directory: ${dir}\nRead input-target.md${scout ? " and scout-review-context.md" : ""}, inspect the target directly, and write ${expectedFile}. Do not modify project/source files.`,
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
