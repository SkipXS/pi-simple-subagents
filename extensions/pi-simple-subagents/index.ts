import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyArtifactFile, resolveArtifactPath, writeArtifact } from "./artifacts.ts";
import { childEnvCounts, childResultText, throwChildRunError, spawnPiRole } from "./child-runner.ts";
import { loadConfig } from "./config.ts";
import { blocksNonWorkerProjectMutation } from "./guards.ts";
import {
	ROLE_ENV,
	REVIEW_RUNS_ENV,
	RUN_DIR_ENV,
	WORKER_RUNS_ENV,
	parseRoleEnv,
	validateRolePurpose,
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
import { createProjectSnapshot, writeProjectSnapshotArchive, type ProjectSnapshot } from "./snapshots.ts";
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
	let workerActive = false;
	const persistState = () => {
		if (!runDir) return undefined;
		return writeOrchestrationState(runDir, { workerRuns, reviewRuns, reviewRunsSinceLatestWorker, latestWorkerRunReviewedClean });
	};
	const persistAuthorizedSourceSnapshot = (cwd: string) => {
		if (!runDir) return undefined;
		const snapshot = writeProjectSnapshotArchive(cwd, resolveArtifactPath(runDir, "source-snapshot-authorized.archive"), [runDir]);
		return writeArtifact(runDir, "source-snapshot-authorized.json", JSON.stringify(snapshot, null, 2));
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
			description: "Run a read-only scout plus fresh reviewer fanout for an existing target, then synthesize improvements. Does not run worker or modify project/source files.",
			promptSnippet: "Review an existing file, directory, diff, or extension with read-only reviewer fanout",
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
			description: "Run scout, worker, or reviewer for one concrete handoff task in the current orchestration run. Final validation/tests must not be run before implementation and clean review.",
			promptSnippet: "Delegate a concrete task to scout, worker, or reviewer within the current orchestration run",
			promptGuidelines: [
				"Use run_role_agent from orchestrator only after deciding the next workflow step.",
				"Use purpose=validation for final tests or end-user checks, and only after implementation plus review/fix loop.",
			],
			executionMode: "sequential",
			parameters: RoleRunParams,
			async execute(_id, params: RoleRunParamsType, signal, onUpdate, ctx) {
				const config = loadConfig(ctx.cwd);
				validateRolePurpose(params.role, params.purpose);
				if (params.purpose === "validation" && workerRuns === 0) {
					throw new Error("Final validation/tests/end-user checks are blocked until after successful worker implementation.");
				}
				if (params.purpose === "validation" && config.workflow.runTestsOnlyAfterReviewLoop && !latestWorkerRunReviewedClean) {
					throw new Error("Final validation/tests/end-user checks are blocked until the orchestrator synthesizes a clean review with mark_review_clean.");
				}
				if (params.role === "reviewer" && workerRuns === 0) {
					throw new Error("Reviewer is blocked until after successful worker implementation.");
				}
				if (params.role === "reviewer" && params.purpose === "review" && reviewRuns >= config.workflow.maxReviewRounds) {
					throw new Error(`Review-round cap reached (${config.workflow.maxReviewRounds}). Stop and summarize remaining findings instead of launching another reviewer.`);
				}
				if (params.role === "worker" && params.purpose === "review") {
					throw new Error("Worker cannot be used for review purpose.");
				}
				if (params.role === "worker" && workerActive && (!config.workflow.allowParallelWorkers || config.workflow.parallelWorkersRequireWorktrees)) {
					throw new Error(config.workflow.allowParallelWorkers && config.workflow.parallelWorkersRequireWorktrees
						? "Parallel workers require worktree isolation, which this v1 extension does not implement yet; wait for the active worker to finish."
						: "Parallel workers are disabled by config; wait for the active worker to finish.");
				}
				const label = `${params.role}${params.round ? `-round-${params.round}` : ""}`;
				const outputArtifactPath = params.outputFile ? resolveArtifactPath(runDir, params.outputFile) : undefined;
				const task = `${params.task}\n\nRun directory: ${runDir}\nExpected output artifact: ${params.outputFile ?? `${label}.md`}\nPurpose: ${params.purpose}`;
				writeArtifact(runDir, `delegations/${label}-${Date.now()}.md`, task);
				const validationBefore = params.role === "worker" && params.purpose === "validation" ? createProjectSnapshot(ctx.cwd, [runDir]) : undefined;
				if (params.role === "worker") workerActive = true;
				try {
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
					let validationChangedTree: { before: ProjectSnapshot; after: ProjectSnapshot; artifact: string } | undefined;
					if (validationBefore) {
						const validationAfter = createProjectSnapshot(ctx.cwd, [runDir]);
						if (validationBefore.hash !== validationAfter.hash) {
							persistAuthorizedSourceSnapshot(ctx.cwd);
							workerRuns++;
							reviewRunsSinceLatestWorker = 0;
							latestWorkerRunReviewedClean = false;
							const artifact = writeArtifact(runDir, `validation-mutated-source-${Date.now()}.md`, `# Validation Mutated Source Tree\n\nValidation ran after a clean review, but the project snapshot changed. Treat this as a new worker change and run another reviewer before marking review clean again. This gate is invalidated even when validation itself fails.\n\nBefore: ${JSON.stringify(validationBefore)}\n\nAfter: ${JSON.stringify(validationAfter)}\n`);
							validationChangedTree = { before: validationBefore, after: validationAfter, artifact };
						}
					}
					const validationNotice = validationChangedTree ? `\n\n[Policy] Validation changed the project snapshot. Clean-review gate was invalidated; run another reviewer before finalizing. Artifact: ${validationChangedTree.artifact}` : "";
					if (result.exitCode !== 0) {
						persistState();
						throw new Error(`${childResultText(`${params.role} failed`, result)}${validationNotice}`);
					}
					if (params.outputFile && outputArtifactPath && !fs.existsSync(outputArtifactPath)) {
						copyArtifactFile(runDir, result.outputPath, outputArtifactPath);
					}

					if (succeeded && params.role === "worker" && (params.purpose === "implementation" || params.purpose === "fix")) {
						persistAuthorizedSourceSnapshot(ctx.cwd);
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
						content: [{ type: "text", text: `${childResultText(`${params.role} finished`, { ...result, outputPath: outputArtifactPath ?? result.outputPath })}${validationNotice}` }],
						details: { ...result, purpose: params.purpose, round: params.round, latestWorkerRunReviewedClean, workerRuns, reviewRuns, reviewRunsSinceLatestWorker, validationChangedTree },
					};
				} finally {
					if (params.role === "worker") workerActive = false;
				}
			},
		});

		pi.registerTool({
			name: "mark_review_clean",
			label: "Mark Review Clean",
			description: "Mark the latest successful worker changes as having a clean synthesized review. Required before validation when review-gated validation is enabled.",
			promptSnippet: "Mark the latest worker changes as cleanly reviewed after synthesizing reviewer output",
			promptGuidelines: ["Use mark_review_clean only after reviewer artifacts show no blockers and no fixes worth doing now."],
			executionMode: "sequential",
			parameters: MarkReviewCleanParams,
			async execute(_id, params: MarkReviewCleanParamsType) {
				if (workerRuns === 0) throw new Error("Cannot mark review clean before worker implementation.");
				if (reviewRunsSinceLatestWorker === 0) throw new Error("Cannot mark review clean before at least one reviewer run after the latest successful worker implementation/fix.");
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
			description: "Write a handoff artifact inside the current orchestration run directory. Does not allow escaping the run directory.",
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
			description: "Run read-only scout/reviewer fanout for a target and synthesize improvements",
			handler: async (args, ctx) => {
				const target = args.trim();
				if (!target) {
					ctx.ui.notify("Usage: /review-target @path-or-dir [focus/instructions]", "warning");
					return;
				}
				ctx.ui.notify("Starting read-only review workflow...", "info");
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

	pi.on("tool_call", (event, ctx) => {
		const currentRole = parseRoleEnv(process.env[ROLE_ENV]);
		const currentRunDir = process.env[RUN_DIR_ENV];
		if (!currentRole || currentRole === "worker") return;
		const mutationReason = blocksNonWorkerProjectMutation(event, ctx.cwd, currentRunDir);
		if (mutationReason) {
			return { block: true, reason: `${currentRole} is read-only for project/source files; ${mutationReason}.` };
		}
	});
}
