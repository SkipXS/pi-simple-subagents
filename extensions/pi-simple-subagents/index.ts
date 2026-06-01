import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const EXTENSION_PATH = fileURLToPath(import.meta.url);
const requireFromExtension = createRequire(import.meta.url);
const ROLE_ENV = "PI_ORCHESTRATOR_AGENT_ROLE";
const RUN_DIR_ENV = "PI_ORCHESTRATOR_AGENT_RUN_DIR";
const WORKER_RUNS_ENV = "PI_ORCHESTRATOR_AGENT_WORKER_RUNS";
const REVIEW_RUNS_ENV = "PI_ORCHESTRATOR_AGENT_REVIEW_RUNS";

const ROLE_NAMES = ["orchestrator", "scout", "worker", "reviewer"] as const;

type RoleName = typeof ROLE_NAMES[number];
type Purpose = "context" | "implementation" | "review" | "fix" | "validation";

const MAX_TOOL_OUTPUT_BYTES = 24 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_PROGRESS_LINE_BYTES = 500;
const MAX_REVIEW_ANGLES = 4;
const DEFAULT_REFERENCE_FILE_BYTES = 512 * 1024;
const DEFAULT_CHILD_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const TEXT_PROBE_BYTES = 8192;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_REVIEW_ANGLES = [
	"correctness, regressions, and runtime failures",
	"security, role boundaries, and tool-policy bypasses",
	"API design, UX, packaging, and maintainability",
] as const;

const ROLE_TOOL_ALLOWLIST: Record<Exclude<RoleName, "worker">, Set<string>> = {
	orchestrator: new Set(["read", "write_run_artifact", "run_role_agent", "mark_review_clean", "compact_session", "ctx_search"]),
	scout: new Set(["read", "write_run_artifact", "ast_grep_search", "ast_grep_scan", "ctx_search", "grep", "find", "ls"]),
	reviewer: new Set(["read", "write_run_artifact", "ast_grep_search", "ast_grep_scan", "ctx_search", "grep", "find", "ls"]),
};

const ROLE_PURPOSES: Record<Exclude<RoleName, "orchestrator">, Set<Purpose>> = {
	scout: new Set(["context"]),
	worker: new Set(["implementation", "fix", "validation"]),
	reviewer: new Set(["review"]),
};

interface RoleConfig {
	model: string;
	thinking?: typeof THINKING_LEVELS[number];
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
		roleTimeoutMs: number;
	};
	references: {
		maxFileBytes: number;
		allowOutsideCwd: boolean;
		allowBinary: boolean;
	};
	artifacts: { baseDir: string };
}

const DEFAULT_CONFIG: Config = {
	roles: {
		orchestrator: {
			model: "openai-codex/gpt-5.5",
			thinking: "high",
			tools: ["read", "write_run_artifact", "run_role_agent", "mark_review_clean", "compact_session", "ctx_search"],
		},
		scout: {
			model: "openai-codex/gpt-5.3-codex-spark",
			thinking: "low",
			tools: ["read", "write_run_artifact", "ast_grep_search", "ctx_search"],
		},
		worker: {
			model: "openai-codex/gpt-5.3-codex",
			thinking: "high",
			tools: ["read", "bash", "edit", "write", "write_run_artifact", "compact_session", "ast_grep_search", "ast_grep_scan", "ast_grep_rewrite", "ctx_execute", "ctx_execute_file", "ctx_search", "ctx_batch_execute"],
		},
		reviewer: {
			model: "openai-codex/gpt-5.5",
			thinking: "high",
			tools: ["read", "write_run_artifact", "ast_grep_search", "ast_grep_scan", "ctx_search"],
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
		roleTimeoutMs: DEFAULT_CHILD_RUN_TIMEOUT_MS,
	},
	references: {
		maxFileBytes: DEFAULT_REFERENCE_FILE_BYTES,
		allowOutsideCwd: false,
		allowBinary: false,
	},
	artifacts: { baseDir: ".pi/agent-runs" },
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfig(config: Config): Config {
	return {
		roles: {
			orchestrator: { ...config.roles.orchestrator, tools: config.roles.orchestrator.tools ? [...config.roles.orchestrator.tools] : undefined },
			scout: { ...config.roles.scout, tools: config.roles.scout.tools ? [...config.roles.scout.tools] : undefined },
			worker: { ...config.roles.worker, tools: config.roles.worker.tools ? [...config.roles.worker.tools] : undefined },
			reviewer: { ...config.roles.reviewer, tools: config.roles.reviewer.tools ? [...config.roles.reviewer.tools] : undefined },
		},
		workflow: { ...config.workflow },
		children: { ...config.children },
		references: { ...config.references },
		artifacts: { ...config.artifacts },
	};
}

function configError(source: string, message: string): Error {
	return new Error(`Invalid pi-simple-subagents config (${source}): ${message}`);
}

function expectObject(value: unknown, source: string, pathName: string): Record<string, unknown> {
	if (!isObject(value)) throw configError(source, `${pathName} must be an object`);
	return value;
}

function expectString(value: unknown, source: string, pathName: string): string {
	if (typeof value !== "string" || value.trim() === "") throw configError(source, `${pathName} must be a non-empty string`);
	return value;
}

function expectBoolean(value: unknown, source: string, pathName: string): boolean {
	if (typeof value !== "boolean") throw configError(source, `${pathName} must be a boolean`);
	return value;
}

function expectPositiveInteger(value: unknown, source: string, pathName: string): number {
	if (!Number.isInteger(value) || Number(value) < 1) throw configError(source, `${pathName} must be a positive integer`);
	return Number(value);
}

function expectNonNegativeInteger(value: unknown, source: string, pathName: string): number {
	if (!Number.isInteger(value) || Number(value) < 0) throw configError(source, `${pathName} must be a non-negative integer`);
	return Number(value);
}

function expectModel(value: unknown, source: string, pathName: string): string {
	const model = expectString(value, source, pathName);
	if (!/^[A-Za-z0-9._+/@:-]+$/.test(model)) throw configError(source, `${pathName} contains unsupported characters`);
	return model;
}

function expectThinking(value: unknown, source: string, pathName: string): typeof THINKING_LEVELS[number] {
	const thinking = expectString(value, source, pathName);
	if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) throw configError(source, `${pathName} must be one of: ${THINKING_LEVELS.join(", ")}`);
	return thinking as typeof THINKING_LEVELS[number];
}

function expectStringArray(value: unknown, source: string, pathName: string): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		throw configError(source, `${pathName} must be a non-empty array of non-empty strings`);
	}
	return [...value];
}

