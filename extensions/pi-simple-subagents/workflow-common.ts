import { cleanupRunArtifacts, formatArtifactCleanupResult, requireExpectedOutputArtifact, resolveArtifactPath, type ArtifactCleanupResult } from "./artifacts.ts";
import { spawnPiRole, type ChildRunResult, type ChildStatusUpdate } from "./child-runner.ts";
import { loadConfig, type Config } from "./config.ts";
import { formatReferenceWarnings, readPlanReference, readReference } from "./references.ts";

export type WorkflowUpdate = (text: string, status?: ChildStatusUpdate) => void;

export type WorkerRunOptions = {
	statusKey?: string;
	statusLabel?: string;
};

export interface WorkflowDeps {
	loadConfig?: typeof loadConfig;
	readPlanReference?: typeof readPlanReference;
	readReference?: typeof readReference;
	spawnPiRole?: typeof spawnPiRole;
}

const defaultWorkflowDeps: Required<WorkflowDeps> = {
	loadConfig,
	readPlanReference,
	readReference,
	spawnPiRole,
};

export function workflowDeps(overrides?: WorkflowDeps): Required<WorkflowDeps> {
	return { ...defaultWorkflowDeps, ...(overrides ?? {}) };
}

export function formatRunTask(planText: string, planSource: string, runDir: string, warnings: readonly string[] = []): string {
	return `Run directory: ${runDir}\nInstruction source: ${planSource}${formatReferenceWarnings(warnings)}\n\nPlan / review-fix instruction:\n${planText}\n\nStart by writing orchestration.md. Then follow the orchestrator workflow. If the instruction is unclear, stop and ask the user for clarification instead of guessing.`;
}

export function safePathLabel(value: string | undefined, fallback: string): string {
	return (value ?? fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || fallback;
}

export function compactStatusDescription(value: string, maxLength = 72): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function promptSummary(text: string, fallback: string, maxLength = 72): string {
	const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? fallback;
	return compactStatusDescription(firstLine, maxLength);
}

export function forwardChildStatus(onUpdate: WorkflowUpdate | undefined): (status: ChildStatusUpdate) => void {
	return (status) => onUpdate?.("", status);
}

export function requireNonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must be a non-empty string`);
	return trimmed;
}

export function assertWorkerTaskWithinBudget(taskText: string, source: string, config: Config, label = "worker task"): void {
	const limit = config.orchestration.maxWorkerTaskBytes;
	if (limit === 0) return;
	const bytes = Buffer.byteLength(taskText, "utf8");
	if (bytes <= limit) return;
	throw new Error(`${label} is ${bytes} bytes, exceeding orchestration.maxWorkerTaskBytes=${limit}. This usually means an entire milestone, broad plan section, or multiple deliverables were delegated to one worker. Split it into a smaller work package (one concrete deliverable, 1-3 likely files, 3-5 acceptance criteria, explicit non-goals, and one validation check), or set orchestration.maxWorkerTaskBytes=0/increase it intentionally. Task source: ${source}`);
}

export function requireExpectedArtifact(_dep: Required<WorkflowDeps>, runDir: string, outputFile: string, result: ChildRunResult, label: string): string {
	let target = outputFile;
	try {
		target = resolveArtifactPath(runDir, outputFile);
		return requireExpectedOutputArtifact(runDir, outputFile);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${label} did not write the expected output artifact.\nExpected output artifact: ${outputFile}\nExpected path: ${target}\nRun dir: ${runDir}\nArtifact validation error: ${message}\nChild output log: ${result.outputPath}\nTranscript: ${result.transcriptPath}\nUse write_run_artifact with path ${JSON.stringify(outputFile)}; do not write artifacts via absolute paths or the generic write tool.`);
	}
}

export interface CleanupRecord {
	cleanup?: ArtifactCleanupResult;
	cleanupSummary?: string;
}

export function runConfiguredArtifactCleanup(baseDir: string, config: Config, activeRunDir: string): CleanupRecord {
	const cleanup = cleanupRunArtifacts(baseDir, config, activeRunDir);
	return cleanup ? { cleanup, cleanupSummary: formatArtifactCleanupResult(cleanup) } : {};
}
