import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ROLE_METADATA, ROLE_NAMES, type RoleName } from "./role-registry.ts";
import {
	THINKING_LEVELS,
	isObject,
} from "./roles.ts";

export interface RoleConfig {
	model: string;
	thinking?: typeof THINKING_LEVELS[number] | "auto";
	/** Role-specific child process timeout in milliseconds. Use 0 to disable. Falls back to children.timeoutMs when unset. */
	timeoutMs?: number;
}

export const EXTENSION_FORWARD_MODES = ["auto", "always", "never"] as const;

export type ExtensionForwardMode = typeof EXTENSION_FORWARD_MODES[number];

export interface Config {
	roles: Record<RoleName, RoleConfig>;
	children: {
		forwardCurrentExtension: ExtensionForwardMode;
		/** Child process timeout in milliseconds. Use 0 to disable. */
		timeoutMs: number;
		/** Maximum child processes started concurrently within one fanout phase. */
		maxConcurrentSubagents: number;
		/** Optional Pi CLI path/command override. Environment PI_SIMPLE_SUBAGENTS_PI_CLI wins. */
		piCliPath?: string;
	};
	orchestration: {
		/** Maximum bytes allowed in one worker handoff/task. Use 0 to disable. */
		maxWorkerTaskBytes: number;
	};
	references: {
		/** Maximum bytes read from an @ file reference. Use 0 to disable the cap. */
		maxFileBytes: number;
		allowOutsideCwd: boolean;
		allowBinary: boolean;
	};
	artifacts: {
		baseDir: string;
		cleanup: {
			/** Delete completed extension-owned run dirs older than this many milliseconds. Use 0 to disable. */
			maxAgeMs: number;
			/** Keep total extension-owned run artifact bytes under this quota. Use 0 to disable. */
			maxTotalBytes: number;
		};
	};
}

export const DEFAULT_CONFIG: Config = {
	roles: {
		...(Object.fromEntries(ROLE_METADATA.map((role) => [role.id, { ...role.defaultConfig }])) as Record<RoleName, RoleConfig>),
		orchestrator: { ...ROLE_METADATA.find((role) => role.id === "orchestrator")!.defaultConfig, timeoutMs: 0 },
	},
	children: {
		forwardCurrentExtension: "auto",
		timeoutMs: 30 * 60 * 1000,
		maxConcurrentSubagents: 8,
	},
	orchestration: {
		maxWorkerTaskBytes: 16 * 1024,
	},
	references: {
		maxFileBytes: 1024 * 1024,
		allowOutsideCwd: false,
		allowBinary: false,
	},
	artifacts: { baseDir: ".pi/agent-runs", cleanup: { maxAgeMs: 0, maxTotalBytes: 0 } },
};

