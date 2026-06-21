import * as fs from "node:fs";
import { requireExpectedOutputArtifact, resolveArtifactPath, validateOutputArtifactPath } from "./artifacts.ts";
import { trimStatusField } from "./progress.ts";

export function requireNonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must be a non-empty string`);
	return trimmed;
}

export function safeIdLabel(value: string, fallback: string): string {
	return (value || fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || fallback;
}

export function roleTaskStatusDescription(purpose: string, task: string): string {
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

function reviewAngleFromOutputFile(outputFile: string | undefined): string | undefined {
	const fileName = outputFile?.trim().split(/[\\/]/).pop()?.replace(/\.md$/i, "") ?? "";
	const match = /^final-review-(.+)$/.exec(fileName);
	return match?.[1]?.replace(/[-_]+/g, " ").trim() || undefined;
}

function isFinalReview(role: string, purpose: string, outputFile: string | undefined, task: string | undefined): boolean {
	if (role !== "reviewer" || purpose !== "review") return false;
	if (/^(?:.*[\\/])?final-review(?:[-_.].*)?$/i.test(outputFile?.trim().replace(/\.md$/i, "") ?? "")) return true;
	return /\bfinal\s+(?:whole-change\s+)?(?:multi-angle\s+)?review\b/i.test(task ?? "") || /\bwhole-change\s+review\b/i.test(task ?? "");
}

function finalReviewLabels(round: number | undefined, fallbackRound: number, outputFile: string | undefined): { artifactLabel: string; statusLabel: string } {
	const effectiveRound = round ?? fallbackRound;
	const angle = reviewAngleFromOutputFile(outputFile);
	return {
		artifactLabel: angle ? `final-review-${safeIdLabel(angle, "review")}` : `final-review-round-${effectiveRound}`,
		statusLabel: `${angle ? `final review ${angle}` : "final review"}${round ? ` r${round}` : ""}`,
	};
}

function workerPurposeLabel(purpose: string): string {
	return purpose === "implementation" ? "impl" : purpose;
}

function workerStatusLabel(workerId: string, purpose: string, round: number | undefined): string {
	return `${workerId} ${workerPurposeLabel(purpose)}${round ? ` r${round}` : ""}`;
}

export function roleStatusKey(statusLabel: string, sequence: number): string {
	return `subagent:${safeIdLabel(statusLabel, "role")}-${sequence}`;
}

export function roleRunLabels(role: string, purpose: string, round: number | undefined, workerId: string | undefined, latestWorkerId: string | undefined, fallbackReviewRound: number, outputFile?: string, task?: string): { artifactLabel: string; statusLabel: string } {
	if (workerId) {
		const label = `${workerId}${round ? `-round-${round}` : ""}`;
		return { artifactLabel: label, statusLabel: workerStatusLabel(workerId, purpose, round) };
	}
	if (isFinalReview(role, purpose, outputFile, task)) return finalReviewLabels(round, fallbackReviewRound, outputFile);
	if (role === "verifier" || role === "reviewer") {
		const scoped = workerScopedEphemeralLabels(role, latestWorkerId, round, fallbackReviewRound);
		if (scoped.artifactLabel && scoped.statusLabel) return { artifactLabel: scoped.artifactLabel, statusLabel: scoped.statusLabel };
	}
	return {
		artifactLabel: `${role}${round ? `-round-${round}` : ""}`,
		statusLabel: `${role}${round ? ` r${round}` : ""}`,
	};
}

export function requireExpectedRunArtifact(runDir: string, outputFile: string, result: { outputPath: string; transcriptPath: string }, label: string): string {
	let target = outputFile;
	try {
		target = resolveArtifactPath(runDir, outputFile);
		return requireExpectedOutputArtifact(runDir, outputFile);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${label} did not write the expected output artifact.\nExpected output artifact: ${outputFile}\nExpected path: ${target}\nRun dir: ${runDir}\nArtifact validation error: ${message}\nChild output log: ${result.outputPath}\nTranscript: ${result.transcriptPath}\nUse write_run_artifact with path ${JSON.stringify(outputFile)}; do not write artifacts via absolute paths or the generic write tool.`);
	}
}

export function defaultRoleOutputFile(runDir: string, label: string, nextSequence: () => number): string {
	const firstCandidate = `${label}.md`;
	if (!fs.existsSync(validateOutputArtifactPath(runDir, firstCandidate))) return firstCandidate;
	for (;;) {
		const candidate = `${label}-${nextSequence()}.md`;
		if (!fs.existsSync(validateOutputArtifactPath(runDir, candidate))) return candidate;
	}
}