function validateRoleTools(role: RoleName, tools: string[] | undefined, source: string): void {
	if (!tools || role === "worker") return;
	const allowed = ROLE_TOOL_ALLOWLIST[role];
	const unsupported = tools.filter((tool) => !allowed.has(tool));
	if (unsupported.length > 0) {
		throw configError(source, `roles.${role}.tools contains unsupported read-only tool(s): ${unsupported.join(", ")}`);
	}
}

function validateRolePurpose(role: Exclude<RoleName, "orchestrator">, purpose: Purpose): void {
	if (!ROLE_PURPOSES[role].has(purpose)) {
		throw new Error(`Invalid role/purpose combination: ${role} cannot be used for ${purpose}.`);
	}
}

function mergeConfig(base: Config, override: unknown, source = "unknown"): Config {
	if (override === undefined) return cloneConfig(base);
	const overrideObject = expectObject(override, source, "root");
	const next = cloneConfig(base);

	if (overrideObject.roles !== undefined) {
		const roles = expectObject(overrideObject.roles, source, "roles");
		for (const roleName of Object.keys(roles)) {
			if (!ROLE_NAMES.includes(roleName as RoleName)) throw configError(source, `roles.${roleName} is not a supported role`);
			const role = roleName as RoleName;
			const roleOverride = expectObject(roles[role], source, `roles.${role}`);
			if (roleOverride.model !== undefined) next.roles[role].model = expectModel(roleOverride.model, source, `roles.${role}.model`);
			if (roleOverride.thinking !== undefined) next.roles[role].thinking = expectThinking(roleOverride.thinking, source, `roles.${role}.thinking`);
			if (roleOverride.tools !== undefined) {
				next.roles[role].tools = expectStringArray(roleOverride.tools, source, `roles.${role}.tools`);
				validateRoleTools(role, next.roles[role].tools, source);
			}
		}
	}

	if (overrideObject.workflow !== undefined) {
		const workflow = expectObject(overrideObject.workflow, source, "workflow");
		if (workflow.maxReviewRounds !== undefined) next.workflow.maxReviewRounds = expectPositiveInteger(workflow.maxReviewRounds, source, "workflow.maxReviewRounds");
		if (workflow.allowParallelWorkers !== undefined) next.workflow.allowParallelWorkers = expectBoolean(workflow.allowParallelWorkers, source, "workflow.allowParallelWorkers");
		if (workflow.parallelWorkersRequireWorktrees !== undefined) next.workflow.parallelWorkersRequireWorktrees = expectBoolean(workflow.parallelWorkersRequireWorktrees, source, "workflow.parallelWorkersRequireWorktrees");
		if (workflow.runTestsOnlyAfterReviewLoop !== undefined) next.workflow.runTestsOnlyAfterReviewLoop = expectBoolean(workflow.runTestsOnlyAfterReviewLoop, source, "workflow.runTestsOnlyAfterReviewLoop");
	}

	if (overrideObject.children !== undefined) {
		const children = expectObject(overrideObject.children, source, "children");
		if (children.inheritExtensions !== undefined) next.children.inheritExtensions = expectBoolean(children.inheritExtensions, source, "children.inheritExtensions");
		if (children.inheritSkills !== undefined) next.children.inheritSkills = expectBoolean(children.inheritSkills, source, "children.inheritSkills");
		if (children.roleTimeoutMs !== undefined) next.children.roleTimeoutMs = expectNonNegativeInteger(children.roleTimeoutMs, source, "children.roleTimeoutMs");
	}

	if (overrideObject.references !== undefined) {
		const references = expectObject(overrideObject.references, source, "references");
		if (references.maxFileBytes !== undefined) next.references.maxFileBytes = expectPositiveInteger(references.maxFileBytes, source, "references.maxFileBytes");
		if (references.allowOutsideCwd !== undefined) next.references.allowOutsideCwd = expectBoolean(references.allowOutsideCwd, source, "references.allowOutsideCwd");
		if (references.allowBinary !== undefined) next.references.allowBinary = expectBoolean(references.allowBinary, source, "references.allowBinary");
	}

	if (overrideObject.artifacts !== undefined) {
		const artifacts = expectObject(overrideObject.artifacts, source, "artifacts");
		if (artifacts.baseDir !== undefined) next.artifacts.baseDir = expectString(artifacts.baseDir, source, "artifacts.baseDir");
	}

	return next;
}

