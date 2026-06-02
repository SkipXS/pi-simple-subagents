import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.ts";
import { isPathInside } from "./artifacts.ts";

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

function referenceWarnings(absolutePath: string, stat: fs.Stats, buffer: Buffer, config: Config, truncated: boolean, outsideCwd: boolean): string[] {
	const warnings: string[] = [];
	if (outsideCwd) {
		warnings.push(`Referenced path is outside the current project: ${absolutePath}. This is allowed by references.allowOutsideCwd=true.`);
	}
	if (stat.size > LARGE_REFERENCE_WARNING_BYTES) {
		warnings.push(`Referenced file is large (${formatBytes(stat.size)}): ${absolutePath}.`);
	}
	if (truncated) {
		warnings.push(`Referenced file was truncated to ${formatBytes(config.references.maxFileBytes)} by references.maxFileBytes. Original size: ${formatBytes(stat.size)}.`);
	}
	if (looksBinary(buffer)) {
		warnings.push(`Referenced file looks binary or non-text: ${absolutePath}. It is allowed by references.allowBinary=true and decoded as UTF-8; content may contain replacement/control characters.`);
	}
	return warnings;
}

function readFileHead(absolutePath: string, bytes: number): Buffer {
	const fd = fs.openSync(absolutePath, "r");
	try {
		const buffer = Buffer.alloc(bytes);
		const read = fs.readSync(fd, buffer, 0, bytes, 0);
		return buffer.subarray(0, read);
	} finally {
		fs.closeSync(fd);
	}
}

export function formatReferenceWarnings(warnings: readonly string[]): string {
	if (warnings.length === 0) return "";
	return `\n\nReference warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}\n`;
}

export function readReference(cwd: string, input: string, label: string, config: Config, options?: { allowDirectory?: boolean; leadingOnly?: boolean }): ReferenceReadResult {
	const trimmed = input.trim();
	const atMatch = (options?.leadingOnly ? /^@(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed) : /(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed));
	const pathLike = atMatch?.[1] ?? atMatch?.[2] ?? atMatch?.[3];
	if (!atMatch || !pathLike) return { text: input, source: `inline ${label}`, warnings: [] };

	const requestedPath = path.resolve(cwd, pathLike);
	const isLeadingReference = atMatch.index === 0;
	if (!fs.existsSync(requestedPath)) {
		if (!options?.leadingOnly && !isLeadingReference) return { text: input, source: `inline ${label}`, warnings: [] };
		throw new Error(`${label} reference not found: ${pathLike}`);
	}
	const realCwd = fs.realpathSync.native(cwd);
	const absolutePath = fs.realpathSync.native(requestedPath);
	const outsideCwd = !isPathInside(realCwd, absolutePath);
	if (outsideCwd && !config.references.allowOutsideCwd) {
		throw new Error(`${label} reference points outside the current project: ${absolutePath}. Set references.allowOutsideCwd=true to allow it intentionally.`);
	}
	const stat = fs.statSync(absolutePath);
	if (stat.isDirectory()) {
		if (!options?.allowDirectory) throw new Error(`${label} reference must be a file, got directory: ${pathLike}`);
		const rest = `${trimmed.slice(0, atMatch.index)} ${trimmed.slice(atMatch.index + atMatch[0].length)}`.trim();
		const warnings = outsideCwd ? [`Referenced directory is outside the current project: ${absolutePath}. This is allowed by references.allowOutsideCwd=true.`] : [];
		return { text: rest ? `Target directory: ${absolutePath}

Additional user instruction:
${rest}` : `Target directory: ${absolutePath}`, source: absolutePath, warnings };
	}
	if (!stat.isFile()) throw new Error(`${label} reference is not a regular file: ${pathLike}`);
	const sample = readFileHead(absolutePath, Math.min(BINARY_SAMPLE_BYTES, stat.size));
	const binary = looksBinary(sample);
	if (binary && !config.references.allowBinary) {
		throw new Error(`${label} reference looks binary or non-text: ${absolutePath}. Set references.allowBinary=true to allow UTF-8 decoding intentionally.`);
	}
	const maxBytes = config.references.maxFileBytes;
	const truncated = maxBytes > 0 && stat.size > maxBytes;
	const buffer = truncated ? readFileHead(absolutePath, maxBytes) : fs.readFileSync(absolutePath);
	const body = buffer.toString("utf8");
	const rest = `${trimmed.slice(0, atMatch.index)} ${trimmed.slice(atMatch.index + atMatch[0].length)}`.trim();
	const maybeTruncationNotice = truncated ? `

[Reference truncated: ${formatBytes(stat.size - buffer.length)} omitted from ${absolutePath}.]` : "";
	return { text: rest ? `${body}${maybeTruncationNotice}

Additional user instruction:
${rest}` : `${body}${maybeTruncationNotice}`, source: absolutePath, warnings: referenceWarnings(absolutePath, stat, binary ? sample : buffer, config, truncated, outsideCwd) };
}

export function readPlanReference(cwd: string, input: string, config: Config): { planText: string; planSource: string; warnings: string[] } {
	const reference = readReference(cwd, input, "plan", config, { leadingOnly: true });
	return { planText: reference.text, planSource: reference.source, warnings: reference.warnings };
}
