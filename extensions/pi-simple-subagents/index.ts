import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveArtifactPath, validateOutputArtifactPath, writeArtifact } from "./artifacts.ts";
import { childEnvCounts, childResultText, spawnPiRole } from "./child-runner.ts";
import { loadConfig, WORKER_PROFILE_NAMES, type WorkerProfileName } from "./config.ts";
import {
	ROLE_ENV,
	REVIEW_RUNS_ENV,
	RUN_DIR_ENV,
	WORKER_RUNS_ENV,
	parseRoleEnv,
	validateRolePurpose,
	type RoleName,
} from "./roles.ts";
import {
	ArtifactParams,
	CompactSessionParams,
	MarkReviewCleanParams,
	RoleRunParams,
	type ArtifactParams as ArtifactParamsType,
	type CompactSessionParams as CompactSessionParamsType,
	type MarkReviewCleanParams as MarkReviewCleanParamsType,
	type RoleRunParams as RoleRunParamsType,
} from "./schemas.ts";
import { DELEGABLE_ROLE_NAMES } from "./role-registry.ts";
import { readOrchestrationState, writeOrchestrationState, type WorkerProfileBinding } from "./state.ts";
import {
	createSubagentProgress,
	withSubagentProgress,
} from "./progress.ts";
import {
	renderArtifactCall,
	renderArtifactResult,
	renderCompactCall,
	renderCompactResult,
	renderMarkReviewCleanCall,
	renderMarkReviewCleanResult,
	renderRoleAgentCall,
	renderRoleAgentResult,
} from "./rendering.ts";
import { childSummary } from "./summaries.ts";
import { registerRootCommands } from "./commands.ts";
import { registerRootTools } from "./root-tools.ts";
import { assertWorkerTaskWithinBudget } from "./workflows.ts";
import {
	defaultRoleOutputFile,
	requireExpectedRunArtifact,
	requireNonEmpty,
	roleRunLabels,
	roleStatusKey,
	roleTaskStatusDescription,
	safeIdLabel,
} from "./role-run-labels.ts";

function sendStartupWarning(pi: ExtensionAPI, warning: string, details: Record<string, unknown>): void {
	console.warn(warning);
	try {
		pi.sendMessage({ customType: "pi-simple-subagents-config-error", display: true, content: `pi-simple-subagents warning: ${warning}`, details });
	} catch { /* best-effort startup warning */ }
}