function readJsonIfExists(filePath: string): unknown {
	if (!fs.existsSync(filePath)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in pi-simple-subagents config ${filePath}: ${message}`);
	}
}

function ensureRequiredInternalTools(config: Config): Config {
	const next = cloneConfig(config);
	const required: Record<RoleName, string[]> = {
		orchestrator: ["write_run_artifact", "run_role_agent", "mark_review_clean"],
		scout: ["write_run_artifact"],
		worker: ["write_run_artifact"],
		reviewer: ["write_run_artifact"],
	};
	for (const role of ROLE_NAMES) {
		const tools = next.roles[role].tools ?? [];
		for (const tool of required[role]) if (!tools.includes(tool)) tools.push(tool);
		next.roles[role].tools = tools;
	}
	return next;
}

function loadConfig(cwd: string): Config {
	let config = cloneConfig(DEFAULT_CONFIG);
	const globalPath = path.join(os.homedir(), ".pi", "agent", "pi-simple-subagents", "config.json");
	const projectPath = path.join(cwd, ".pi", "pi-simple-subagents", "config.json");
	config = mergeConfig(config, readJsonIfExists(globalPath), globalPath);
	config = mergeConfig(config, readJsonIfExists(projectPath), projectPath);
	return ensureRequiredInternalTools(config);
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

function resolveArtifactPath(runDir: string, name: string): string {
	const safeName = name.replace(/^[/\\]+/, "");
	const target = path.resolve(runDir, safeName);
	const relative = path.relative(runDir, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Artifact path escapes run dir: ${name}`);
	return target;
}

function writeArtifact(runDir: string, name: string, content: string): string {
	const target = resolveArtifactPath(runDir, name);
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

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureReferenceAllowed(cwd: string, absolutePath: string, config: Config, label: string): void {
	if (config.references.allowOutsideCwd) return;
	const realCwd = fs.realpathSync.native(cwd);
	const realTarget = fs.realpathSync.native(absolutePath);
	if (!isPathInside(realCwd, realTarget)) {
		throw new Error(`${label} reference escapes the current project directory: ${absolutePath}. Set references.allowOutsideCwd=true to opt in.`);
	}
}

function looksBinary(buffer: Buffer): boolean {
	if (buffer.includes(0)) return true;
	if (buffer.length === 0) return false;
	let suspicious = 0;
	for (const byte of buffer) {
		if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
	}
	return suspicious / buffer.length > 0.3;
}

function readReference(cwd: string, input: string, label: string, config: Config, options?: { allowDirectory?: boolean; leadingOnly?: boolean }): { text: string; source: string } {
	const trimmed = input.trim();
	const atMatch = (options?.leadingOnly ? /^@(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed) : /(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed));
	const pathLike = atMatch?.[1] ?? atMatch?.[2] ?? atMatch?.[3];
	if (!pathLike) return { text: input, source: `inline ${label}` };

	const absolutePath = path.resolve(cwd, pathLike);
	if (!fs.existsSync(absolutePath)) throw new Error(`${label} reference not found: ${pathLike}`);
	ensureReferenceAllowed(cwd, absolutePath, config, label);
	const stat = fs.statSync(absolutePath);
	if (stat.isDirectory()) {
		if (!options?.allowDirectory) throw new Error(`${label} reference must be a file, got directory: ${pathLike}`);
		const rest = `${trimmed.slice(0, atMatch.index)} ${trimmed.slice(atMatch.index + atMatch[0].length)}`.trim();
		return { text: rest ? `Target directory: ${absolutePath}

Additional user instruction:
${rest}` : `Target directory: ${absolutePath}`, source: absolutePath };
	}
	if (!stat.isFile()) throw new Error(`${label} reference is not a regular file: ${pathLike}`);
	if (stat.size > config.references.maxFileBytes) {
		throw new Error(`${label} reference is too large (${stat.size} bytes). Limit is ${config.references.maxFileBytes} bytes; raise references.maxFileBytes to opt in.`);
	}
	const probe = fs.readFileSync(absolutePath).subarray(0, Math.min(stat.size, TEXT_PROBE_BYTES));
	if (!config.references.allowBinary && looksBinary(probe)) {
		throw new Error(`${label} reference appears to be binary. Set references.allowBinary=true to opt in.`);
	}
	const body = fs.readFileSync(absolutePath, "utf8");
	const rest = `${trimmed.slice(0, atMatch.index)} ${trimmed.slice(atMatch.index + atMatch[0].length)}`.trim();
	return { text: rest ? `${body}

Additional user instruction:
${rest}` : body, source: absolutePath };
}

function readPlanReference(cwd: string, input: string, config: Config): { planText: string; planSource: string } {
	const reference = readReference(cwd, input, "plan", config, { leadingOnly: true });
	return { planText: reference.text, planSource: reference.source };
}

function takeUtf8Head(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
	return text.slice(0, end);
}

function takeUtf8Tail(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let start = Math.max(0, text.length - maxBytes);
	while (start < text.length && Buffer.byteLength(text.slice(start), "utf8") > maxBytes) start++;
	return text.slice(start);
}

function truncateForTool(text: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): { text: string; truncated: boolean; totalBytes: number } {
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= maxBytes) return { text, truncated: false, totalBytes };
	const kept = takeUtf8Head(text, maxBytes);
	return {
		text: `${kept}\n\n[Output truncated: ${totalBytes - Buffer.byteLength(kept, "utf8")} bytes omitted. See artifact/log paths for full output.]`,
		truncated: true,
		totalBytes,
	};
}

