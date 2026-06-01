import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_CHILD_RUN_TIMEOUT_MS,
	DEFAULT_REFERENCE_FILE_BYTES,
	ROLE_TOOL_ALLOWLIST,
	THINKING_LEVELS,
	isObject,
	type RoleName,
} from "./roles.ts";

export interface RoleConfig {
	model: string;
	thinking?: typeof THINKING_LEVELS[number];
	tools?: string[];
}

export interface Config {
	roles: Record<RoleName, RoleConfig>;
	workflow: {
		maxReviewRounds: number;
		allowParallelWorkers: boolean;
		parallelWorkersRequireWorktrees: boolean;
		runTestsOnlyAfterReviewLoop: boolean;
	};
	children: {
		inheritExtensions: boolean;
		inheritExtensionsForReadOnly: boolean;
		inheritSkills: boolean;
		roleTimeoutMs: number;
	};
	references: {
		maxFileBytes: number;
		allowOutsideCwd: boolean;
		allowBinary: boolean;
	};
	artifacts: {
		baseDir: string;
		allowOutsideCwd: boolean;
	};
}

export const DEFAULT_CONFIG: Config = {
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
		inheritExtensionsForReadOnly: false,
		inheritSkills: false,
		roleTimeoutMs: DEFAULT_CHILD_RUN_TIMEOUT_MS,
	},
	references: {
		maxFileBytes: DEFAULT_REFERENCE_FILE_BYTES,
		allowOutsideCwd: false,
		allowBinary: false,
	},
	artifacts: { baseDir: ".pi/agent-runs", allowOutsideCwd: false },
};

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

function mergeConfig(base: Config, override: unknown, source = "unknown"): Config {
	if (override === undefined) return cloneConfig(base);
	const overrideObject = expectObject(override, source, "root");
	const next = cloneConfig(base);

	if (overrideObject.roles !== undefined) {
		const roles = expectObject(overrideObject.roles, source, "roles");
		for (const role of ["orchestrator", "scout", "worker", "reviewer"] as const) {
			if (roles[role] === undefined) continue;
			const roleObject = expectObject(roles[role], source, `roles.${role}`);
			const existing = next.roles[role];
			const roleConfig: RoleConfig = { ...existing, tools: existing.tools ? [...existing.tools] : undefined };
			if (roleObject.model !== undefined) roleConfig.model = expectModel(roleObject.model, source, `roles.${role}.model`);
			if (roleObject.thinking !== undefined) roleConfig.thinking = expectThinking(roleObject.thinking, source, `roles.${role}.thinking`);
			if (roleObject.tools !== undefined) roleConfig.tools = expectStringArray(roleObject.tools, source, `roles.${role}.tools`);
			validateRoleTools(role, roleConfig.tools, source);
			next.roles[role] = roleConfig;
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
		if (children.inheritExtensionsForReadOnly !== undefined) next.children.inheritExtensionsForReadOnly = expectBoolean(children.inheritExtensionsForReadOnly, source, "children.inheritExtensionsForReadOnly");
		if (children.inheritSkills !== undefined) next.children.inheritSkills = expectBoolean(children.inheritSkills, source, "children.inheritSkills");
		if (children.roleTimeoutMs !== undefined) next.children.roleTimeoutMs = expectPositiveInteger(children.roleTimeoutMs, source, "children.roleTimeoutMs");
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
		if (artifacts.allowOutsideCwd !== undefined) next.artifacts.allowOutsideCwd = expectBoolean(artifacts.allowOutsideCwd, source, "artifacts.allowOutsideCwd");
	}

	return ensureRequiredInternalTools(next);
}

function readJsonIfExists(filePath: string): unknown {
	if (!fs.existsSync(filePath)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse config ${filePath}: ${message}`);
	}
}

function ensureRequiredInternalTools(config: Config): Config {
	const next = cloneConfig(config);
	const ensure = (role: RoleName, tool: string) => {
		const tools = next.roles[role].tools ?? [];
		if (!tools.includes(tool)) next.roles[role].tools = [...tools, tool];
	};
	ensure("orchestrator", "run_role_agent");
	ensure("orchestrator", "write_run_artifact");
	ensure("orchestrator", "mark_review_clean");
	for (const role of ["scout", "worker", "reviewer"] as const) ensure(role, "write_run_artifact");
	for (const role of ["orchestrator", "worker"] as const) ensure(role, "compact_session");
	for (const role of ["orchestrator", "scout", "reviewer"] as const) validateRoleTools(role, next.roles[role].tools, "effective config");
	return next;
}

export function loadConfig(cwd: string): Config {
	const globalConfigPath = path.join(os.homedir(), ".pi", "agent", "pi-simple-subagents", "config.json");
	const projectConfigPath = path.join(cwd, ".pi", "pi-simple-subagents", "config.json");
	let config = cloneConfig(DEFAULT_CONFIG);
	config = mergeConfig(config, readJsonIfExists(globalConfigPath), globalConfigPath);
	config = mergeConfig(config, readJsonIfExists(projectConfigPath), projectConfigPath);
	return ensureRequiredInternalTools(config);
}

export function applyThinking(model: string, thinking: string | undefined): string {
	if (!thinking || thinking === "off") return model;
	if (/:(off|minimal|low|medium|high|xhigh)$/.test(model)) return model;
	return `${model}:${thinking}`;
}
