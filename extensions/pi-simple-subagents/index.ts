import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const EXTENSION_PATH = fileURLToPath(import.meta.url);
const ROLE_ENV = "PI_ORCHESTRATOR_AGENT_ROLE";
const RUN_DIR_ENV = "PI_ORCHESTRATOR_AGENT_RUN_DIR";
const WORKER_RUNS_ENV = "PI_ORCHESTRATOR_AGENT_WORKER_RUNS";
const REVIEW_RUNS_ENV = "PI_ORCHESTRATOR_AGENT_REVIEW_RUNS";

type RoleName = "orchestrator" | "scout" | "worker" | "reviewer";
type Purpose = "context" | "implementation" | "review" | "fix" | "validation";

interface RoleConfig {
	model: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | string;
	tools?: string[];
}

interface Config {
	roles: Record<RoleName, RoleConfig>;
	workflow: {
		maxReviewRounds: number;
		allowParallelWorkers: boolean;
		parallelWorkersRequireWorktrees: boolean;
		runTestsOnlyAfterReviewLoop: boolean;
	};
	children: {
		inheritExtensions: boolean;
		inheritSkills: boolean;
	};
	artifacts: { baseDir: string };
}

const DEFAULT_CONFIG: Config = {
	roles: {
		orchestrator: {
			model: "openai-codex/gpt-5.5",
			thinking: "high",
			tools: ["read", "write_run_artifact", "run_role_agent", "compact_session", "ctx_search"],
		},
		scout: {
			model: "openai-codex/gpt-5.3-codex-spark",
			thinking: "low",
			tools: ["read", "bash", "write_run_artifact", "ast_grep_search", "ctx_execute", "ctx_execute_file", "ctx_search", "ctx_batch_execute"],
		},
		worker: {
			model: "openai-codex/gpt-5.3-codex",
			thinking: "high",
			tools: ["read", "bash", "edit", "write", "write_run_artifact", "compact_session", "ast_grep_search", "ast_grep_scan", "ast_grep_rewrite", "ctx_execute", "ctx_execute_file", "ctx_search", "ctx_batch_execute"],
		},
		reviewer: {
			model: "openai-codex/gpt-5.5",
			thinking: "high",
			tools: ["read", "bash", "write_run_artifact", "ast_grep_search", "ast_grep_scan", "ctx_execute", "ctx_execute_file", "ctx_search", "ctx_batch_execute"],
		},
	},
	workflow: {
		maxReviewRounds: 5,
		allowParallelWorkers: false,
		parallelWorkersRequireWorktrees: true,
		runTestsOnlyAfterReviewLoop: true,
	},
	children: {
		inheritExtensions: true,
		inheritSkills: false,
	},
	artifacts: { baseDir: ".pi/agent-runs" },
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig(base: Config, override: unknown): Config {
	if (!isObject(override)) return base;
	const next: Config = JSON.parse(JSON.stringify(base));
	if (isObject(override.roles)) {
		for (const role of ["orchestrator", "scout", "worker", "reviewer"] as RoleName[]) {
			const roleOverride = override.roles[role];
			if (!isObject(roleOverride)) continue;
			next.roles[role] = { ...next.roles[role], ...roleOverride } as RoleConfig;
		}
	}
	if (isObject(override.workflow)) next.workflow = { ...next.workflow, ...override.workflow } as Config["workflow"];
	if (isObject(override.children)) next.children = { ...next.children, ...override.children } as Config["children"];
	if (isObject(override.artifacts)) next.artifacts = { ...next.artifacts, ...override.artifacts } as Config["artifacts"];
	return next;
}

function readJsonIfExists(filePath: string): unknown {
	if (!fs.existsSync(filePath)) return undefined;
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadConfig(cwd: string): Config {
	let config = DEFAULT_CONFIG;
	const globalPath = path.join(os.homedir(), ".pi", "agent", "pi-simple-subagents", "config.json");
	const projectPath = path.join(cwd, ".pi", "pi-simple-subagents", "config.json");
	try { config = mergeConfig(config, readJsonIfExists(globalPath)); } catch { /* keep defaults */ }
	try { config = mergeConfig(config, readJsonIfExists(projectPath)); } catch { /* keep merged config */ }
	return config;
}

function applyThinking(model: string, thinking: string | undefined): string {
	if (!thinking || thinking === "off") return model;
	if (/:(off|minimal|low|medium|high|xhigh)$/.test(model)) return model;
	return `${model}:${thinking}`;
}

function runId(): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
	return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveRunBaseDir(cwd: string, config: Config): string {
	const base = config.artifacts.baseDir || ".pi/agent-runs";
	return path.isAbsolute(base) ? base : path.resolve(cwd, base);
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function writeArtifact(runDir: string, name: string, content: string): string {
	const safeName = name.replace(/^[/\\]+/, "");
	const target = path.resolve(runDir, safeName);
	const relative = path.relative(runDir, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Artifact path escapes run dir: ${name}`);
	ensureDir(path.dirname(target));
	fs.writeFileSync(target, content, "utf8");
	return target;
}

function uniqueSuffix(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveRoleSessionFile(runDir: string, role: RoleName): string {
	const sessionsDir = path.join(runDir, "sessions");
	ensureDir(sessionsDir);
	if (role === "worker" || role === "orchestrator") return path.join(sessionsDir, `${role}.jsonl`);
	return path.join(sessionsDir, `${role}-${uniqueSuffix()}.jsonl`);
}

function readPlanReference(cwd: string, input: string): { planText: string; planSource: string } {
	const trimmed = input.trim();
	const atMatch = trimmed.match(/^@([^\s]+)(?:\s+([\s\S]*))?$/);
	const pathLike = atMatch?.[1];
	if (pathLike) {
		const planPath = path.resolve(cwd, pathLike);
		if (fs.existsSync(planPath) && fs.statSync(planPath).isFile()) {
			const rest = atMatch?.[2]?.trim();
			const body = fs.readFileSync(planPath, "utf8");
			return { planText: rest ? `${body}\n\nAdditional user instruction:\n${rest}` : body, planSource: planPath };
		}
	}
	return { planText: input, planSource: "inline prompt" };
}

function roleSystemPrompt(role: RoleName, runDir: string, config: Config): string {
	const common = `Artifact directory: ${runDir}\nUse write_run_artifact for handoff files. Write handoff artifacts only inside that directory unless you are the worker explicitly changing project/source files. Be concise, evidence-backed, and report file paths clearly. Use compact_session when your session gets long; preserve the plan, changed files, decisions, open reviewer findings, validation state, and artifact paths.`;
	if (role === "orchestrator") return `You are the orchestrator for a small Pi multi-agent workflow.\n\n${common}\n\nYou receive a short instruction plus a plan reference or copied plan. Your job is to coordinate scout, worker, and reviewer through the run_role_agent tool.\n\nSession policy:\n- Worker uses one persistent session file for this run. Reuse it for implementation and all fix rounds.\n- Reviewer is fresh for every review round. Give reviewer curated artifact context every time: input-plan.md, orchestration.md, scout.md if present, worker-report-round-N.md, accepted-fixes from prior rounds, and instructions to inspect the current git diff directly.\n- Scout is fresh. Orchestrator stays persistent for the run.\n\nHard rules:\n- Keep orchestration authority. Do not ask child agents to spawn other agents.\n- Use scout only when code context is missing or the plan needs grounding. Scout is read-only for project/source files.\n- Worker is the only role allowed to modify project/source files.\n- Reviewer is read-only for project/source files and reviews only after worker implementation or worker fixes.\n- Do not distribute tests, browser/user-flow checks, or end-user validation before implementation work has happened. Those belong after implementation plus review/fix loop.\n- Loop worker -> reviewer -> worker fixes -> reviewer until reviewer reports no blockers and no fixes worth doing now. Stop and ask the user if a product/scope/architecture decision is required.\n- Safety cap: max ${config.workflow.maxReviewRounds} review rounds. If still not clean, stop with a clear summary.\n- Parallel workers are ${config.workflow.allowParallelWorkers ? "allowed only for truly independent tasks with non-overlapping files; prefer serial work if unsure" : "disabled in this project config; use one worker at a time"}.\n- Synthesize reviewer feedback yourself. Send only accepted fixes worth doing now to worker. Defer optional polish.\n- After the review/fix loop is clean, run final validation/testing if appropriate.\n\nRequired artifacts:\n- orchestration.md: decisions, rounds, agent calls, deferred items.\n- accepted-fixes-round-N.md when reviewer finds fixes worth doing now.\n- validation.md after the clean review loop if validation/tests are run.\n- final-summary.md at the end.\n\nFinal response: changed files, review loop outcome, validation evidence, deferred items, artifact paths.`;
	if (role === "scout") return `You are scout.\n\n${common}\n\nRead-only project reconnaissance. You may inspect files and run read-only shell commands such as git status, git diff, rg, grep, find, ls. Do not edit project/source files. Write a scout report artifact.\n\nReport format:\n# Scout Report\n## Relevant files\n## Existing behavior\n## Risks / unknowns\n## Recommended worker context`;
	if (role === "reviewer") return `You are reviewer.\n\n${common}\n\nReview the implemented diff/worker report after implementation. You are read-only for project/source files. Do not edit source. Do not run broad end-user validation unless the orchestrator explicitly says the review/fix loop is complete and this is validation. Prefer inspecting git diff, relevant files, and focused evidence.\n\nReport format:\n# Review Report\n## Blockers\n## Fixes worth doing now\n## Optional / deferred\n## Validation gaps\n## Verdict\nUse clear severity and file references.`;
	return `You are worker.\n\n${common}\n\nYou are the only role allowed to modify project/source files. Implement only the concrete task from the orchestrator. Do not widen scope. If a product, architecture, or scope decision is missing, stop and report it. After changes, write a worker report artifact.\n\nReport format:\n# Worker Report\n## Changed files\n## What was implemented\n## Validation run\n## Open issues / decisions needed\n## Residual risks`;
}

interface ChildRunResult {
	role: RoleName;
	exitCode: number;
	output: string;
	stderr: string;
	sessionFile: string;
	transcriptPath: string;
	outputPath: string;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	const candidates = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
	for (const candidate of candidates) {
		return { command: candidate, args };
	}
	return { command: "pi", args };
}

async function spawnPiRole(input: {
	cwd: string;
	role: RoleName;
	task: string;
	runDir: string;
	config: Config;
	envExtra?: Record<string, string>;
	onUpdate?: (text: string) => void;
}): Promise<ChildRunResult> {
	const roleConfig = input.config.roles[input.role];
	const sessionFile = resolveRoleSessionFile(input.runDir, input.role);
	const promptPath = writeArtifact(input.runDir, `prompts/${input.role}-system.md`, roleSystemPrompt(input.role, input.runDir, input.config));
	const taskPath = writeArtifact(input.runDir, `tasks/${input.role}-${Date.now()}.md`, input.task);
	const args = [
		"--mode", "json",
		"--session", sessionFile,
	];
	if (!input.config.children.inheritExtensions) {
		args.push("--no-extensions", "--extension", EXTENSION_PATH);
	}
	if (!input.config.children.inheritSkills) {
		args.push("--no-skills");
	}
	args.push(
		"--model", applyThinking(roleConfig.model, roleConfig.thinking),
		"--system-prompt", promptPath,
	);
	if (roleConfig.tools?.length) args.push("--tools", roleConfig.tools.join(","));
	args.push("-p", `@${taskPath}`);

	const env = {
		...process.env,
		[ROLE_ENV]: input.role,
		[RUN_DIR_ENV]: input.runDir,
		...(input.envExtra ?? {}),
	};
	if (input.config.children.inheritExtensions) {
		delete env.CONTEXT_MODE_BRIDGE_DEPTH;
	}
	return await new Promise<ChildRunResult>((resolve) => {
		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
		let buffer = "";
		let stderr = "";
		const transcript: string[] = [];
		let finalOutput = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			transcript.push(line);
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					for (const part of event.message.content ?? []) {
						if (part.type === "text") finalOutput = part.text;
					}
					if (finalOutput) input.onUpdate?.(`${input.role}: ${finalOutput.split("\n")[0]}`);
				}
			} catch { /* ignore non-json */ }
		};
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			const stamp = Date.now();
			const transcriptPath = writeArtifact(input.runDir, `logs/${input.role}-${stamp}.jsonl`, transcript.join("\n"));
			const outputPath = writeArtifact(input.runDir, `outputs/${input.role}-${stamp}.md`, finalOutput || stderr || "(no output)");
			resolve({ role: input.role, exitCode: code ?? 0, output: finalOutput || stderr || "(no output)", stderr, sessionFile, transcriptPath, outputPath });
		});
		child.on("error", (error) => {
			stderr += error instanceof Error ? error.message : String(error);
		});
	});
}