function parseStartupRole(pi: ExtensionAPI): RoleName | undefined {
	try {
		return parseRoleEnv(process.env[ROLE_ENV]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const warning = `${message}; loading pi-simple-subagents in root mode instead.`;
		sendStartupWarning(pi, warning, { env: ROLE_ENV, value: process.env[ROLE_ENV] });
		return undefined;
	}
}

function startupRunDirFallbackReason(runDir: string | undefined): string | undefined {
	if (runDir === undefined) return `${RUN_DIR_ENV} is not set`;
	if (runDir.trim() === "") return `${RUN_DIR_ENV} is empty`;
	try {
		const stat = fs.statSync(runDir);
		if (!stat.isDirectory()) return `${RUN_DIR_ENV} is not a directory: ${runDir}`;
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `${RUN_DIR_ENV} is invalid: ${runDir} (${message})`;
	}
}

function validateStartupRunDir(pi: ExtensionAPI, role: RoleName | undefined, runDir: string | undefined): string | undefined {
	if (!role) return runDir;
	const reason = startupRunDirFallbackReason(runDir);
	if (!reason) return runDir;
	const warning = `${ROLE_ENV}=${role} is set but ${reason}; loading pi-simple-subagents in root mode instead.`;
	sendStartupWarning(pi, warning, { roleEnv: ROLE_ENV, role, runDirEnv: RUN_DIR_ENV, runDir });
	return undefined;
}

export default function orchestratorAgentsExtension(pi: ExtensionAPI) {
	let role = parseStartupRole(pi);
	const startupRunDir = process.env[RUN_DIR_ENV];
	const runDir = validateStartupRunDir(pi, role, startupRunDir);
	if (role && !runDir) role = undefined;
	const persistedState = runDir ? readOrchestrationState(runDir) : undefined;
	let workerRuns = persistedState?.workerRuns ?? (Number(process.env[WORKER_RUNS_ENV] ?? "0") || 0);
	let reviewRuns = persistedState?.reviewRuns ?? (Number(process.env[REVIEW_RUNS_ENV] ?? "0") || 0);
	let reviewRunsSinceLatestWorker = persistedState?.reviewRunsSinceLatestWorker ?? 0;
	let latestWorkerRunReviewedClean = persistedState?.latestWorkerRunReviewedClean ?? false;
	let latestWorkerId = persistedState?.latestWorkerId;
	let nextWorkerSequence = Math.max(1, persistedState?.nextWorkerSequence ?? workerRuns + 1);
	let workerProfileBindings: Record<string, WorkerProfileBinding> = { ...(persistedState?.workerProfileBindings ?? {}) };
	let roleOutputSequence = 0;
	let roleStatusSequence = workerRuns + reviewRuns;
	const persistState = () => {
		if (!runDir) return undefined;
		return writeOrchestrationState(runDir, { workerRuns, reviewRuns, reviewRunsSinceLatestWorker, latestWorkerRunReviewedClean, latestWorkerId, nextWorkerSequence, workerProfileBindings });
	};
	const allocateWorkerId = (explicitWorkerId: string | undefined, purpose: string): { workerId: string; allocatedNew: boolean } => {
		if (explicitWorkerId?.trim()) return { workerId: safeIdLabel(explicitWorkerId, "worker"), allocatedNew: false };
		if ((purpose === "fix" || purpose === "validation") && latestWorkerId) return { workerId: latestWorkerId, allocatedNew: false };
		return { workerId: `worker-${nextWorkerSequence}`, allocatedNew: true };
	};
	const normalizeWorkerProfile = (profile: unknown): WorkerProfileName | undefined => {
		if (profile === undefined) return undefined;
		if (typeof profile !== "string" || !(WORKER_PROFILE_NAMES as readonly string[]).includes(profile)) throw new Error(`workerProfile=${String(profile)} is not supported; supported worker profiles: ${WORKER_PROFILE_NAMES.join(", ")}`);
		return profile as WorkerProfileName;
	};
	const workerIdLooksPreviouslyAllocated = (workerId: string): boolean => {
		if (workerId === latestWorkerId) return true;
		if (runDir && fs.existsSync(resolveArtifactPath(runDir, `sessions/${workerId}.jsonl`))) return true;
		const match = /^worker-(\d+)$/.exec(workerId);
		return match !== null && Number(match[1]) < nextWorkerSequence;
	};
	const resolveWorkerProfileBinding = (workerId: string, allocatedNew: boolean, requestedProfile: WorkerProfileName | undefined): WorkerProfileBinding => {
		const hasBinding = Object.prototype.hasOwnProperty.call(workerProfileBindings, workerId);
		const boundProfile = hasBinding ? workerProfileBindings[workerId] : undefined;
		if (hasBinding && requestedProfile !== undefined && (boundProfile ?? null) !== requestedProfile) {
			const expected = boundProfile ?? "default/unprofiled";
			throw new Error(`workerProfile=${requestedProfile} conflicts with workerId=${workerId} binding (${expected}); omit workerProfile to reuse the bound profile or use a different workerId`);
		}
		if (hasBinding) return boundProfile ?? null;
		if (!allocatedNew && workerIdLooksPreviouslyAllocated(workerId)) {
			if (requestedProfile !== undefined) throw new Error(`workerProfile=${requestedProfile} conflicts with workerId=${workerId} binding (default/unprofiled); omit workerProfile to reuse the bound profile or use a different workerId`);
			return null;
		}
		return requestedProfile ?? null;
	};
	const commitWorkerProfileBinding = (workerId: string, profile: WorkerProfileBinding): void => {
		if (Object.prototype.hasOwnProperty.call(workerProfileBindings, workerId)) return;
		workerProfileBindings = { ...workerProfileBindings, [workerId]: profile };
	};
	const reserveAutoWorkerSequence = (workerId: string): boolean => {
		const match = /^worker-(\d+)$/.exec(workerId);
		if (!match) return false;
		nextWorkerSequence = Math.max(nextWorkerSequence, Number(match[1]) + 1);
		return true;
	};

	if (!role) registerRootTools(pi);

	if (role === "orchestrator" && runDir) {
		const delegableRoleText = DELEGABLE_ROLE_NAMES.join(", ");
		pi.registerTool({
			name: "run_role_agent",
			label: "Run Role Agent",
			description: `Run ${delegableRoleText} for one concrete handoff task in the current orchestration run. YOLO by design: no file, time, validation, or snapshot guardrails are imposed. Worker sessions are per work package; reuse the same workerId for verifier gap fixes or review fixes to that package.`,
			promptSnippet: `Delegate a concrete task to ${delegableRoleText} within the current orchestration run`,
			renderCall: renderRoleAgentCall,
			renderResult: renderRoleAgentResult,
			promptGuidelines: [
				"Use run_role_agent from orchestrator after deciding the next workflow step.",
				"Before the first worker call, split broad milestones into small work packages; never delegate a whole milestone or full plan section to one worker.",
				"A worker task should normally have one deliverable, 1-3 likely files, 3-5 acceptance criteria, explicit non-goals, and one validation check.",
				"When a light worker profile is configured, you may pass workerProfile=light for small, bounded, low-risk new worker tasks. Omit workerProfile for a new/unbound worker to use the normal/default worker; follow-ups with the same workerId reuse the bound profile, and a different/default profile requires a new worker package/workerId.",
				"For each new worker implementation package, omit workerId so the tool assigns worker-1, worker-2, etc.; after the worker returns, run role=verifier purpose=validation before reviewer review.",
				"If the verifier reports concrete implementation gaps, run role=worker purpose=fix with the same workerId, then run the verifier again before review.",
				"For accepted fixes after reviewing that package, pass the same workerId; run verifier again before the next reviewer round when the fix changes implementation state.",
				"Use worker purpose=validation for final tests or end-user checks when useful; Pi YOLO policy applies. If workerId is omitted for fix/validation, the latest worker is reused.",
				"run_role_agent calls are serialized; do not rely on parallel worker execution in a single assistant turn.",
				"Default output artifacts avoid overwriting existing role artifacts, but use explicit readable outputFile names for iterative loops such as verification-round-1.md, review-round-1.md, accepted-fixes-round-1.md, and validation.md.",
			],
			executionMode: "sequential",
			parameters: RoleRunParams,
			async execute(_id, params: RoleRunParamsType, signal, onUpdate, ctx) {
				validateRolePurpose(params.role, params.purpose);
				if (params.workerId !== undefined && params.role !== "worker") throw new Error("workerId is only valid when role=worker");
				if (params.workerProfile !== undefined && params.role !== "worker") throw new Error("workerProfile is only valid when role=worker");
				const config = loadConfig(ctx.cwd);
				const requestedWorkerProfile = params.role === "worker" ? normalizeWorkerProfile(params.workerProfile) : undefined;
				const workerAllocation = params.role === "worker" ? allocateWorkerId(params.workerId, params.purpose) : undefined;
				const effectiveWorkerProfile = workerAllocation ? resolveWorkerProfileBinding(workerAllocation.workerId, workerAllocation.allocatedNew, requestedWorkerProfile) : undefined;
				const workerProfileConfig = effectiveWorkerProfile ? config.workerProfiles[effectiveWorkerProfile] : undefined;
				if (effectiveWorkerProfile && !workerProfileConfig) throw new Error(`workerProfile=${effectiveWorkerProfile} is not configured; define workerProfiles.${effectiveWorkerProfile} in pi-simple-subagents config or omit workerProfile`);
				const taskInput = requireNonEmpty(params.task, "role task");
				if (params.role === "worker") assertWorkerTaskWithinBudget(taskInput, "run_role_agent.task", config, "worker delegation task");
				const requestedOutputFile = params.outputFile?.trim();
				const labels = roleRunLabels(params.role, params.purpose, params.round, workerAllocation?.workerId, latestWorkerId, reviewRunsSinceLatestWorker + 1, requestedOutputFile, taskInput);
				const statusLabel = labels.statusLabel;
				const statusKey = roleStatusKey(statusLabel, ++roleStatusSequence);
				const label = labels.artifactLabel;
				const outputFile = requestedOutputFile || defaultRoleOutputFile(runDir, label, () => ++roleOutputSequence);
				const outputArtifactPath = validateOutputArtifactPath(runDir, outputFile);
				const reviewBatchingWarning = params.role === "worker" && params.purpose === "implementation" && workerAllocation?.allocatedNew && latestWorkerId && !latestWorkerRunReviewedClean
					? `Starting ${workerAllocation.workerId} while ${latestWorkerId} is not marked cleanly reviewed. This is allowed, but record the rationale for batching/skipping review in orchestration.md and review the pending package(s) before final validation.`
					: undefined;
				const workerLine = workerAllocation ? `\nWorker ID: ${workerAllocation.workerId}` : "";
				const workerProfileLine = effectiveWorkerProfile ? `\nWorker profile: ${effectiveWorkerProfile}` : "";
				const reviewWarningLine = reviewBatchingWarning ? `\nReview batching warning: ${reviewBatchingWarning}` : "";
				const task = `${taskInput}

Run directory: ${runDir}
Expected output artifact: ${outputFile}
Purpose: ${params.purpose}${workerLine}${workerProfileLine}${reviewWarningLine}

Write the expected output artifact with write_run_artifact using path ${JSON.stringify(outputFile)}. Do not use absolute paths or the generic write tool for the handoff artifact.`;
				writeArtifact(runDir, `delegations/${label}-${Date.now()}.md`, task);
				const progress = createSubagentProgress({ onToolUpdate: onUpdate });
				const result = await spawnPiRole({
					cwd: ctx.cwd,
					role: params.role,
					task,
					runDir,
					config,
					signal,
					envExtra: childEnvCounts(workerRuns, reviewRuns),
					onUpdate: (text) => progress.text(text),
					onStatus: (status) => progress.status(status),
					statusKey,
					statusLabel,
					statusDescription: roleTaskStatusDescription(params.purpose, taskInput),
					parentModel: ctx.model,
					...(workerAllocation ? { sessionLabel: workerAllocation.workerId } : {}),
					...(workerProfileConfig ? { roleConfigOverride: workerProfileConfig, autoThinking: "worker-plus-one" as const } : {}),
				});
				const succeeded = result.exitCode === 0;
				let spawnedWorkerAllocationConsumed = false;
				if (workerAllocation && effectiveWorkerProfile !== undefined && result.spawned) {
					commitWorkerProfileBinding(workerAllocation.workerId, effectiveWorkerProfile);
					spawnedWorkerAllocationConsumed = reserveAutoWorkerSequence(workerAllocation.workerId);
					persistState();
				}
				if (result.exitCode !== 0) {
					throw new Error(childResultText(`${params.role} failed`, result));
				}
				requireExpectedRunArtifact(runDir, outputFile, result, params.role);

				if (succeeded && params.role === "worker" && workerAllocation && (params.purpose === "implementation" || params.purpose === "fix" || params.purpose === "validation")) {
					workerRuns++;
					if (workerAllocation.allocatedNew && !spawnedWorkerAllocationConsumed) nextWorkerSequence++;
					latestWorkerId = workerAllocation.workerId;
					reviewRunsSinceLatestWorker = 0;
					latestWorkerRunReviewedClean = false;
				}
				if (succeeded && params.role === "reviewer" && params.purpose === "review") {
					reviewRuns++;
					reviewRunsSinceLatestWorker++;
				}
				persistState();
				const subagentProgress = progress.snapshot();
				return {
					content: [{ type: "text", text: childSummary(`${params.role} finished with exit code ${result.exitCode}.`, [["Worker", workerAllocation?.workerId], ["Worker profile", effectiveWorkerProfile ?? undefined], ["Review batching warning", reviewBatchingWarning], ["Session", result.sessionFile], ["Output", outputArtifactPath], ["Transcript", result.transcriptPath], ["Stderr", result.stderrPath]], result.output, { subagentProgress }) }],
					details: withSubagentProgress({ ...result, runDir, outputPath: outputArtifactPath, purpose: params.purpose, workerId: workerAllocation?.workerId, workerProfile: effectiveWorkerProfile ?? undefined, workerProfileBindings, reviewBatchingWarning, round: params.round, statusLabel, statusKey, latestWorkerRunReviewedClean, latestWorkerId, nextWorkerSequence, workerRuns, reviewRuns, reviewRunsSinceLatestWorker }, progress),
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
			renderCall: renderMarkReviewCleanCall,
			renderResult: renderMarkReviewCleanResult,
			async execute(_id, params: MarkReviewCleanParamsType) {
				const summary = requireNonEmpty(params.summary, "clean review summary");
				latestWorkerRunReviewedClean = true;
				const pathName = writeArtifact(runDir, `review-clean-${params.round ?? reviewRuns}.md`, `# Clean Review Mark\n\nRound: ${params.round ?? reviewRuns}\n\n${summary}\n`);
				const statePath = persistState();
				return { content: [{ type: "text", text: `Marked latest worker changes as cleanly reviewed. Artifact: ${pathName}` }], details: { latestWorkerRunReviewedClean, path: pathName, statePath, workerRuns, reviewRuns, reviewRunsSinceLatestWorker } };
			},
		});
	}

	if (role && runDir) {
		pi.registerTool({
			name: "compact_session",
			label: "Compact Session",
			description: "Request compaction for the current child session to prevent context rot while preserving role-specific task, findings, validation state, and artifact paths.",
			promptSnippet: "Compact the current child session with role-aware summary instructions",
			promptGuidelines: ["Use compact_session when any child role session with a run directory is getting long, especially scouts doing broad repo/docs reconnaissance; artifacts remain the source of truth after compaction."],
			parameters: CompactSessionParams,
			renderCall: renderCompactCall,
			renderResult: renderCompactResult,
			async execute(_id, params: CompactSessionParamsType, _signal, _onUpdate, ctx) {
				const defaultInstructions = [
					"Preserve the original plan/task/target and current goal.",
					"For scout sessions, preserve inspected files/docs, key findings, risks, open questions, and expected scout report artifact.",
					"Preserve changed files, implementation decisions, and rationale when any source work happened.",
					"Preserve verifier findings/gaps, open reviewer findings, accepted fixes, deferred items, and validation state.",
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
			promptGuidelines: ["Use write_run_artifact for scout, worker, verifier, reviewer, and orchestrator handoff files instead of the generic write tool. For expected outputs, pass the exact relative filename from 'Expected output artifact' as path; never invent absolute artifact paths."],
			parameters: ArtifactParams,
			renderCall: renderArtifactCall,
			renderResult: renderArtifactResult,
			async execute(_id, params: ArtifactParamsType) {
				const artifactPath = requireNonEmpty(params.path, "artifact path");
				const target = validateOutputArtifactPath(runDir, artifactPath);
				writeArtifact(runDir, target, params.content);
				return { content: [{ type: "text", text: `Wrote artifact: ${target}` }], details: { path: target } };
			},
		});
	}

	if (!role) registerRootCommands(pi);
}
