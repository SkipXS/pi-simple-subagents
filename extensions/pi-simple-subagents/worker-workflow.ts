import * as path from "node:path";
import { clearRunActive, ensureDir, markRunActive, resolveRunBaseDir, runId, validateOutputArtifactPath, writeArtifact } from "./artifacts.ts";
import type { Model, Api } from "@earendil-works/pi-ai";
import { throwChildRunError, type ChildRunResult } from "./child-runner.ts";
import { CONFIG_EFFECTIVE_FILE, DEFAULT_WORKER_OUTPUT_FILE, INPUT_WORKER_TASK_FILE, PARALLEL_WORKERS_FILE, PARALLEL_WORKERS_SUMMARY_FILE } from "./constants.ts";
import { fanoutConcurrency, runFanout } from "./fanout.ts";
import type { Config } from "./config.ts";
import { formatReferenceWarnings } from "./references.ts";
import type { WorkerParams, WorkersParallelParams, WorkersParallelTaskParams } from "./schemas.ts";
import {
	assertWorkerTaskWithinBudget,
	compactStatusDescription,
	forwardChildStatus,
	promptSummary,
	requireExpectedArtifact,
	requireNonEmpty,
	runConfiguredArtifactCleanup,
	safePathLabel,
	workflowDeps,
	type CleanupRecord,
	type WorkflowDeps,
	type WorkflowUpdate,
	type WorkerRunOptions,
} from "./workflow-common.ts";

type WorkerPurpose = NonNullable<WorkerParams["purpose"]>;

export interface WorkerRunRecord extends CleanupRecord {
	name: string;
	runDir: string;
	taskSource: string;
	result: ChildRunResult;
	outputArtifactPath: string;
	purpose: WorkerPurpose;
}

interface PreparedWorkerTask {
	name: string;
	purpose: WorkerPurpose;
	text: string;
	source: string;
	warnings: readonly string[];
	outputFile: string;
	outputArtifactPath: string;
}

function prepareWorkerTask(cwd: string, dir: string, params: WorkerParams | WorkersParallelTaskParams, config: Config, dep: Required<WorkflowDeps>, progressLabel = "worker", taskLabel = "worker task"): PreparedWorkerTask {
	const taskInput = requireNonEmpty(params.task, taskLabel);
	const workerTask = dep.readReference(cwd, taskInput, taskLabel, config, { allowDirectory: true });
	assertWorkerTaskWithinBudget(workerTask.text, workerTask.source, config, `${progressLabel} task`);
	const purpose: WorkerPurpose = params.purpose ?? "implementation";
	const outputFile = params.outputFile?.trim() || DEFAULT_WORKER_OUTPUT_FILE;
	const outputArtifactPath = validateOutputArtifactPath(dir, outputFile);
	const name = "name" in params && params.name?.trim() ? params.name.trim() : progressLabel;
	return { name, purpose, text: workerTask.text, source: workerTask.source, warnings: workerTask.warnings, outputFile, outputArtifactPath };
}

async function runWorkerInDir(cwd: string, dir: string, params: WorkerParams | WorkersParallelTaskParams, signal: AbortSignal | undefined, onUpdate: WorkflowUpdate | undefined, progressLabel = "worker", deps?: WorkflowDeps, prepared?: PreparedWorkerTask, options: WorkerRunOptions = {}, parentModel?: Model<Api>): Promise<WorkerRunRecord> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	ensureDir(dir);
	const workerTask = prepared ?? prepareWorkerTask(cwd, dir, params, config, dep, progressLabel);
	const referenceWarningText = formatReferenceWarnings(workerTask.warnings);
	writeArtifact(dir, INPUT_WORKER_TASK_FILE, `Source: ${workerTask.source}\nName: ${workerTask.name}\nPurpose: ${workerTask.purpose}\nExpected output artifact: ${workerTask.outputFile}${referenceWarningText}\n\n${workerTask.text}\n`);
	writeArtifact(dir, CONFIG_EFFECTIVE_FILE, JSON.stringify(config, null, 2));
	const task = `Worker task source: ${workerTask.source}\nName: ${workerTask.name}\nPurpose: ${workerTask.purpose}\nExpected output artifact: ${workerTask.outputFile}${referenceWarningText}\nRun directory: ${dir}\nRead input-worker-task.md, perform the requested work, run useful checks, and write the expected output artifact with write_run_artifact using path ${JSON.stringify(workerTask.outputFile)}. Do not use absolute paths or the generic write tool for the handoff artifact. If running as part of a parallel worker batch, stay within the assigned task and avoid editing files likely owned by sibling workers. If a product, architecture, or scope decision is missing, stop and report it instead of guessing.`;
	const statusLabel = options.statusLabel?.trim() || progressLabel;
	const statusKey = options.statusKey?.trim() || `subagent:${safePathLabel(progressLabel, "worker")}`;
	const result = await dep.spawnPiRole({ cwd, role: "worker", task, runDir: dir, config, signal, onUpdate: (text) => onUpdate?.(`${statusLabel}: ${text}`), onStatus: forwardChildStatus(onUpdate), statusKey, statusLabel, statusDescription: compactStatusDescription(`${workerTask.purpose}: ${promptSummary(workerTask.text, workerTask.source, 56)}`), parentModel });
	if (result.exitCode === 0) requireExpectedArtifact(dep, dir, workerTask.outputFile, result, `worker ${workerTask.name}`);
	return { name: workerTask.name, runDir: dir, taskSource: workerTask.source, result: { ...result, outputPath: result.exitCode === 0 ? workerTask.outputArtifactPath : result.outputPath }, outputArtifactPath: workerTask.outputArtifactPath, purpose: workerTask.purpose };
}

