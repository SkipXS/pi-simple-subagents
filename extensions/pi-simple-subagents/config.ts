import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	THINKING_LEVELS,
	isObject,
	type RoleName,
} from "./roles.ts";

export interface RoleConfig {
	model: string;
	thinking?: typeof THINKING_LEVELS[number];
}

export interface Config {
	roles: Record<RoleName, RoleConfig>;
	children: {
		inheritExtensions: boolean;
		inheritExtensionsForReadOnly: boolean;
		inheritSkills: boolean;
	};
	artifacts: {
		baseDir: string;
	};
}

export const DEFAULT_CONFIG: Config = {
	roles: {
		orchestrator: {
			model: "openai-codex/gpt-5.5",
			thinking: "high",
		},
		scout: {
			model: "openai-codex/gpt-5.3-codex-spark",
			thinking: "low",
		},
		worker: {
			model: "openai-codex/gpt-5.3-codex",
			thinking: "high",
		},
		reviewer: {
			model: "openai-codex/gpt-5.5",
			thinking: "high",
		},
	},
	children: {
		inheritExtensions: true,
		inheritExtensionsForReadOnly: false,
		inheritSkills: false,
	},
	artifacts: { baseDir: ".pi/agent-runs" },
};

function cloneConfig(config: Config): Config {
	return {
		roles: {
			orchestrator: { ...config.roles.orchestrator },
			scout: { ...config.roles.scout },
			worker: { ...config.roles.worker },
			reviewer: { ...config.roles.reviewer },
		},
		children: { ...config.children },
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

function mergeConfig(base: Config, override: unknown, source = "unknown"): Config {
	if (override === undefined) return cloneConfig(base);
	const overrideObject = expectObject(override, source, "root");
	const next = cloneConfig(base);

	if (overrideObject.roles !== undefined) {
		const roles = expectObject(overrideObject.roles, source, "roles");
		for (const role of ["orchestrator", "scout", "worker", "reviewer"] as const) {
			if (roles[role] === undefined) continue;
			const roleObject = expectObject(roles[role], source, `roles.${role}`);
			const roleConfig: RoleConfig = { ...next.roles[role] };
			if (roleObject.model !== undefined) roleConfig.model = expectModel(roleObject.model, source, `roles.${role}.model`);
			if (roleObject.thinking !== undefined) roleConfig.thinking = expectThinking(roleObject.thinking, source, `roles.${role}.thinking`);
			next.roles[role] = roleConfig;
		}
	}

	if (overrideObject.children !== undefined) {
		const children = expectObject(overrideObject.children, source, "children");
		if (children.inheritExtensions !== undefined) next.children.inheritExtensions = expectBoolean(children.inheritExtensions, source, "children.inheritExtensions");
		if (children.inheritExtensionsForReadOnly !== undefined) next.children.inheritExtensionsForReadOnly = expectBoolean(children.inheritExtensionsForReadOnly, source, "children.inheritExtensionsForReadOnly");
		if (children.inheritSkills !== undefined) next.children.inheritSkills = expectBoolean(children.inheritSkills, source, "children.inheritSkills");
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
		throw new Error(`Failed to parse config ${filePath}: ${message}`);
	}
}

export function loadConfig(cwd: string): Config {
	const globalConfigPath = path.join(os.homedir(), ".pi", "agent", "pi-simple-subagents", "config.json");
	const projectConfigPath = path.join(cwd, ".pi", "pi-simple-subagents", "config.json");
	let config = cloneConfig(DEFAULT_CONFIG);
	config = mergeConfig(config, readJsonIfExists(globalConfigPath), globalConfigPath);
	config = mergeConfig(config, readJsonIfExists(projectConfigPath), projectConfigPath);
	return config;
}

export function applyThinking(model: string, thinking: string | undefined): string {
	if (!thinking || thinking === "off") return model;
	if (/:(off|minimal|low|medium|high|xhigh)$/.test(model)) return model;
	return `${model}:${thinking}`;
}