const RoleRunParams = Type.Object({
	role: StringEnum(["scout", "worker", "reviewer"] as const, { description: "Role to run" }),
	purpose: StringEnum(["context", "implementation", "review", "fix", "validation"] as const, { description: "Why this role is being run. Use validation for tests/end-user checks." }),
	task: Type.String({ description: "Concrete task for the role. Include artifact paths and constraints." }),
	round: Type.Optional(Type.Integer({ minimum: 1 })),
	outputFile: Type.Optional(Type.String({ description: "Expected handoff artifact filename inside the run dir, e.g. review-round-1.md" })),
});
type RoleRunParams = Static<typeof RoleRunParams>;

const OrchestrateParams = Type.Object({
	plan: Type.String({ description: "Inline plan text, @path, or short instruction pointing to a plan file." }),
});
type OrchestrateParams = Static<typeof OrchestrateParams>;

const ArtifactParams = Type.Object({
	path: Type.String({ description: "Artifact path relative to the current run directory, e.g. review-round-1.md" }),
	content: Type.String({ description: "Markdown/text content to write" }),
});
type ArtifactParams = Static<typeof ArtifactParams>;

const CompactSessionParams = Type.Object({
	instructions: Type.Optional(Type.String({ description: "Optional focus instructions for the compaction summary." })),
});
type CompactSessionParams = Static<typeof CompactSessionParams>;

