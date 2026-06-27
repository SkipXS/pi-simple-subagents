import * as path from "node:path";
import { clearRunActive, ensureDir, markRunActive, resolveRunBaseDir, runId, validateOutputArtifactPath, writeArtifact } from "./artifacts.ts";
import type { Model, Api } from "@earendil-works/pi-ai";
import { throwChildRunError, type ChildRunResult } from "./child-runner.ts";
import { CONFIG_EFFECTIVE_FILE, DEFAULT_SCOUT_OUTPUT_FILE, INPUT_SCOUT_TASK_FILE } from "./constants.ts";
import { formatReferenceWarnings } from "./references.ts";
import type { ScoutParams } from "./schemas.ts";
import {
	compactStatusDescription,
	forwardChildStatus,
	promptSummary,
	requireExpectedArtifact,
	requireNonEmpty,
	runConfiguredArtifactCleanup,
	workflowDeps,
	type CleanupRecord,
	type WorkflowDeps,
	type WorkflowUpdate,
} from "./workflow-common.ts";

export interface ScoutRunRecord extends CleanupRecord {
	runDir: string;
	taskSource: string;
	result: ChildRunResult;
	outputArtifactPath: string;
}

export async function runScout(cwd: string, params: ScoutParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps, parentModel?: Model<Api>): Promise<ScoutRunRecord> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	markRunActive(dir);
	try {
		const cleanupRecord = runConfiguredArtifactCleanup(baseDir, config, dir);
		const taskInput = requireNonEmpty(params.task, "scout task");
		const scoutTask = dep.readReference(cwd, taskInput, "scout task", config, { allowDirectory: true });
		const outputFile = params.outputFile?.trim() || DEFAULT_SCOUT_OUTPUT_FILE;
		const outputArtifactPath = validateOutputArtifactPath(dir, outputFile);
		const referenceWarningText = formatReferenceWarnings(scoutTask.warnings);
		writeArtifact(dir, INPUT_SCOUT_TASK_FILE, `Source: ${scoutTask.source}\nExpected output artifact: ${outputFile}${referenceWarningText}\n\n${scoutTask.text}\n`);
		writeArtifact(dir, CONFIG_EFFECTIVE_FILE, JSON.stringify(config, null, 2));
		const task = `Scout task source: ${scoutTask.source}\nExpected output artifact: ${outputFile}${referenceWarningText}\nRun directory: ${dir}\nRead input-scout-task.md, gather relevant context, inspect files directly when useful, and write the expected output artifact with write_run_artifact using path ${JSON.stringify(outputFile)}. Do not use absolute paths or the generic write tool for the handoff artifact. Do not implement changes. Do not intentionally modify project/source files; if a command may write generated output, prefer read-only alternatives or explain the risk before running it. Produce a compact handoff for the parent agent.`;
		const result = await dep.spawnPiRole({ cwd, role: "scout", task, runDir: dir, config, signal, onUpdate: (text) => onUpdate?.(`scout: ${text}`), onStatus: forwardChildStatus(onUpdate), statusKey: "subagent:scout", statusLabel: "scout", statusDescription: promptSummary(scoutTask.text, `scout ${scoutTask.source}`), parentModel });
		if (result.exitCode !== 0) throwChildRunError("scout failed", result);
		requireExpectedArtifact(dep, dir, outputFile, result, "scout");
		return { runDir: dir, taskSource: scoutTask.source, result: { ...result, outputPath: outputArtifactPath }, outputArtifactPath, ...cleanupRecord };
	} finally {
		clearRunActive(dir);
	}
}