function appendBoundedTail(current: string, chunk: string, maxBytes: number): string {
	const combined = current + chunk;
	if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
	const tail = takeUtf8Tail(combined, maxBytes);
	return `[stderr truncated: kept last ${Buffer.byteLength(tail, "utf8")} bytes]\n${tail}`;
}

function childResultText(prefix: string, result: ChildRunResult): string {
	return `${prefix} with exit code ${result.exitCode}.\nSession: ${result.sessionFile}\nOutput: ${result.outputPath}\nTranscript: ${result.transcriptPath}${result.stderrPath ? `\nStderr: ${result.stderrPath}` : ""}\n\n${result.output}`;
}

function throwChildRunError(prefix: string, result: ChildRunResult): never {
	throw new Error(childResultText(prefix, result));
}

function roleSystemPrompt(role: RoleName, runDir: string, config: Config): string {
	const common = `Artifact directory: ${runDir}\nUse write_run_artifact for handoff files. Write handoff artifacts only inside that directory unless you are the worker explicitly changing project/source files. Be concise, evidence-backed, and report file paths clearly. Use compact_session when your session gets long; preserve the plan, changed files, decisions, open reviewer findings, validation state, and artifact paths.`;
	if (role === "orchestrator") return `You are the orchestrator for a small Pi multi-agent workflow.\n\n${common}\n\nYou receive a short instruction plus a plan reference or copied plan. Your job is to coordinate scout, worker, and reviewer through the run_role_agent tool.\n\nSession policy:\n- Worker uses one persistent session file for this run. Reuse it for implementation and all fix rounds.\n- Reviewer is fresh for every review round. Give reviewer curated artifact context every time: input-plan.md, orchestration.md, scout.md if present, worker-report-round-N.md, accepted-fixes from prior rounds, and instructions to inspect the current git diff directly.\n- Scout is fresh. Orchestrator stays persistent for the run.\n\nHard rules:\n- Keep orchestration authority. Do not ask child agents to spawn other agents.\n- Use scout only when code context is missing or the plan needs grounding. Scout is read-only for project/source files.\n- Worker is the only role allowed to modify project/source files.\n- Reviewer is read-only for project/source files and reviews only after worker implementation or worker fixes.\n- Do not distribute tests, browser/user-flow checks, or end-user validation before implementation work has happened. Those belong after implementation plus review/fix loop.\n- Loop worker -> reviewer -> worker fixes -> reviewer until reviewer reports no blockers and no fixes worth doing now. Stop and ask the user if a product/scope/architecture decision is required.\n- Safety cap: max ${config.workflow.maxReviewRounds} review rounds. If still not clean, stop with a clear summary.\n- Parallel workers are ${config.workflow.allowParallelWorkers ? "allowed only for truly independent tasks with non-overlapping files; prefer serial work if unsure" : "disabled in this project config; use one worker at a time"}.\n- Synthesize reviewer feedback yourself. Send only accepted fixes worth doing now to worker. Defer optional polish.\n- When a reviewer round reports no blockers and no fixes worth doing now, call mark_review_clean with a concise synthesis before any validation/testing.\n- After mark_review_clean, run final validation/testing if appropriate.\n\nRequired artifacts:\n- orchestration.md: decisions, rounds, agent calls, deferred items.\n- accepted-fixes-round-N.md when reviewer finds fixes worth doing now.\n- validation.md after the clean review loop if validation/tests are run.\n- final-summary.md at the end.\n\nFinal response: changed files, review loop outcome, validation evidence, deferred items, artifact paths.`;
	if (role === "scout") return `You are scout.\n\n${common}\n\nRead-only project reconnaissance. Inspect files with read and structural/search tools. Do not edit project/source files and do not run shell/arbitrary-code execution tools. Write a scout report artifact.\n\nReport format:\n# Scout Report\n## Relevant files\n## Existing behavior\n## Risks / unknowns\n## Recommended worker context`;
	if (role === "reviewer") return `You are reviewer.\n\n${common}\n\nReview the implemented worker report/artifacts after implementation. You are read-only for project/source files. Do not edit source and do not run shell/arbitrary-code execution tools. Do not run broad end-user validation unless the orchestrator explicitly says the review/fix loop is complete and this is validation. Prefer inspecting relevant files and focused evidence.\n\nReport format:\n# Review Report\n## Blockers\n## Fixes worth doing now\n## Optional / deferred\n## Validation gaps\n## Verdict\nUse clear severity and file references.`;
	return `You are worker.\n\n${common}\n\nYou are the only role allowed to modify project/source files. Implement only the concrete task from the orchestrator. Do not widen scope. If a product, architecture, or scope decision is missing, stop and report it. After changes, write a worker report artifact.\n\nReport format:\n# Worker Report\n## Changed files\n## What was implemented\n## Validation run\n## Open issues / decisions needed\n## Residual risks`;
}