function formatRunTask(planText: string, planSource: string, runDir: string): string {
	return `Run directory: ${runDir}\nPlan source: ${planSource}\n\nPlan / instruction:\n${planText}\n\nStart by writing orchestration.md. Then follow the orchestrator workflow. If the plan is unclear, stop and ask the user for clarification instead of guessing.`;
}

async function runOrchestration(cwd: string, rawPlan: string, onUpdate?: (text: string) => void): Promise<{ result: ChildRunResult; runDir: string; planSource: string }> {
	const config = loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	const { planText, planSource } = readPlanReference(cwd, rawPlan);
	writeArtifact(dir, "input-plan.md", `Source: ${planSource}\n\n${planText}\n`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));
	const task = formatRunTask(planText, planSource, dir);
	const result = await spawnPiRole({ cwd, role: "orchestrator", task, runDir: dir, config, onUpdate });
	return { result, runDir: dir, planSource };
}

function resolveToolPath(input: unknown, cwd: string): string | undefined {
	if (!isObject(input)) return undefined;
	const raw = input.path ?? input.file_path;
	return typeof raw === "string" ? path.resolve(cwd, raw.replace(/^@/, "")) : undefined;
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function looksMutatingBash(command: string): boolean {
	const normalized = command.replace(/\s+/g, " ").trim();
	return /(^|[;&|]\s*)(rm|mv|cp|chmod|chown|mkdir|touch|git\s+(add|commit|checkout|switch|reset|clean|merge|rebase|apply)|npm\s+(install|i|update)|pnpm\s+(install|add|update)|yarn\s+(add|install|upgrade))\b/.test(normalized)
		|| /(^|[^<])>>?\s*[^&]/.test(normalized);
}

export default function orchestratorAgentsExtension(pi: ExtensionAPI) {
	const role = process.env[ROLE_ENV] as RoleName | undefined;
	const runDir = process.env[RUN_DIR_ENV];
	let workerRuns = Number(process.env[WORKER_RUNS_ENV] ?? "0") || 0;
	let reviewRuns = Number(process.env[REVIEW_RUNS_ENV] ?? "0") || 0;
	let workerActive = false;

	pi.registerTool({
		name: "orchestrate_plan",
		label: "Orchestrate Plan",
		description: "Start the simple orchestrator workflow for a plan or @plan-file. The orchestrator coordinates scout, worker, reviewer, loops fixes, and runs validation only after implementation/review.",
		promptSnippet: "Run the configured orchestrator workflow for a plan or @plan-file",
		promptGuidelines: ["Use orchestrate_plan when the user asks to implement a plan through the orchestrator workflow."],
		parameters: OrchestrateParams,
		async execute(_id, params: OrchestrateParams, _signal, onUpdate, ctx) {
			const { result, runDir, planSource } = await runOrchestration(ctx.cwd, params.plan, (text) => onUpdate?.({ content: [{ type: "text", text }] }));
			return {
				content: [{ type: "text", text: `Orchestration finished with exit code ${result.exitCode}.\nRun dir: ${runDir}\nPlan source: ${planSource}\n\n${result.output}` }],
				details: { runDir, planSource, result },
			};
		},
	});

	if (role === "orchestrator" && runDir) {
		pi.registerTool({
			name: "run_role_agent",
			label: "Run Role Agent",
			description: "Run scout, worker, or reviewer for one concrete handoff task in the current orchestration run. Validation/tests must not be run before implementation.",
			promptSnippet: "Delegate a concrete task to scout, worker, or reviewer within the current orchestration run",
			promptGuidelines: [
				"Use run_role_agent from orchestrator only after deciding the next workflow step.",
				"Use purpose=validation for tests or end-user checks, and only after implementation plus review/fix loop.",
			],
			parameters: RoleRunParams,
			async execute(_id, params: RoleRunParams, _signal, onUpdate, ctx) {
				const config = loadConfig(ctx.cwd);
				if (params.purpose === "validation" && workerRuns === 0) {
					throw new Error("Validation/tests/end-user checks are blocked until after worker implementation.");
				}
				if (params.purpose === "validation" && config.workflow.runTestsOnlyAfterReviewLoop && reviewRuns === 0) {
					throw new Error("Validation/tests/end-user checks are blocked until after at least one post-implementation review round.");
				}
				if (params.role === "reviewer" && workerRuns === 0) {
					throw new Error("Reviewer is blocked until after worker implementation.");
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
				const task = `${params.task}\n\nRun directory: ${runDir}\nExpected output artifact: ${params.outputFile ?? `${label}.md`}\nPurpose: ${params.purpose}`;
				writeArtifact(runDir, `delegations/${label}-${Date.now()}.md`, task);
				if (params.role === "worker") workerActive = true;
				try {
					const result = await spawnPiRole({
						cwd: ctx.cwd,
						role: params.role,
						task,
						runDir,
						config,
						envExtra: {
							[WORKER_RUNS_ENV]: String(workerRuns),
							[REVIEW_RUNS_ENV]: String(reviewRuns),
						},
						onUpdate: (text) => onUpdate?.({ content: [{ type: "text", text }] }),
					});
					if (params.role === "worker" && (params.purpose === "implementation" || params.purpose === "fix")) workerRuns++;
					if (params.role === "reviewer") reviewRuns++;
					if (params.outputFile && !fs.existsSync(path.resolve(runDir, params.outputFile))) {
						writeArtifact(runDir, params.outputFile, result.output);
					}
					return {
						content: [{ type: "text", text: `${params.role} finished with exit code ${result.exitCode}.\nSession: ${result.sessionFile}\nOutput artifact: ${params.outputFile ? path.resolve(runDir, params.outputFile) : result.outputPath}\nTranscript: ${result.transcriptPath}\n\n${result.output}` }],
						details: { ...result, purpose: params.purpose, round: params.round },
					};
				} finally {
					if (params.role === "worker") workerActive = false;
				}
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
			async execute(_id, params: CompactSessionParams, _signal, _onUpdate, ctx) {
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
			async execute(_id, params: ArtifactParams) {
				const target = writeArtifact(runDir, params.path, params.content);
				return { content: [{ type: "text", text: `Wrote artifact: ${target}` }], details: { path: target } };
			},
		});
	}

	pi.registerCommand("orchestrate", {
		description: "Run the simple orchestrator workflow for a plan or @plan-file",
		handler: async (args, ctx) => {
			const plan = args.trim();
			if (!plan) {
				ctx.ui.notify("Usage: /orchestrate @path/to/plan.md or /orchestrate <plan>", "warning");
				return;
			}
			ctx.ui.notify("Starting orchestrator workflow...", "info");
			const { result, runDir } = await runOrchestration(ctx.cwd, plan, (text) => ctx.ui.setStatus("orchestrator", text));
			ctx.ui.setStatus("orchestrator", undefined);
			pi.sendMessage({
				customType: "pi-simple-subagents-result",
				display: true,
				content: `Orchestration finished with exit code ${result.exitCode}.\n\nRun dir: ${runDir}\n\n${result.output}`,
				details: { runDir, result },
			});
		},
	});

	pi.on("tool_call", (event, ctx) => {
		const currentRole = process.env[ROLE_ENV] as RoleName | undefined;
		const currentRunDir = process.env[RUN_DIR_ENV];
		if (!currentRole || currentRole === "worker") return;
		if ((event.toolName === "write" || event.toolName === "edit") && currentRunDir) {
			const target = resolveToolPath(event.input, ctx.cwd);
			if (target && !isInside(path.resolve(currentRunDir), target)) {
				return { block: true, reason: `${currentRole} may write only inside artifact directory: ${currentRunDir}` };
			}
		}
		if (isToolCallEventType("bash", event) && looksMutatingBash(String(event.input.command ?? ""))) {
			return { block: true, reason: `${currentRole} is read-only for project/source files; mutating bash commands are blocked.` };
		}
	});
}