export async function runWorker(cwd: string, params: WorkerParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps, options: WorkerRunOptions = {}, parentModel?: Model<Api>): Promise<WorkerRunRecord> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	markRunActive(dir);
	try {
		const cleanupRecord = runConfiguredArtifactCleanup(baseDir, config, dir);
		const record = await runWorkerInDir(cwd, dir, params, signal, onUpdate, "worker", dep, undefined, options, parentModel);
		if (record.result.exitCode !== 0) throwChildRunError("worker failed", record.result);
		return { ...record, ...cleanupRecord };
	} finally {
		clearRunActive(dir);
	}
}

export async function runWorkersParallel(cwd: string, params: WorkersParallelParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps, parentModel?: Model<Api>): Promise<{ runDir: string; workers: WorkerRunRecord[]; failed: WorkerRunRecord[] } & CleanupRecord> {
	if (params.tasks.length < 2 || params.tasks.length > 8) throw new Error("run_workers_parallel requires 2-8 tasks");
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());

	ensureDir(dir);
	markRunActive(dir);
	try {
		// Resolve references/output paths before spawning any children so setup errors do not leave siblings running.
		// Prepared task content is reused at launch time so @ references are read exactly once per task.
		const preparedTasks = params.tasks.map((task, index) => {
			const label = safePathLabel(task.name, `worker-${index + 1}`);
			const workerDir = path.join(dir, `${String(index + 1).padStart(2, "0")}-${label}`);
			return {
				params: task,
				workerDir,
				progress: `worker ${index + 1}/${params.tasks.length}${task.name ? ` ${task.name}` : ""}`,
				prepared: prepareWorkerTask(cwd, workerDir, task, config, dep, `worker ${index + 1}`, `worker ${index + 1} task`),
			};
		});

		const cleanupRecord = runConfiguredArtifactCleanup(baseDir, config, dir);
		writeArtifact(dir, PARALLEL_WORKERS_FILE, `# Parallel Workers\n\n${params.tasks.map((task, index) => `## Worker ${index + 1}: ${task.name?.trim() || `worker-${index + 1}`}\n\nPurpose: ${task.purpose ?? "implementation"}\n\n${task.task}`).join("\n\n")}\n`);
		writeArtifact(dir, CONFIG_EFFECTIVE_FILE, JSON.stringify(config, null, 2));
		const concurrency = fanoutConcurrency(config, params.tasks.length);
		onUpdate?.(`parallel-workers: starting ${params.tasks.length} workers (max concurrency ${concurrency})`);
		const settled = await runFanout({
			count: preparedTasks.length,
			concurrency,
			signal,
			abortOnError: true,
			run: async (index, childSignal) => {
				const task = preparedTasks[index];
				return await runWorkerInDir(cwd, task.workerDir, task.params, childSignal, onUpdate, task.progress, dep, task.prepared, undefined, parentModel);
			},
		});
		const workers = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
		const rejected = settled.flatMap((entry, index) => entry.status === "rejected" ? [{ index, reason: entry.reason }] : []);
		const failed = workers.filter((worker) => worker.result.exitCode !== 0);
		const summaryPath = writeArtifact(dir, PARALLEL_WORKERS_SUMMARY_FILE, `# Parallel Workers Summary\n\n${workers.map((worker, index) => `## Worker ${index + 1}: ${worker.name}\n\n- Exit code: ${worker.result.exitCode}\n- Run dir: ${worker.runDir}\n- Output: ${worker.outputArtifactPath}\n- Transcript: ${worker.result.transcriptPath}`).join("\n\n")}${rejected.length > 0 ? `\n\n## Setup/spawn errors\n\n${rejected.map((entry) => `- Worker ${entry.index + 1}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`).join("\n")}` : ""}\n`);
		if (rejected.length > 0) {
			throw new Error(`Parallel workers aborted after error(s): ${rejected.map((entry) => `worker ${entry.index + 1}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`).join("; ")}\nRun dir: ${dir}\nSummary: ${summaryPath}`);
		}
		if (failed.length > 0) {
			throw new Error(`Parallel workers failed: ${failed.map((worker) => `${worker.name} exit ${worker.result.exitCode}`).join(", ")}\nRun dir: ${dir}\nSummary: ${summaryPath}`);
		}
		return { runDir: dir, workers, failed, ...cleanupRecord };
	} finally {
		clearRunActive(dir);
	}
}