interface ChildRunResult {
	role: RoleName;
	exitCode: number;
	output: string;
	stderr: string;
	sessionFile: string;
	transcriptPath: string;
	stderrPath: string;
	outputPath: string;
	outputTruncated: boolean;
	stderrTruncated: boolean;
	outputBytes: number;
	stderrBytes: number;
	timedOut: boolean;
}

function resolvePiCliPath(): string | undefined {
	try {
		const packageEntry = requireFromExtension.resolve("@earendil-works/pi-coding-agent");
		const candidate = path.join(path.dirname(path.dirname(packageEntry)), "dist", "cli.js");
		return fs.existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const cliPath = resolvePiCliPath();
	if (cliPath) return { command: process.execPath, args: [cliPath, ...args] };
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	if (process.platform === "win32") {
		throw new Error("Unable to resolve the Pi CLI entrypoint without cmd.exe. Ensure @earendil-works/pi-coding-agent is installed as a dependency of this package.");
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
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
	systemPrompt?: string;
}): Promise<ChildRunResult> {
	const roleConfig = input.config.roles[input.role];
	const sessionFile = resolveRoleSessionFile(input.runDir, input.role);
	const promptPath = writeArtifact(input.runDir, `prompts/${input.role}-system-${uniqueSuffix()}.md`, input.systemPrompt ?? roleSystemPrompt(input.role, input.runDir, input.config));
	const taskPath = writeArtifact(input.runDir, `tasks/${input.role}-${uniqueSuffix()}.md`, input.task);
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
	if (roleConfig.tools) args.push("--tools", roleConfig.tools.join(","));
	args.push("-p", `@${taskPath}`);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		[ROLE_ENV]: input.role,
		[RUN_DIR_ENV]: input.runDir,
		...(input.envExtra ?? {}),
	};
	if (input.config.children.inheritExtensions) {
		delete env.CONTEXT_MODE_BRIDGE_DEPTH;
	}
	return await new Promise<ChildRunResult>((resolve) => {
		const stampBase = `${Date.now()}-${uniqueSuffix()}`;
		const transcriptPath = resolveArtifactPath(input.runDir, `logs/${input.role}-${stampBase}.jsonl`);
		const stderrPath = resolveArtifactPath(input.runDir, `logs/${input.role}-${stampBase}.stderr.log`);
		ensureDir(path.dirname(transcriptPath));
		fs.writeFileSync(transcriptPath, "", "utf8");
		fs.writeFileSync(stderrPath, "", "utf8");

		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
		let buffer = "";
		let stderr = "";
		let finalOutput = "";
		let settled = false;
		let aborted = false;
		let timedOut = false;
		const processLine = (line: string) => {
			if (!line.trim()) return;
			fs.appendFileSync(transcriptPath, `${line}\n`, "utf8");
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					for (const part of event.message.content ?? []) {
						if (part.type === "text") finalOutput = part.text;
					}
					if (finalOutput) {
						const firstLine = finalOutput.split("\n")[0] ?? "";
						input.onUpdate?.(`${input.role}: ${takeUtf8Head(firstLine, MAX_PROGRESS_LINE_BYTES)}`);
					}
				}
			} catch { /* ignore non-json */ }
		};
		const abortChild = (reason = "Child run aborted.") => {
			aborted = true;
			const line = `${reason}\n`;
			stderr = appendBoundedTail(stderr, stderr.endsWith("\n") || stderr.length === 0 ? line : `\n${line}`, MAX_STDERR_BYTES);
			fs.appendFileSync(stderrPath, stderr.endsWith("\n") ? line : `\n${line}`, "utf8");
			if (process.platform === "win32" && child.pid) {
				const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
				killer.on("error", () => child.kill());
				return;
			}
			child.kill("SIGTERM");
			const killTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 5000);
			(killTimer as { unref?: () => void }).unref?.();
		};
		const onAbort = () => abortChild();
		const timeoutMs = input.config.children.roleTimeoutMs;
		const timeoutHandle = timeoutMs > 0 ? setTimeout(() => {
			timedOut = true;
			abortChild(`Child run timed out after ${timeoutMs}ms.`);
		}, timeoutMs) : undefined;
		(timeoutHandle as { unref?: () => void } | undefined)?.unref?.();
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			if (input.signal) input.signal.removeEventListener("abort", onAbort);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (buffer.trim()) processLine(buffer);
			const fullOutput = finalOutput || (stderr ? `No assistant output. Stderr log: ${stderrPath}\n\n${stderr}` : "(no output)");
			const outputPath = writeArtifact(input.runDir, `outputs/${input.role}-${stampBase}.md`, fullOutput);
			const truncatedOutput = truncateForTool(fullOutput, MAX_TOOL_OUTPUT_BYTES);
			const truncatedStderr = truncateForTool(stderr, MAX_STDERR_BYTES);
			resolve({
				role: input.role,
				exitCode,
				output: truncatedOutput.text,
				stderr: truncatedStderr.text,
				sessionFile,
				transcriptPath,
				stderrPath,
				outputPath,
				outputTruncated: truncatedOutput.truncated,
				stderrTruncated: truncatedStderr.truncated,
				outputBytes: truncatedOutput.totalBytes,
				stderrBytes: truncatedStderr.totalBytes,
				timedOut,
			});
		};
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			fs.appendFileSync(stderrPath, text, "utf8");
			stderr = appendBoundedTail(stderr, text, MAX_STDERR_BYTES);
		});
		child.on("close", (code, signal) => {
			finish(aborted ? 130 : code ?? (signal ? 1 : 0));
		});
		child.on("error", (error) => {
			const message = error instanceof Error ? error.message : String(error);
			fs.appendFileSync(stderrPath, message, "utf8");
			stderr = appendBoundedTail(stderr, message, MAX_STDERR_BYTES);
			finish(1);
		});
		if (input.signal) {
			if (input.signal.aborted) onAbort();
			else input.signal.addEventListener("abort", onAbort, { once: true });
		}
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

