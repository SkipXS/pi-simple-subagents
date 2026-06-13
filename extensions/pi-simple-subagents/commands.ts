import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { throwChildRunError } from "./child-runner.ts";
import { WORK_PARALLEL_ROOT_KEYS, WORK_PARALLEL_TASK_KEYS, WORKER_PURPOSES } from "./constants.ts";
import { createSubagentProgress, formatSubagentProgress, withSubagentProgress } from "./progress.ts";
import type { WorkersParallelParams as WorkersParallelParamsType } from "./schemas.ts";
import { childSummary } from "./summaries.ts";
import { parseReviewTargetCommand, runOrchestrator, runReviewers, runScout, runWorker, runWorkersParallel } from "./workflows.ts";

function assertKnownKeys(record: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
	const unknown = Object.keys(record).filter((key) => !allowedKeys.includes(key));
	if (unknown.length > 0) throw new Error(`${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

export function registerRootCommands(pi: ExtensionAPI): void {
	const runOrchestrateCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const plan = args.trim();
		if (!plan) {
			ctx.ui.notify("Usage: /orchestrate @path/to/plan.md, /orchestrate <plan>, or /orchestrate <review/fix instruction>", "warning");
			return;
		}
		ctx.ui.notify("Starting orchestrator workflow...", "info");
		const progress = createSubagentProgress({ setWidget: (content) => ctx.ui.setWidget("pi-simple-subagents:orchestrate", content, { placement: "belowEditor" }) });
		try {
			const { result, runDir, cleanupSummary } = await runOrchestrator(ctx.cwd, plan, ctx.signal, (text, status) => {
				if (text) progress.text(text);
				if (status) progress.status(status);
			});
			if (result.exitCode !== 0) throwChildRunError("Orchestration failed", result);
			const subagentProgress = progress.snapshot();
			pi.sendMessage({
				customType: "pi-simple-subagents-result",
				display: true,
				content: childSummary("Orchestration finished.", [["Run dir", runDir], ["Output", result.outputPath], ["Transcript", result.transcriptPath], ["Artifact cleanup", cleanupSummary]], result.output, { subagentProgress }),
				details: withSubagentProgress({ runDir, result, cleanupSummary }, progress),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Orchestration failed: ${message.split("\n")[0]}`, "error");
			throw error;
		} finally {
			progress.clear();
		}
	};

	const runScoutCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const task = args.trim();
		if (!task) {
			ctx.ui.notify("Usage: /scout @target-file, @directory, or inline reconnaissance instructions", "warning");
			return;
		}
		ctx.ui.notify("Starting scout...", "info");
		const progress = createSubagentProgress({ setWidget: (content) => ctx.ui.setWidget("pi-simple-subagents:scout", content, { placement: "belowEditor" }) });
		try {
			const result = await runScout(ctx.cwd, { task }, ctx.signal, (text, status) => {
				if (text) progress.text(text);
				if (status) progress.status(status);
			});
			const subagentProgress = progress.snapshot();
			pi.sendMessage({
				customType: "pi-simple-subagents-scout-result",
				display: true,
				content: childSummary("Scout finished.", [["Run dir", result.runDir], ["Output", result.outputArtifactPath], ["Transcript", result.result.transcriptPath], ["Artifact cleanup", result.cleanupSummary]], result.result.output, { subagentProgress }),
				details: withSubagentProgress(result as unknown as Record<string, unknown>, progress),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Scout failed: ${message.split("\n")[0]}`, "error");
			throw error;
		} finally {
			progress.clear();
		}
	};

	const runWorkCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const task = args.trim();
		if (!task) {
			ctx.ui.notify("Usage: /work @task-file, @directory, or inline implementation/fix/validation instructions", "warning");
			return;
		}
		ctx.ui.notify("Starting worker...", "info");
		const progress = createSubagentProgress({ setWidget: (content) => ctx.ui.setWidget("pi-simple-subagents:work", content, { placement: "belowEditor" }) });
		try {
			const result = await runWorker(ctx.cwd, { task }, ctx.signal, (text, status) => {
				if (text) progress.text(text);
				if (status) progress.status(status);
			});
			const subagentProgress = progress.snapshot();
			pi.sendMessage({
				customType: "pi-simple-subagents-worker-result",
				display: true,
				content: childSummary("Worker finished.", [["Run dir", result.runDir], ["Output", result.outputArtifactPath], ["Transcript", result.result.transcriptPath], ["Artifact cleanup", result.cleanupSummary]], result.result.output, { subagentProgress }),
				details: withSubagentProgress(result as unknown as Record<string, unknown>, progress),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Worker failed: ${message.split("\n")[0]}`, "error");
			throw error;
		} finally {
			progress.clear();
		}
	};

	const runReviewCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const target = args.trim();
		if (!target) {
			ctx.ui.notify("Usage: /review [--scout|--no-scout] [--continue-on-reviewer-failure] [--context <text-or-@file>] [--reviewer <angle>]... @path-or-dir [focus/instructions]", "warning");
			return;
		}
		ctx.ui.notify("Starting review workflow...", "info");
		const progress = createSubagentProgress({ setWidget: (content) => ctx.ui.setWidget("pi-simple-subagents:review", content, { placement: "belowEditor" }) });
		try {
			const result = await runReviewers(ctx.cwd, parseReviewTargetCommand(target), ctx.signal, (text, status) => {
				if (text) progress.text(text);
				if (status) progress.status(status);
			});
			const subagentProgress = progress.snapshot();
			pi.sendMessage({
				customType: "pi-simple-subagents-review-result",
				display: true,
				content: childSummary("Review finished.", [["Run dir", result.runDir], ["Final summary", result.finalSummaryPath], ["Synthesis transcript", result.synthesis.transcriptPath], ["Artifact cleanup", result.cleanupSummary]], result.synthesis.output, { kind: "synthesis", subagentProgress }),
				details: withSubagentProgress(result as unknown as Record<string, unknown>, progress),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Review failed: ${message.split("\n")[0]}`, "error");
			throw error;
		} finally {
			progress.clear();
		}
	};

	pi.registerCommand("orchestrate", {
		description: "Run the simple orchestrator workflow for a plan or review/fix instruction",
		handler: runOrchestrateCommand,
	});

	pi.registerCommand("scout", {
		description: "Run a standalone scout subagent. Usage: @target-file, @directory, or inline reconnaissance instructions",
		handler: runScoutCommand,
	});

	pi.registerCommand("work", {
		description: "Run a standalone worker subagent. Usage: @task-file, @directory, or inline implementation/fix/validation instructions",
		handler: runWorkCommand,
	});

	pi.registerCommand("work-parallel", {
		description: "Run multiple worker subagents concurrently. Usage: JSON array of strings or {name, task, purpose, outputFile} objects",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /work-parallel [{\"name\":\"docs\",\"task\":\"...\"},{\"name\":\"tests\",\"task\":\"...\"}]", "warning");
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(input);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/work-parallel expects JSON: ${message}`, "error");
				return;
			}
			let rawTasks: unknown[] | undefined;
			try {
				if (Array.isArray(parsed)) {
					rawTasks = parsed;
				} else if (typeof parsed === "object" && parsed !== null) {
					const rawObject = parsed as Record<string, unknown>;
					assertKnownKeys(rawObject, WORK_PARALLEL_ROOT_KEYS, "/work-parallel root object");
					if (Array.isArray(rawObject.tasks)) rawTasks = rawObject.tasks;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
				return;
			}
			if (!rawTasks || rawTasks.length < 2 || rawTasks.length > 8) {
				ctx.ui.notify("/work-parallel requires 2-8 tasks", "warning");
				return;
			}
			let tasks: WorkersParallelParamsType["tasks"];
			try {
				tasks = rawTasks.map((item, index) => {
					if (typeof item === "string") {
						if (item.trim() === "") throw new Error(`Invalid task at index ${index}: task must be a non-empty string`);
						return { name: `worker-${index + 1}`, task: item };
					}
					if (typeof item !== "object" || item === null) throw new Error(`Invalid task at index ${index}: expected string or object`);
					const raw = item as { name?: unknown; task?: unknown; purpose?: unknown; outputFile?: unknown };
					assertKnownKeys(raw as Record<string, unknown>, WORK_PARALLEL_TASK_KEYS, `Invalid task at index ${index}`);
					if (typeof raw.task !== "string" || raw.task.trim() === "") throw new Error(`Invalid task at index ${index}: task must be a non-empty string`);
					if (raw.name !== undefined && typeof raw.name !== "string") throw new Error(`Invalid task at index ${index}: name must be a string`);
					if (raw.outputFile !== undefined && typeof raw.outputFile !== "string") throw new Error(`Invalid task at index ${index}: outputFile must be a string`);
					if (raw.purpose !== undefined && (typeof raw.purpose !== "string" || !(WORKER_PURPOSES as readonly string[]).includes(raw.purpose))) throw new Error(`Invalid task at index ${index}: purpose must be implementation, fix, or validation`);
					return {
						...(raw.name !== undefined ? { name: raw.name } : {}),
						task: raw.task,
						...(raw.purpose !== undefined ? { purpose: raw.purpose as WorkersParallelParamsType["tasks"][number]["purpose"] } : {}),
						...(raw.outputFile !== undefined ? { outputFile: raw.outputFile } : {}),
					};
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
				return;
			}
			ctx.ui.notify(`Starting ${tasks.length} workers in parallel...`, "info");
			const progress = createSubagentProgress({ setWidget: (content) => ctx.ui.setWidget("pi-simple-subagents:work-parallel", content, { placement: "belowEditor" }) });
			try {
				const result = await runWorkersParallel(ctx.cwd, { tasks }, ctx.signal, (text, status) => {
					if (text) progress.text(text);
					if (status) progress.status(status);
				});
				const subagentProgress = progress.snapshot();
				pi.sendMessage({
					customType: "pi-simple-subagents-parallel-workers-result",
					display: true,
					content: `Parallel workers finished.\n\nRun dir: ${result.runDir}\nWorkers: ${result.workers.length}${result.cleanupSummary ? `\nArtifact cleanup: ${result.cleanupSummary}` : ""}${subagentProgress.statuses.length > 0 ? `\n\n${formatSubagentProgress(subagentProgress)}` : ""}\n\n${result.workers.map((worker, index) => `${index + 1}. ${worker.name}: ${worker.outputArtifactPath}`).join("\n")}`,
					details: withSubagentProgress(result as unknown as Record<string, unknown>, progress),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Parallel workers failed: ${message.split("\n")[0]}`, "error");
				throw error;
			} finally {
				progress.clear();
			}
		},
	});

	pi.registerCommand("review", {
		description: "Run scout/reviewer fanout for a target and synthesize improvements. Usage: [--scout|--no-scout] [--continue-on-reviewer-failure] [--context <text-or-@file>] [--reviewer <angle>]... @path-or-dir [focus/instructions]",
		handler: runReviewCommand,
	});
}
