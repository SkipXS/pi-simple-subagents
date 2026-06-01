import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.ts";
import { isPathInside } from "./artifacts.ts";
import { TEXT_PROBE_BYTES } from "./roles.ts";

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

export function readReference(cwd: string, input: string, label: string, config: Config, options?: { allowDirectory?: boolean; leadingOnly?: boolean }): { text: string; source: string } {
	const trimmed = input.trim();
	const atMatch = (options?.leadingOnly ? /^@(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed) : /(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed));
	const pathLike = atMatch?.[1] ?? atMatch?.[2] ?? atMatch?.[3];
	if (!atMatch || !pathLike) return { text: input, source: `inline ${label}` };

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

export function readPlanReference(cwd: string, input: string, config: Config): { planText: string; planSource: string } {
	const reference = readReference(cwd, input, "plan", config, { leadingOnly: true });
	return { planText: reference.text, planSource: reference.source };
}