const ReviewTargetParams = Type.Object({
	target: Type.String({ description: "Inline review scope, @file, @directory, or instruction pointing to what should be reviewed." }),
	focus: Type.Optional(Type.String({ description: "Optional review focus, e.g. runtime bugs, security, packaging, UX." })),
	reviewers: Type.Optional(Type.Array(Type.String({ description: "Reviewer angle/focus." }), { maxItems: MAX_REVIEW_ANGLES })),
	includeScout: Type.Optional(Type.Boolean({ description: "Run a read-only scout before reviewers. Default: true.", default: true })),
});
type ReviewTargetParams = Static<typeof ReviewTargetParams>;

const ArtifactParams = Type.Object({
	path: Type.String({ description: "Artifact path relative to the current run directory, e.g. review-round-1.md" }),
	content: Type.String({ description: "Markdown/text content to write" }),
});
type ArtifactParams = Static<typeof ArtifactParams>;

const CompactSessionParams = Type.Object({
	instructions: Type.Optional(Type.String({ description: "Optional focus instructions for the compaction summary." })),
});
type CompactSessionParams = Static<typeof CompactSessionParams>;

const MarkReviewCleanParams = Type.Object({
	round: Type.Optional(Type.Integer({ minimum: 1, description: "Review round that was synthesized as clean." })),
	summary: Type.String({ description: "Concise synthesis explaining why there are no blockers or fixes worth doing now." }),
});
type MarkReviewCleanParams = Static<typeof MarkReviewCleanParams>;

function formatRunTask(planText: string, planSource: string, runDir: string): string {
	return `Run directory: ${runDir}\nPlan source: ${planSource}\n\nPlan / instruction:\n${planText}\n\nStart by writing orchestration.md. Then follow the orchestrator workflow. If the plan is unclear, stop and ask the user for clarification instead of guessing.`;
}

