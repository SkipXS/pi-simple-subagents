import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, ExtensionForwardMode } from "./config.ts";

export const PI_CLI_PATH_ENV = "PI_SIMPLE_SUBAGENTS_PI_CLI";

let platformOverrideForTests: NodeJS.Platform | undefined;

export function setPiInvocationPlatformForTests(platform: NodeJS.Platform | undefined): void {
	platformOverrideForTests = platform;
}

export function runtimePlatform(): NodeJS.Platform {
	return platformOverrideForTests ?? process.platform;
}

function findPiCliFromPackageEntrypoint(packageEntrypoint: string): string | undefined {
	let dir = path.dirname(packageEntrypoint);
	while (true) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			try {
				const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: unknown; bin?: unknown };
				if (manifest.name === "@earendil-works/pi-coding-agent") {
					const bin = typeof manifest.bin === "string" ? manifest.bin : isRecord(manifest.bin) && typeof manifest.bin.pi === "string" ? manifest.bin.pi : undefined;
					const candidate = bin ? path.resolve(dir, bin) : path.join(dir, "dist", "cli.js");
					return fs.existsSync(candidate) ? candidate : undefined;
				}
			} catch {
				return undefined;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function validatePiCliOverride(cliPath: string, source: string): string {
	if (!path.isAbsolute(cliPath)) {
		throw new Error(`${source} must be an absolute path to an existing regular Pi CLI file; got ${JSON.stringify(cliPath)}`);
	}
	if (!fs.existsSync(cliPath)) {
		throw new Error(`${source} does not exist: ${cliPath}`);
	}
	const stat = fs.statSync(cliPath);
	if (!stat.isFile()) {
		throw new Error(`${source} is not a regular file: ${cliPath}`);
	}
	return cliPath;
}

function resolvePiCliPath(overridePath?: string): string | undefined {
	const envValue = process.env[PI_CLI_PATH_ENV]?.trim();
	if (envValue) return validatePiCliOverride(envValue, PI_CLI_PATH_ENV);
	const configValue = overridePath?.trim();
	if (configValue) return validatePiCliOverride(configValue, "global children.piCliPath");
	try {
		const packageEntrypoint = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		return findPiCliFromPackageEntrypoint(packageEntrypoint);
	} catch {
		return undefined;
	}
}

function isJavaScriptEntrypoint(filePath: string): boolean {
	return /\.[cm]?js$/i.test(filePath);
}

function isPathLikeCommand(command: string): boolean {
	return path.isAbsolute(command) || command.startsWith(".") || command.includes("/") || command.includes("\\");
}

export function configuredPiCliPath(config?: Config): { value: string; source: string } | undefined {
	const envValue = process.env[PI_CLI_PATH_ENV]?.trim();
	if (envValue) return { value: envValue, source: PI_CLI_PATH_ENV };
	const configValue = config?.children.piCliPath?.trim();
	return configValue ? { value: configValue, source: "global children.piCliPath" } : undefined;
}

export function piInvocationWarnings(config: Config | undefined, cwd: string, invocation: { command: string; args: string[] }): string[] {
	const warnings: string[] = [];
	const configured = configuredPiCliPath(config);
	if (configured) {
		if (!isPathLikeCommand(configured.value)) {
			warnings.push(`${configured.source} uses bare command ${JSON.stringify(configured.value)}; PATH lookup is trusted executable selection. Prefer an absolute path for reproducible child runs.`);
		} else if (!path.isAbsolute(configured.value)) {
			warnings.push(`${configured.source} uses relative path ${JSON.stringify(configured.value)}; prefer an absolute path so child runs cannot be redirected by cwd changes.`);
		}
	}
	if (isPathLikeCommand(invocation.command)) {
		const commandPath = path.isAbsolute(invocation.command) ? invocation.command : path.resolve(cwd, invocation.command);
		if (!fs.existsSync(commandPath)) throw new Error(`Pi CLI executable not found: ${commandPath}. Set ${PI_CLI_PATH_ENV} or global children.piCliPath to an existing absolute Pi CLI path.`);
		const stat = fs.statSync(commandPath);
		if (!stat.isFile()) throw new Error(`Pi CLI executable is not a regular file: ${commandPath}`);
		if (runtimePlatform() !== "win32" && invocation.command !== process.execPath && (stat.mode & 0o111) === 0) {
			warnings.push(`Pi CLI path is not marked executable: ${commandPath}. If spawn fails, chmod it or point ${PI_CLI_PATH_ENV} at a runnable wrapper.`);
		}
	}
	const jsEntrypoint = invocation.command === process.execPath && invocation.args[0] && isJavaScriptEntrypoint(invocation.args[0]) ? invocation.args[0] : undefined;
	if (jsEntrypoint) {
		const entrypointPath = path.isAbsolute(jsEntrypoint) ? jsEntrypoint : path.resolve(cwd, jsEntrypoint);
		if (!fs.existsSync(entrypointPath)) throw new Error(`Pi CLI JavaScript entrypoint not found: ${entrypointPath}. Set ${PI_CLI_PATH_ENV} or global children.piCliPath to an existing absolute Pi CLI path.`);
		const stat = fs.statSync(entrypointPath);
		if (!stat.isFile()) throw new Error(`Pi CLI JavaScript entrypoint is not a regular file: ${entrypointPath}`);
	}
	return warnings;
}

export function getPiInvocation(args: string[], config?: Config): { command: string; args: string[] } {
	const cliPath = resolvePiCliPath(config?.children.piCliPath);
	if (cliPath) {
		return isJavaScriptEntrypoint(cliPath) && fs.existsSync(cliPath)
			? { command: process.execPath, args: [cliPath, ...args] }
			: { command: cliPath, args };
	}
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: runtimePlatform() === "win32" ? "pi.cmd" : "pi", args };
}

export function quoteAtReferencePath(filePath: string): string {
	if (!/[\s"']/.test(filePath)) return `@${filePath}`;
	return `@"${filePath.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

export function wasLoadedWithExtensionFlag(argv: readonly string[] = process.argv): boolean {
	return argv.some((arg) => arg === "--extension" || arg === "-e" || arg.startsWith("--extension="));
}

export function shouldForwardCurrentExtension(mode: ExtensionForwardMode, argv: readonly string[] = process.argv): boolean {
	if (mode === "always") return true;
	if (mode === "never") return false;
	return wasLoadedWithExtensionFlag(argv);
}
