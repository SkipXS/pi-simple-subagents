import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyArtifactFile, resolveArtifactPath, writeArtifact } from "./artifacts.ts";
import { childEnvCounts, childResultText, throwChildRunError, spawnPiRole } from "./child-runner.ts";
import { loadConfig } from "./config.ts";
import {
	ROLE_ENV,
	REVIEW_RUNS_ENV,
	RUN_DIR_ENV,
	WORKER_RUNS_ENV,
	parseRoleEnv,
} from "./roles.ts";
import {
	ArtifactParams,
	CompactSessionParams,
	MarkReviewCleanParams,
	OrchestrateParams,
	ReviewTargetParams,
	RoleRunParams,
	type ArtifactParams as ArtifactParamsType,
	type CompactSessionParams as CompactSessionParamsType,
	type MarkReviewCleanParams as MarkReviewCleanParamsType,
	type OrchestrateParams as OrchestrateParamsType,
	type ReviewTargetParams as ReviewTargetParamsType,
	type RoleRunParams as RoleRunParamsType,
} from "./schemas.ts";
import { readOrchestrationState, writeOrchestrationState } from "./state.ts";
import { parseReviewTargetCommand, runOrchestration, runReviewTarget } from "./workflows.ts";

export default function orchestratorAgentsExtension(pi: ExtensionAPI) {
	const role = parseRoleEnv(process.env[ROLE_ENV]);
	const runDir = process.env[RUN_DIR_ENV];
	const persistedState = runDir ? readOrchestrationState(runDir) : undefined;
	let workerRuns = persistedState?.workerRuns ?? (Number(process.env[WORKER_RUNS_ENV] ?? "0") || 0);
	let reviewRuns = persistedState?.reviewRuns ?? (Number(process.env[REVIEW_RUNS_ENV] ?? "0") || 0);
	let reviewRunsSinceLatestWorker = persistedState?.reviewRunsSinceLatestWorker ?? 0;
	let latestWorkerRunReviewedClean = persistedState?.latestWorkerRunReviewedClean ?? false;
	const persistState = () => {
		if (!runDir) return undefined;
		return writeOrchestrationState(runDir, { workerRuns, reviewRuns, reviewRunsSinceLatestWorker, latestWorkerRunReviewedClean });
	};

	if (!role) {
		pi.registerTool({
			name: "orchestrate_plan",
			label: "Orchestrate Plan",
			description: "Start the simple orchestrator workflow for a plan or @plan-file. The orchestrator coordinates scout, worker, reviewer, loops fixes, and runs validation only after implementation/review.",
			promptSnippet: "Run the configured orchestrator workflow for a plan or @plan-file",
			promptGuidelines: ["Use orchestrate_plan when the user asks to implement a plan through the orchestrator workflow."],
			parameters: OrchestrateParams,
			async execute(_id, params: OrchestrateParamsType, signal, onUpdate, ctx) {
				const { result, runDir, planSource } = await runOrchestration(ctx.cwd, params.plan, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }));
				if (result.exitCode !== 0) throwChildRunError("Orchestration failed", result);
				return {
					content: [{ type: "text", text: `Orchestration finished.\nRun dir: ${runDir}\nPlan source: ${planSource}\nOutput: ${result.outputPath}\nTranscript: ${result.transcriptPath}\n\n${result.output}` }],
					details: { runDir, planSource, result },
				};
			},
		});

		pi.registerTool({
			name: "review_target",
			label: "Review Target",
			description: "Run a scout plus fresh reviewer fanout for an existing target, then synthesize improvements. YOLO mode does not enforce source-write restrictions.",
			promptSnippet: "Review an existing file, directory, diff, or extension with reviewer fanout",
			promptGuidelines: ["Use review_target when the user asks to inspect, audit, or suggest improvements without implementing changes."],
			parameters: ReviewTargetParams,
			async execute(_id, params: ReviewTargetParamsType, signal, onUpdate, ctx) {
				const result = await runReviewTarget(ctx.cwd, params, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }));
				return {
					content: [{ type: "text", text: `Review finished.\nRun dir: ${result.runDir}\nTarget source: ${result.targetSource}\nFinal summary: ${result.finalSummaryPath}\n\n${result.synthesis.output}` }],
					details: result,
				};
			},
		});
	}

	if (role === "orchestrator" && runDir) {
		pi.registerTool({
			name: "run_role_agent",
			label: "Run Role Agent",
			description: "Run scout, worker, or reviewer for one concrete handoff task in the current orchestration run. YOLO by design: no file, time, validation, or snapshot guardrails are imposed.",
			promptSnippet: "Delegate a concrete task to scout, worker, or reviewer within the current orchestration run",
			promptGuidelines: [
				"Use run_role_agent from orchestrator after deciding the next workflow step.",
				"Use purpose=validation for final tests or end-user checks when useful; Pi YOLO policy applies.",
			],
			parameters: RoleRunParams,
			async execute(_id, params: RoleRunParamsType, signal, onUpdate, ctx) {
				const config = loadConfig(ctx.cwd);
				const label = `${params.role}${params.round ? `-round-${params.round}` : ""}`;
				const outputArtifactPath = params.outputFile ? resolveArtifactPath(runDir, params.outputFile) : undefined;
				const task = `${params.task}

Run directory: ${runDir}
Expected output artifact: ${params.outputFile ?? `${label}.md`}
Purpose: ${params.purpose}`;
				writeArtifact(runDir, `delegations/${label}-${Date.now()}.md`, task);
				const result = await spawnPiRole({
					cwd: ctx.cwd,
					role: params.role,
					task,
					runDir,
					config,
					signal,
					envExtra: childEnvCounts(workerRuns, reviewRuns),
					onUpdate: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
				});
				const succeeded = result.exitCode === 0;
				if (result.exitCode !== 0) {
					persistState();
					throw new Error(childResultText(`${params.role} failed`, result));
				}
				if (params.outputFile && outputArtifactPath && !fs.existsSync(outputArtifactPath)) {
					copyArtifactFile(runDir, result.outputPath, outputArtifactPath);
				}

				if (succeeded && params.role === "worker" && (params.purpose === "implementation" || params.purpose === "fix" || params.purpose === "validation")) {
					workerRuns++;
					reviewRunsSinceLatestWorker = 0;
					latestWorkerRunReviewedClean = false;
				}
				if (succeeded && params.role === "reviewer" && params.purpose === "review") {
					reviewRuns++;
					reviewRunsSinceLatestWorker++;
				}
				persistState();
				return {
					content: [{ type: "text", text: childResultText(`${params.role} finished`, { ...result, outputPath: outputArtifactPath ?? result.outputPath }) }],
					details: { ...result, purpose: params.purpose, round: params.round, latestWorkerRunReviewedClean, workerRuns, reviewRuns, reviewRunsSinceLatestWorker },
				};

			},
		});

		pi.registerTool({
			name: "mark_review_clean",
			label: "Mark Review Clean",
			description: "Record that the latest changes have a clean synthesized review. Informational only; it does not gate validation in YOLO mode.",
			promptSnippet: "Record the latest changes as cleanly reviewed after synthesizing reviewer output",
			promptGuidelines: ["Use mark_review_clean after reviewer artifacts show no blockers and no fixes worth doing now."],
			executionMode: "sequential",
			parameters: MarkReviewCleanParams,
			async execute(_id, params: MarkReviewCleanParamsType) {
				latestWorkerRunReviewedClean = true;
				const pathName = writeArtifact(runDir, `review-clean-${params.round ?? reviewRuns}.md`, `# Clean Review Mark\n\nRound: ${params.round ?? reviewRuns}\n\n${params.summary}\n`);
				const statePath = persistState();
				return { content: [{ type: "text", text: `Marked latest worker changes as cleanly reviewed. Artifact: ${pathName}` }], details: { latestWorkerRunReviewedClean, path: pathName, statePath, workerRuns, reviewRuns, reviewRunsSinceLatestWorker } };
			},
		});
	}

	if (runDir) {
		pi.registerTool({
			name: "compact_session",
			label: "Compact Session",
			description: "Request compaction for the current child session to prevent context rot while preserving orchestration state.",
			promptSnippet: "Compact the current child session with orchestration-aware summary instructions",
			promptGuidelines: ["Use compact_session when a worker or orchestrator session is getting long; artifacts remain the source of truth after compaction."],
			parameters: CompactSessionParams,
			async execute(_id, params: CompactSessionParamsType, _signal, _onUpdate, ctx) {
				const defaultInstructions = [
					"Preserve the original plan and current goal.",
					"Preserve changed files, implementation decisions, and rationale.",
					"Preserve open reviewer findings, accepted fixes, deferred items, and validation state.",
					"Preserve artifact paths under the run directory and any decisions needing user approval.",
				].join(" ");
				ctx.compact({
					customInstructions: params.instructions?.trim() || defaultInstructions,
					onComplete: () => {
						try {
							writeArtifact(runDir, `compaction-${Date.now()}.md`, `Compaction completed for role ${role ?? "unknown"}.\n`);
						} catch { /* ignore artifact failures from callback */ }
					},
					onError: (error) => {
						try {
							const message = error instanceof Error ? error.message : String(error);
							writeArtifact(runDir, `compaction-error-${Date.now()}.md`, `Compaction failed for role ${role ?? "unknown"}: ${message}\n`);
						} catch { /* ignore artifact failures from callback */ }
					},
				});
				return { content: [{ type: "text", text: "Compaction requested for the current session. Continue using run artifacts as source of truth." }], details: { requested: true, runDir } };
			},
		});

		pi.registerTool({
			name: "write_run_artifact",
			label: "Write Run Artifact",
			description: "Write a handoff artifact relative to the current orchestration run directory.",
			promptSnippet: "Write a handoff artifact inside the current orchestration run directory",
			promptGuidelines: ["Use write_run_artifact for scout, worker, reviewer, and orchestrator handoff files instead of writing project files."],
			parameters: ArtifactParams,
			async execute(_id, params: ArtifactParamsType) {
				const target = writeArtifact(runDir, params.path, params.content);
				return { content: [{ type: "text", text: `Wrote artifact: ${target}` }], details: { path: target } };
			},
		});
	}

	if (!role) {
		pi.registerCommand("orchestrate", {
			description: "Run the simple orchestrator workflow for a plan or @plan-file",
			handler: async (args, ctx) => {
				const plan = args.trim();
				if (!plan) {
					ctx.ui.notify("Usage: /orchestrate @path/to/plan.md or /orchestrate <plan>", "warning");
					return;
				}
				ctx.ui.notify("Starting orchestrator workflow...", "info");
				try {
					const { result, runDir } = await runOrchestration(ctx.cwd, plan, ctx.signal, (text) => ctx.ui.setStatus("orchestrator", text));
					if (result.exitCode !== 0) throwChildRunError("Orchestration failed", result);
					pi.sendMessage({
						customType: "pi-simple-subagents-result",
						display: true,
						content: `Orchestration finished.\n\nRun dir: ${runDir}\nOutput: ${result.outputPath}\nTranscript: ${result.transcriptPath}\n\n${result.output}`,
						details: { runDir, result },
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Orchestration failed: ${message.split("\n")[0]}`, "error");
					throw error;
				} finally {
					ctx.ui.setStatus("orchestrator", undefined);
				}
			},
		});

		pi.registerCommand("review-target", {
			description: "Run scout/reviewer fanout for a target and synthesize improvements",
			handler: async (args, ctx) => {
				const target = args.trim();
				if (!target) {
					ctx.ui.notify("Usage: /review-target @path-or-dir [focus/instructions]", "warning");
					return;
				}
				ctx.ui.notify("Starting review workflow...", "info");
				try {
					const result = await runReviewTarget(ctx.cwd, parseReviewTargetCommand(target), ctx.signal, (text) => ctx.ui.setStatus("review-target", text));
					pi.sendMessage({
						customType: "pi-simple-subagents-review-result",
						display: true,
						content: `Review finished.\n\nRun dir: ${result.runDir}\nFinal summary: ${result.finalSummaryPath}\n\n${result.synthesis.output}`,
						details: result,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Review failed: ${message.split("\n")[0]}`, "error");
					throw error;
				} finally {
					ctx.ui.setStatus("review-target", undefined);
				}
			},
		});
	}
}
