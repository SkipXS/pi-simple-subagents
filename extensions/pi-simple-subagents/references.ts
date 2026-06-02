import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.ts";

const LARGE_REFERENCE_WARNING_BYTES = 512 * 1024;
const BINARY_SAMPLE_BYTES = 4096;

export interface ReferenceReadResult {
	text: string;
	source: string;
	warnings: string[];
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function looksBinary(buffer: Buffer): boolean {
	if (buffer.length === 0) return false;
	let suspicious = 0;
	for (const byte of buffer.subarray(0, BINARY_SAMPLE_BYTES)) {
		if (byte === 0) return true;
		const isAllowedControl = byte === 9 || byte === 10 || byte === 13 || byte === 27;
		if (byte < 32 && !isAllowedControl) suspicious++;
	}
	return suspicious / Math.min(buffer.length, BINARY_SAMPLE_BYTES) > 0.08;
}

function referenceWarnings(absolutePath: string, stat: fs.Stats, buffer: Buffer): string[] {
	const warnings: string[] = [];
	if (stat.size > LARGE_REFERENCE_WARNING_BYTES) {
		warnings.push(`Referenced file is large (${formatBytes(stat.size)}): ${absolutePath}. It is read in full by YOLO policy, which may increase latency and context pressure.`);
	}
	if (looksBinary(buffer)) {
		warnings.push(`Referenced file looks binary or non-text: ${absolutePath}. It is decoded as UTF-8 by YOLO policy and may contain replacement/control characters.`);
	}
	return warnings;
}

export function formatReferenceWarnings(warnings: readonly string[]): string {
	if (warnings.length === 0) return "";
	return `\n\nReference warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}\n`;
}

export function readReference(cwd: string, input: string, label: string, _config: Config, options?: { allowDirectory?: boolean; leadingOnly?: boolean }): ReferenceReadResult {
	const trimmed = input.trim();
	const atMatch = (options?.leadingOnly ? /^@(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed) : /(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed));
	const pathLike = atMatch?.[1] ?? atMatch?.[2] ?? atMatch?.[3];
	if (!atMatch || !pathLike) return { text: input, source: `inline ${label}`, warnings: [] };

	const absolutePath = path.resolve(cwd, pathLike);
	if (!fs.existsSync(absolutePath)) throw new Error(`${label} reference not found: ${pathLike}`);
	const stat = fs.statSync(absolutePath);
	if (stat.isDirectory()) {
		if (!options?.allowDirectory) throw new Error(`${label} reference must be a file, got directory: ${pathLike}`);
		const rest = `${trimmed.slice(0, atMatch.index)} ${trimmed.slice(atMatch.index + atMatch[0].length)}`.trim();
		return { text: rest ? `Target directory: ${absolutePath}

Additional user instruction:
${rest}` : `Target directory: ${absolutePath}`, source: absolutePath, warnings: [] };
	}
	if (!stat.isFile()) throw new Error(`${label} reference is not a regular file: ${pathLike}`);
	const buffer = fs.readFileSync(absolutePath);
	const body = buffer.toString("utf8");
	const rest = `${trimmed.slice(0, atMatch.index)} ${trimmed.slice(atMatch.index + atMatch[0].length)}`.trim();
	return { text: rest ? `${body}

Additional user instruction:
${rest}` : body, source: absolutePath, warnings: referenceWarnings(absolutePath, stat, buffer) };
}

export function readPlanReference(cwd: string, input: string, config: Config): { planText: string; planSource: string; warnings: string[] } {
	const reference = readReference(cwd, input, "plan", config, { leadingOnly: true });
	return { planText: reference.text, planSource: reference.source, warnings: reference.warnings };
}