function parseReviewTargetCommand(input: string): Pick<ReviewTargetParams, "target" | "focus"> {
	const trimmed = input.trim();
	const match = /^(@(?:"[^"]+"|'[^']+'|\S+))(?:\s+([\s\S]+))?$/.exec(trimmed);
	if (!match) return { target: trimmed };
	const focus = match[2]?.trim();
	return focus ? { target: match[1], focus } : { target: match[1] };
}

async function runOrchestration(cwd: string, rawPlan: string, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<{ result: ChildRunResult; runDir: string; planSource: string }> {
	const config = loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	const { planText, planSource } = readPlanReference(cwd, rawPlan, config);
	writeArtifact(dir, "input-plan.md", `Source: ${planSource}\n\n${planText}\n`);
	writeArtifact(dir, "config-effective.json", JSON.stringify(config, null, 2));
	const task = formatRunTask(planText, planSource, dir);
	const result = await spawnPiRole({ cwd, role: "orchestrator", task, runDir: dir, config, signal, onUpdate });
	return { result, runDir: dir, planSource };
}

function reviewTargetSystemPrompt(kind: "scout" | "reviewer" | "synthesis", runDir: string): string {
	const common = `Artifact directory: ${runDir}\nThis is a review-only pi-simple-subagents workflow. Do not modify project/source files. You may write review artifacts only with write_run_artifact inside the artifact directory. Do not run shell/arbitrary-code execution tools. Inspect the target directly with read and structural/search tools. Return evidence-backed findings with file paths and line references when possible.`;
	if (kind === "scout") return `You are scout for a review-only workflow.\n\n${common}\n\nMap the target, identify relevant files and risks, and write scout-review-context.md.\n\nReport format:\n# Scout Review Context\n## Target\n## Relevant files\n## Existing behavior / architecture\n## Risk areas for reviewers`;
	if (kind === "synthesis") return `You synthesize multiple read-only review reports.\n\n${common}\n\nDo not invent findings. Deduplicate and prioritize only evidence-backed items. Write final-summary.md.\n\nReport format:\n# Review Synthesis\n## Blockers\n## Fixes worth doing now\n## Optional / deferred\n## Evidence reviewed\n## Recommended next steps`;
	return `You are reviewer in a review-only workflow.\n\n${common}\n\nReview only; do not edit. Focus on your assigned angle. Write a concise artifact for your angle.\n\nReport format:\n# Review Report\n## Blockers\n## Fixes worth doing now\n## Optional / deferred\n## Evidence\n## Verdict`;
}

async function runReviewTarget(cwd: string, params: ReviewTargetParams, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<{ runDir: string; targetSource: string; scout?: ChildRunResult; reviews: ChildRunResult[]; synthesis: ChildRunResult; finalSummaryPath: string }> {
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
		if (!fs.existsSync(scoutArtifact)) fs.copyFileSync(scout.outputPath, scoutArtifact);
	}

	const reviewerAbort = new AbortController();
	const abortReviewers = () => reviewerAbort.abort();
	if (signal) {
		if (signal.aborted) abortReviewers();
		else signal.addEventListener("abort", abortReviewers, { once: true });
	}
	const settledReviews = await Promise.allSettled(reviewers.map(async (angle, index) => {
		onUpdate?.(`review-target: reviewer ${index + 1}/${reviewers.length} running`);
		const safeName = angle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `review-${index + 1}`;
		const expectedFile = `review-${index + 1}-${safeName}.md`;
		const expectedPath = resolveArtifactPath(dir, expectedFile);
		let result: ChildRunResult;
		try {
			result = await spawnPiRole({
				cwd,
				role: "reviewer",
				task: `Review target source: ${target.source}\nFocus: ${focus}\nAssigned review angle: ${angle}\nRun directory: ${dir}\nRead input-target.md${scout ? " and scout-review-context.md" : ""}, inspect the target directly, and write ${expectedFile}. Do not modify project/source files.`,
				runDir: dir,
				config,
				signal: reviewerAbort.signal,
				onUpdate,
				systemPrompt: reviewTargetSystemPrompt("reviewer", dir),
			});
		} catch (error) {
			reviewerAbort.abort();
			throw error;
		}
		if (result.exitCode !== 0) {
			reviewerAbort.abort();
			throwChildRunError(`review-target reviewer ${index + 1} failed`, result);
		}
		if (!fs.existsSync(expectedPath)) fs.copyFileSync(result.outputPath, expectedPath);
		return result;
	}));
	if (signal) signal.removeEventListener("abort", abortReviewers);
	const firstFailedReview = settledReviews.find((entry) => entry.status === "rejected") as PromiseRejectedResult | undefined;
	if (firstFailedReview) throw firstFailedReview.reason;
	const reviews = settledReviews.map((entry) => (entry as PromiseFulfilledResult<ChildRunResult>).value);

	onUpdate?.("review-target: synthesis running");
	const synthesis = await spawnPiRole({
		cwd,
		role: "reviewer",
		task: `Synthesize this review-only run.\nTarget source: ${target.source}\nFocus: ${focus}\nRun directory: ${dir}\nRead input-target.md, ${scout ? "scout-review-context.md, " : ""}the review artifacts and output logs below, then write final-summary.md.\n\nReview outputs:\n${reviews.map((r, i) => `- Reviewer ${i + 1}: ${r.outputPath}`).join("\n")}`,
		runDir: dir,
		config,
		signal,
		onUpdate,
		systemPrompt: reviewTargetSystemPrompt("synthesis", dir),
	});
	if (synthesis.exitCode !== 0) throwChildRunError("review-target synthesis failed", synthesis);
	const finalSummaryPath = resolveArtifactPath(dir, "final-summary.md");
	if (!fs.existsSync(finalSummaryPath)) fs.copyFileSync(synthesis.outputPath, finalSummaryPath);
	return { runDir: dir, targetSource: target.source, scout, reviews, synthesis, finalSummaryPath };
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

function blocksReadOnlyToolMutation(event: { toolName: string; input: unknown }): string | undefined {
	if (["bash", "ctx_execute", "ctx_execute_file", "ctx_batch_execute"].includes(event.toolName)) {
		return `${event.toolName} is blocked for read-only roles because it can execute arbitrary commands or code`;
	}
	if (event.toolName === "ast_grep_scan" && isObject(event.input) && event.input.applyFixes === true) {
		return "ast_grep_scan applyFixes is blocked for read-only roles";
	}
	if (event.toolName === "ast_grep_rewrite" && isObject(event.input) && event.input.apply === true) {
		return "ast_grep_rewrite apply=true is blocked for read-only roles";
	}
	return undefined;
}

export default function orchestratorAgentsExtension(pi: ExtensionAPI) {
	const role = process.env[ROLE_ENV] as RoleName | undefined;
	const runDir = process.env[RUN_DIR_ENV];
	let workerRuns = Number(process.env[WORKER_RUNS_ENV] ?? "0") || 0;
	let reviewRuns = Number(process.env[REVIEW_RUNS_ENV] ?? "0") || 0;
	let reviewRunsSinceLatestWorker = 0;
	let latestWorkerRunReviewedClean = false;
	let workerActive = false;

	if (!role) {
		pi.registerTool({
			name: "orchestrate_plan",
			label: "Orchestrate Plan",
			description: "Start the simple orchestrator workflow for a plan or @plan-file. The orchestrator coordinates scout, worker, reviewer, loops fixes, and runs validation only after implementation/review.",
			promptSnippet: "Run the configured orchestrator workflow for a plan or @plan-file",
			promptGuidelines: ["Use orchestrate_plan when the user asks to implement a plan through the orchestrator workflow."],
			parameters: OrchestrateParams,
			async execute(_id, params: OrchestrateParams, signal, onUpdate, ctx) {
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
			async execute(_id, params: ReviewTargetParams, signal, onUpdate, ctx) {
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
			description: "Run scout, worker, or reviewer for one concrete handoff task in the current orchestration run. Validation/tests must not be run before implementation.",
			promptSnippet: "Delegate a concrete task to scout, worker, or reviewer within the current orchestration run",
			promptGuidelines: [
				"Use run_role_agent from orchestrator only after deciding the next workflow step.",
				"Use purpose=validation for tests or end-user checks, and only after implementation plus review/fix loop.",
			],
			parameters: RoleRunParams,
			async execute(_id, params: RoleRunParams, signal, onUpdate, ctx) {
				const config = loadConfig(ctx.cwd);
				validateRolePurpose(params.role, params.purpose);
				if (params.purpose === "validation" && workerRuns === 0) {
					throw new Error("Validation/tests/end-user checks are blocked until after successful worker implementation.");
				}
				if (params.purpose === "validation" && config.workflow.runTestsOnlyAfterReviewLoop && !latestWorkerRunReviewedClean) {
					throw new Error("Validation/tests/end-user checks are blocked until the orchestrator synthesizes a clean review with mark_review_clean.");
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
				if (params.role === "worker") workerActive = true;
				try {
					const result = await spawnPiRole({
						cwd: ctx.cwd,
						role: params.role,
						task,
						runDir,
						config,
						signal,
						envExtra: {
							[WORKER_RUNS_ENV]: String(workerRuns),
							[REVIEW_RUNS_ENV]: String(reviewRuns),
						},
						onUpdate: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
					});
					const succeeded = result.exitCode === 0;
					if (result.exitCode !== 0) throwChildRunError(`${params.role} failed`, result);
					if (succeeded && params.role === "worker" && (params.purpose === "implementation" || params.purpose === "fix")) {
						workerRuns++;
						reviewRunsSinceLatestWorker = 0;
						latestWorkerRunReviewedClean = false;
					}
					if (succeeded && params.role === "reviewer" && params.purpose === "review") {
						reviewRuns++;
						reviewRunsSinceLatestWorker++;
					}
					if (params.outputFile && outputArtifactPath && !fs.existsSync(outputArtifactPath)) {
						fs.copyFileSync(result.outputPath, outputArtifactPath);
					}
					return {
						content: [{ type: "text", text: childResultText(`${params.role} finished`, { ...result, outputPath: outputArtifactPath ?? result.outputPath }) }],
						details: { ...result, purpose: params.purpose, round: params.round, latestWorkerRunReviewedClean, workerRuns, reviewRuns, reviewRunsSinceLatestWorker },
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
			parameters: MarkReviewCleanParams,
			async execute(_id, params: MarkReviewCleanParams) {
				if (workerRuns === 0) throw new Error("Cannot mark review clean before worker implementation.");
				if (reviewRunsSinceLatestWorker === 0) throw new Error("Cannot mark review clean before at least one reviewer run after the latest successful worker implementation/fix.");
				latestWorkerRunReviewedClean = true;
				const pathName = writeArtifact(runDir, `review-clean-${params.round ?? reviewRuns}.md`, `# Clean Review Mark\n\nRound: ${params.round ?? reviewRuns}\n\n${params.summary}\n`);
				return { content: [{ type: "text", text: `Marked latest worker changes as cleanly reviewed. Artifact: ${pathName}` }], details: { latestWorkerRunReviewedClean, path: pathName, workerRuns, reviewRuns, reviewRunsSinceLatestWorker } };
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
		const currentRole = process.env[ROLE_ENV] as RoleName | undefined;
		const currentRunDir = process.env[RUN_DIR_ENV];
		if (!currentRole || currentRole === "worker") return;
		if ((event.toolName === "write" || event.toolName === "edit") && currentRunDir) {
			const target = resolveToolPath(event.input, ctx.cwd);
			if (target && !isInside(path.resolve(currentRunDir), target)) {
				return { block: true, reason: `${currentRole} may write only inside artifact directory: ${currentRunDir}` };
			}
		}
		const allowedTools = ROLE_TOOL_ALLOWLIST[currentRole];
		if (allowedTools && !allowedTools.has(event.toolName)) {
			return { block: true, reason: `${currentRole} may only use approved read-only/artifact tools. Blocked tool: ${event.toolName}.` };
		}
		const mutationReason = blocksReadOnlyToolMutation(event);
		if (mutationReason) {
			return { block: true, reason: `${currentRole} is read-only for project/source files; ${mutationReason}.` };
		}
	});
}