function cloneConfig(config: Config): Config {
	return {
		roles: Object.fromEntries(ROLE_NAMES.map((role) => [role, { ...config.roles[role] }])) as Record<RoleName, RoleConfig>,
		children: { ...config.children },
		orchestration: { ...config.orchestration },
		references: { ...config.references },
		artifacts: { ...config.artifacts, cleanup: { ...config.artifacts.cleanup } },
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

function expectNonNegativeInteger(value: unknown, source: string, pathName: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw configError(source, `${pathName} must be a non-negative integer`);
	return value;
}

function expectPositiveInteger(value: unknown, source: string, pathName: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw configError(source, `${pathName} must be a positive integer`);
	return value;
}

function expectModel(value: unknown, source: string, pathName: string): string {
	const model = expectString(value, source, pathName);
	if (!/^[A-Za-z0-9._+/@:-]+$/.test(model)) throw configError(source, `${pathName} contains unsupported characters`);
	return model;
}

function expectThinking(value: unknown, source: string, pathName: string): typeof THINKING_LEVELS[number] | "auto" {
	const thinking = expectString(value, source, pathName);
	if (thinking !== "auto" && !(THINKING_LEVELS as readonly string[]).includes(thinking)) throw configError(source, `${pathName} must be one of: ${THINKING_LEVELS.join(", ")}, auto`);
	return thinking as typeof THINKING_LEVELS[number] | "auto";
}

function expectExtensionForwardMode(value: unknown, source: string, pathName: string): ExtensionForwardMode {
	const mode = expectString(value, source, pathName);
	if (!(EXTENSION_FORWARD_MODES as readonly string[]).includes(mode)) throw configError(source, `${pathName} must be one of: ${EXTENSION_FORWARD_MODES.join(", ")}`);
	return mode as ExtensionForwardMode;
}

function expectExistingRegularFilePath(value: unknown, source: string, pathName: string): string {
	const filePath = expectString(value, source, pathName);
	if (!path.isAbsolute(filePath)) throw configError(source, `${pathName} must be an absolute path to an existing regular file`);
	if (!fs.existsSync(filePath)) throw configError(source, `${pathName} does not exist: ${filePath}`);
	if (!fs.statSync(filePath).isFile()) throw configError(source, `${pathName} is not a regular file: ${filePath}`);
	return filePath;
}

function rejectUnknownKeys(object: Record<string, unknown>, source: string, pathName: string, allowed: readonly string[]): void {
	const accepted = new Set(allowed);
	const unknown = Object.keys(object).filter((key) => !accepted.has(key));
	if (unknown.length > 0) throw configError(source, `${pathName} contains unknown key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveArtifactBaseForConfig(cwd: string, baseDir: string): string {
	return path.isAbsolute(baseDir) ? path.resolve(baseDir) : path.resolve(cwd, baseDir);
}

function assertProjectArtifactBaseAllowed(baseDir: string, source: string, cwd: string): void {
	if (path.isAbsolute(baseDir)) throw configError(source, "artifacts.baseDir must be relative in project config; absolute artifact bases are only allowed in the global config");
	const resolved = resolveArtifactBaseForConfig(cwd, baseDir);
	if (!isPathInside(path.resolve(cwd), resolved)) throw configError(source, "artifacts.baseDir must stay inside the project cwd; configure external artifact bases in the global config");
}

function assertProjectArtifactCleanupAllowed(baseDir: string, source: string, cwd: string): void {
	const resolved = resolveArtifactBaseForConfig(cwd, baseDir);
	if (!isPathInside(path.resolve(cwd), resolved)) throw configError(source, "artifacts.cleanup is only allowed in project config when artifacts.baseDir resolves inside the project cwd; configure cleanup for external artifact bases in the global config");
}

function mergeConfig(base: Config, override: unknown, source = "unknown", options: { allowPiCliPath?: boolean; projectCwd?: string } = {}): Config {
	if (override === undefined) return cloneConfig(base);
	const overrideObject = expectObject(override, source, "root");
	rejectUnknownKeys(overrideObject, source, "root", ["roles", "children", "orchestration", "references", "artifacts"]);
	const next = cloneConfig(base);

	if (overrideObject.roles !== undefined) {
		const roles = expectObject(overrideObject.roles, source, "roles");
		rejectUnknownKeys(roles, source, "roles", ROLE_NAMES);
		for (const role of ROLE_NAMES) {
			if (roles[role] === undefined) continue;
			const roleObject = expectObject(roles[role], source, `roles.${role}`);
			rejectUnknownKeys(roleObject, source, `roles.${role}`, ["model", "thinking", "timeoutMs"]);
			const roleConfig: RoleConfig = { ...next.roles[role] };
			if (roleObject.model !== undefined) roleConfig.model = expectModel(roleObject.model, source, `roles.${role}.model`);
			if (roleObject.thinking !== undefined) roleConfig.thinking = expectThinking(roleObject.thinking, source, `roles.${role}.thinking`);
			if (roleObject.timeoutMs !== undefined) roleConfig.timeoutMs = expectNonNegativeInteger(roleObject.timeoutMs, source, `roles.${role}.timeoutMs`);
			next.roles[role] = roleConfig;
		}
	}

	if (overrideObject.children !== undefined) {
		const children = expectObject(overrideObject.children, source, "children");
		rejectUnknownKeys(children, source, "children", ["forwardCurrentExtension", "timeoutMs", "maxConcurrentSubagents", "piCliPath"]);
		if (children.forwardCurrentExtension !== undefined) next.children.forwardCurrentExtension = expectExtensionForwardMode(children.forwardCurrentExtension, source, "children.forwardCurrentExtension");
		if (children.timeoutMs !== undefined) next.children.timeoutMs = expectNonNegativeInteger(children.timeoutMs, source, "children.timeoutMs");
		if (children.maxConcurrentSubagents !== undefined) next.children.maxConcurrentSubagents = expectPositiveInteger(children.maxConcurrentSubagents, source, "children.maxConcurrentSubagents");
		if (children.piCliPath !== undefined) {
			if (!options.allowPiCliPath) throw configError(source, "children.piCliPath is only allowed in the global config; use PI_SIMPLE_SUBAGENTS_PI_CLI for per-project/testing overrides");
			next.children.piCliPath = expectExistingRegularFilePath(children.piCliPath, source, "children.piCliPath");
		}
	}

	if (overrideObject.orchestration !== undefined) {
		const orchestration = expectObject(overrideObject.orchestration, source, "orchestration");
		rejectUnknownKeys(orchestration, source, "orchestration", ["maxWorkerTaskBytes"]);
		if (orchestration.maxWorkerTaskBytes !== undefined) next.orchestration.maxWorkerTaskBytes = expectNonNegativeInteger(orchestration.maxWorkerTaskBytes, source, "orchestration.maxWorkerTaskBytes");
	}

	if (overrideObject.references !== undefined) {
		const references = expectObject(overrideObject.references, source, "references");
		rejectUnknownKeys(references, source, "references", ["maxFileBytes", "allowOutsideCwd", "allowBinary"]);
		if (references.maxFileBytes !== undefined) next.references.maxFileBytes = expectNonNegativeInteger(references.maxFileBytes, source, "references.maxFileBytes");
		if (references.allowOutsideCwd !== undefined) next.references.allowOutsideCwd = expectBoolean(references.allowOutsideCwd, source, "references.allowOutsideCwd");
		if (references.allowBinary !== undefined) next.references.allowBinary = expectBoolean(references.allowBinary, source, "references.allowBinary");
	}

	if (overrideObject.artifacts !== undefined) {
		const artifacts = expectObject(overrideObject.artifacts, source, "artifacts");
		rejectUnknownKeys(artifacts, source, "artifacts", ["baseDir", "cleanup"]);
		if (artifacts.baseDir !== undefined) {
			const baseDir = expectString(artifacts.baseDir, source, "artifacts.baseDir");
			if (options.projectCwd) assertProjectArtifactBaseAllowed(baseDir, source, options.projectCwd);
			next.artifacts.baseDir = baseDir;
		}
		if (artifacts.cleanup !== undefined) {
			if (options.projectCwd) assertProjectArtifactCleanupAllowed(next.artifacts.baseDir, source, options.projectCwd);
			const cleanup = expectObject(artifacts.cleanup, source, "artifacts.cleanup");
			rejectUnknownKeys(cleanup, source, "artifacts.cleanup", ["maxAgeMs", "maxTotalBytes"]);
			if (cleanup.maxAgeMs !== undefined) next.artifacts.cleanup.maxAgeMs = expectNonNegativeInteger(cleanup.maxAgeMs, source, "artifacts.cleanup.maxAgeMs");
			if (cleanup.maxTotalBytes !== undefined) next.artifacts.cleanup.maxTotalBytes = expectNonNegativeInteger(cleanup.maxTotalBytes, source, "artifacts.cleanup.maxTotalBytes");
		}
	}

	return next;
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

export function loadConfig(cwd: string): Config {
	const globalConfigPath = path.join(os.homedir(), ".pi", "agent", "pi-simple-subagents", "config.json");
	const projectConfigPath = path.join(cwd, ".pi", "pi-simple-subagents", "config.json");
	let config = cloneConfig(DEFAULT_CONFIG);
	config = mergeConfig(config, readJsonIfExists(globalConfigPath), globalConfigPath, { allowPiCliPath: true });
	config = mergeConfig(config, readJsonIfExists(projectConfigPath), projectConfigPath, { projectCwd: cwd });
	return config;
}

export function getRoleTimeoutMs(config: Config, role: RoleName): number {
	return config.roles[role].timeoutMs ?? config.children.timeoutMs;
}

export function applyThinking(model: string, thinking: string | undefined): string {
	if (!thinking || thinking === "off" || thinking === "auto") return model;
	if (/:(off|minimal|low|medium|high|xhigh)$/.test(model)) return model;
	return `${model}:${thinking}`;
}

const THINKING_PRIORITY: ModelThinkingLevel[] = ["xhigh", "high", "medium", "low", "minimal", "off"];
const FALLBACK_AUTO_MODEL = "openai-codex/gpt-5.5";
const FALLBACK_AUTO_THINKING: Record<RoleName, ModelThinkingLevel> = {
	orchestrator: "high",
	scout: "minimal",
	worker: "medium",
	verifier: "medium",
	reviewer: "medium",
	synthesis: "medium",
};

/**
 * Resolve the thinking level when a role is configured with "auto" thinking
 * and a parent model's supported levels are known.
 *
 * - orchestrator: high on fine-grained models; xhigh when the model only exposes a sparse high/xhigh reasoning choice; otherwise highest available
 * - scout: "off"
 * - verifier: low when available, otherwise medium or next higher, fall back to highest available
 * - worker, reviewer: medium or next higher, fall back to highest available
 * - synthesis: smallest supported non-off level for light deduplication/reasoning, otherwise "off"
 */
export function roleAutoThinking(role: RoleName, supportedLevels: ModelThinkingLevel[]): ModelThinkingLevel {
	const levelSet = new Set(supportedLevels);

	switch (role) {
		case "orchestrator": {
			const nonOffLevels = supportedLevels.filter((level) => level !== "off");
			if (levelSet.has("high") && levelSet.has("xhigh") && nonOffLevels.length <= 2) return "xhigh";
			if (levelSet.has("high")) return "high";
			return THINKING_PRIORITY.find((l) => levelSet.has(l)) ?? "off";
		}

		case "scout":
			return "off";

		case "verifier": {
			// Verifier checks acceptance criteria rather than doing broad creative review.
			for (const candidate of ["low", "medium", "high", "xhigh"] as const) {
				if (levelSet.has(candidate)) return candidate;
			}
			return THINKING_PRIORITY.find((l) => levelSet.has(l)) ?? "off";
		}

		case "worker":
		case "reviewer": {
			// Try medium first, then high, then xhigh
			for (const candidate of ["medium", "high", "xhigh"] as const) {
				if (levelSet.has(candidate)) return candidate;
			}
			// Fall back to highest available
			return THINKING_PRIORITY.find((l) => levelSet.has(l)) ?? "off";
		}

		case "synthesis":
			for (const candidate of ["minimal", "low", "medium", "high", "xhigh"] as const) {
				if (levelSet.has(candidate)) return candidate;
			}
			return "off";

		default:
			return "off";
	}
}

/**
 * Resolve the model and thinking level for a role, considering the parent model context
 * and "auto" configuration values.
 *
 * - If model is "auto" and parentModel exists → use provider-qualified parent model id
 * - If model is "auto" and no parentModel → use fallback default "openai-codex/gpt-5.5"
 * - If thinking is "auto" and the resolved model is the parent model → use getSupportedThinkingLevels(parentModel) + roleAutoThinking()
 * - If thinking is "auto" and no matching parent model is available → use the pre-auto role defaults as a safe fallback
 * - If explicit values → use as-is
 */
export function resolveModelThinking(
	parentModel: Model<Api> | undefined,
	roleConfig: RoleConfig,
	role: RoleName,
): { model: string; thinking: string | undefined } {
	let model = roleConfig.model;
	let thinking: string | undefined = roleConfig.thinking;
	const parentModelRef = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
	const modelIsAuto = model === "auto";

	// Resolve model. Pi CLI accepts provider-qualified model ids as provider/model.
	if (modelIsAuto) {
		model = parentModelRef ?? FALLBACK_AUTO_MODEL;
	}

	// Resolve thinking. Parent model capabilities are safe to use when the resolved
	// child model is the parent model; otherwise use conservative role defaults.
	if (thinking === "auto") {
		const parentMatchesResolvedModel = parentModel && (modelIsAuto || model === parentModel.id || model === parentModelRef);
		if (parentMatchesResolvedModel) {
			const supportedLevels = getSupportedThinkingLevels(parentModel);
			thinking = roleAutoThinking(role, supportedLevels);
		} else {
			thinking = FALLBACK_AUTO_THINKING[role];
		}
	}

	return { model, thinking };
}
