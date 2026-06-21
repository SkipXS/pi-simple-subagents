import fs from "node:fs";
import * as nodePath from "node:path";

export type ToolTreeRenderOptions = {
	maxBytes?: number;
	maxLines?: number;
	maxNodes?: number;
	previewLength?: number;
};

type JsonRecord = Record<string, unknown>;

type ToolNode = {
	name: string;
	input?: unknown;
	result?: unknown;
	children: ToolNode[];
};

type TranscriptParseResult = {
	nodes: ToolNode[];
	warnings: string[];
	truncated: boolean;
};

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_LINES = 4_000;
const DEFAULT_MAX_NODES = 80;
const DEFAULT_PREVIEW_LENGTH = 96;
const MAX_CHILD_TRANSCRIPTS = 24;
const MAX_TRANSCRIPT_DEPTH = 3;
const TRANSCRIPT_PRODUCING_TOOL_NAMES = new Set([
	"run_role_agent",
	"run_orchestrator",
	"run_worker",
	"run_scout",
	"run_reviewers",
	"run_workers_parallel",
]);

function asRecord(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function readTranscriptPrefix(transcriptPath: string, maxBytes: number): { text?: string; truncated: boolean; warning?: string } {
	try {
		const stat = fs.statSync(transcriptPath);
		if (!stat.isFile()) return { truncated: false, warning: "not a file" };
		const bytesToRead = Math.min(stat.size, maxBytes);
		const fd = fs.openSync(transcriptPath, "r");
		try {
			const buffer = Buffer.alloc(bytesToRead);
			const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
			return { text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: stat.size > maxBytes };
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return { truncated: false, warning: "unavailable" };
	}
}

function eventInput(event: JsonRecord): unknown {
	return event.args ?? event.input;
}

function isToolEvent(event: JsonRecord): boolean {
	return event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end";
}

function eventToolName(event: JsonRecord): string | undefined {
	return typeof event.toolName === "string" && event.toolName.trim() ? event.toolName : undefined;
}

function parseTranscript(transcriptPath: string, options: Required<ToolTreeRenderOptions>): TranscriptParseResult {
	const read = readTranscriptPrefix(transcriptPath, options.maxBytes);
	const warnings: string[] = [];
	if (read.warning) warnings.push(read.warning);
	if (!read.text) return { nodes: [], warnings, truncated: read.truncated };

	const roots: ToolNode[] = [];
	const activeById = new Map<string, ToolNode>();
	const activeByName = new Map<string, ToolNode[]>();
	let malformed = 0;
	let cappedLines = false;
	const lines = read.text.split(/\r?\n/);
	if (lines.length > options.maxLines) cappedLines = true;
	for (const line of lines.slice(0, options.maxLines)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: JsonRecord | undefined;
		try {
			event = asRecord(JSON.parse(trimmed));
		} catch {
			malformed += 1;
			continue;
		}
		if (!event || !isToolEvent(event)) continue;
		const name = eventToolName(event);
		if (!name) continue;
		const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.trim() ? event.toolCallId : undefined;
		if (event.type === "tool_execution_start") {
			const node: ToolNode = { name, input: eventInput(event), children: [] };
			roots.push(node);
			if (toolCallId) activeById.set(toolCallId, node);
			else {
				const active = activeByName.get(name) ?? [];
				active.push(node);
				activeByName.set(name, active);
			}
			continue;
		}

		let existing: ToolNode | undefined;
		let ambiguousIdlessUpdate = false;
		if (toolCallId) {
			existing = activeById.get(toolCallId);
		} else {
			const active = activeByName.get(name) ?? [];
			if (event.type === "tool_execution_end") {
				existing = active.shift();
				if (active.length === 0) activeByName.delete(name);
			} else if (active.length === 1) {
				existing = active[0];
			} else if (active.length > 1) {
				ambiguousIdlessUpdate = true;
			}
		}
		if (existing) {
			if (existing.input === undefined) existing.input = eventInput(event);
			existing.result = event.result ?? event.partialResult ?? existing.result;
			if (event.type === "tool_execution_end" && toolCallId) activeById.delete(toolCallId);
			continue;
		}
		if (ambiguousIdlessUpdate) continue;
		// Some transcripts may only contain update/end events. Keep them visible once.
		roots.push({ name, input: eventInput(event), result: event.result ?? event.partialResult, children: [] });
	}
	if (malformed > 0) warnings.push(`${malformed} malformed line${malformed === 1 ? "" : "s"} skipped`);
	return { nodes: roots, warnings, truncated: read.truncated || cappedLines };
}

function collectTranscriptPaths(value: unknown, paths: string[] = []): string[] {
	if (paths.length >= MAX_CHILD_TRANSCRIPTS) return paths;
	const record = asRecord(value);
	if (record) {
		const transcriptPath = record.transcriptPath;
		if (typeof transcriptPath === "string" && transcriptPath.trim()) paths.push(transcriptPath);
		for (const nested of Object.values(record)) collectTranscriptPaths(nested, paths);
		return paths;
	}
	if (Array.isArray(value)) {
		for (const nested of value) collectTranscriptPaths(nested, paths);
	}
	return paths;
}

function isPathInside(base: string, candidate: string): boolean {
	const relative = nodePath.relative(base, candidate);
	return relative === "" || (!relative.startsWith(`..${nodePath.sep}`) && relative !== ".." && !nodePath.isAbsolute(relative));
}

function safeTranscriptPath(transcriptPath: string, runDir: unknown): { path?: string; warning?: string } {
	if (typeof runDir !== "string" || !runDir.trim()) return { path: transcriptPath };
	try {
		const base = nodePath.resolve(runDir);
		const resolved = nodePath.isAbsolute(transcriptPath) ? nodePath.resolve(transcriptPath) : nodePath.resolve(base, transcriptPath);
		if (!isPathInside(base, resolved)) return { warning: "transcript outside run dir" };

		let realBase: string;
		try {
			realBase = fs.realpathSync.native(base);
		} catch {
			return { warning: "invalid transcript path" };
		}

		try {
			const realResolved = fs.realpathSync.native(resolved);
			if (!isPathInside(realBase, realResolved)) return { warning: "transcript outside run dir" };
		} catch {
			// Keep missing/unavailable transcripts non-throwing and let the transcript
			// reader produce its existing compact warning.
		}
		return { path: resolved };
	} catch {
		return { warning: "invalid transcript path" };
	}
}

function attachNestedSubagentTranscripts(nodes: ToolNode[], options: Required<ToolTreeRenderOptions>, visited: Set<string>, depth: number, runDir: unknown): string[] {
	if (depth >= MAX_TRANSCRIPT_DEPTH) return [];
	const warnings: string[] = [];
	for (const node of nodes) {
		const sameTranscriptChildren = [...node.children];
		if (TRANSCRIPT_PRODUCING_TOOL_NAMES.has(node.name)) {
			for (const childPath of collectTranscriptPaths(node.result)) {
				if (visited.size >= MAX_CHILD_TRANSCRIPTS) break;
				const safeChildPath = safeTranscriptPath(childPath, runDir);
				if (safeChildPath.warning) warnings.push(safeChildPath.warning);
				if (!safeChildPath.path || visited.has(safeChildPath.path)) continue;
				visited.add(safeChildPath.path);
				const child = parseTranscript(safeChildPath.path, options);
				node.children.push(...child.nodes);
				warnings.push(...child.warnings);
				if (child.truncated) warnings.push("child transcript truncated");
				warnings.push(...attachNestedSubagentTranscripts(child.nodes, options, visited, depth + 1, runDir));
			}
		}
		// Only traverse children that were already part of this transcript at the same
		// depth. Child transcript roots appended above are handled with depth + 1;
		// revisiting them here would let deep subagent chains bypass the depth cap.
		warnings.push(...attachNestedSubagentTranscripts(sameTranscriptChildren, options, visited, depth, runDir));
	}
	return warnings;
}

function compactPreview(value: unknown, maxLength: number): string {
	if (value === undefined || value === null) return "";
	let raw: string;
	if (typeof value === "string") raw = value;
	else {
		try {
			raw = JSON.stringify(value) ?? String(value);
		} catch {
			raw = String(value);
		}
	}
	const normalized = raw.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatNodes(nodes: ToolNode[], options: Required<ToolTreeRenderOptions>, lines: string[], prefix = "", counters = { nodes: 0, omitted: false }): { nodes: number; omitted: boolean } {
	for (let index = 0; index < nodes.length; index += 1) {
		if (counters.nodes >= options.maxNodes) {
			counters.omitted = true;
			return counters;
		}
		const node = nodes[index];
		if (!node) continue;
		counters.nodes += 1;
		const isLast = index === nodes.length - 1;
		const branch = prefix ? (isLast ? "└─ " : "├─ ") : "- ";
		const preview = compactPreview(node.input, options.previewLength);
		lines.push(`${prefix}${branch}${node.name}${preview ? ` ${preview}` : ""}`);
		const childPrefix = prefix ? `${prefix}${isLast ? "   " : "│  "}` : "  ";
		formatNodes(node.children, options, lines, childPrefix, counters);
	}
	return counters;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.trim()))];
}

function transcriptPathsForDetails(details: JsonRecord | undefined): string[] {
	if (!details) return [];
	const paths: string[] = [];
	const result = asRecord(details.result);
	if (typeof result?.transcriptPath === "string") paths.push(result.transcriptPath);
	if (typeof details.transcriptPath === "string") paths.push(details.transcriptPath);
	const scout = asRecord(details.scout);
	if (typeof scout?.transcriptPath === "string") paths.push(scout.transcriptPath);
	if (Array.isArray(details.reviews)) {
		for (const review of details.reviews) {
			const record = asRecord(review);
			if (typeof record?.transcriptPath === "string") paths.push(record.transcriptPath);
		}
	}
	const synthesis = asRecord(details.synthesis);
	if (typeof synthesis?.transcriptPath === "string") paths.push(synthesis.transcriptPath);
	if (Array.isArray(details.workers)) {
		for (const worker of details.workers) {
			const workerRecord = asRecord(worker);
			const workerResult = asRecord(workerRecord?.result);
			if (typeof workerResult?.transcriptPath === "string") paths.push(workerResult.transcriptPath);
		}
	}
	return uniqueStrings(paths).slice(0, MAX_CHILD_TRANSCRIPTS);
}

export function renderExpandedToolCallTree(details: JsonRecord | undefined, options: ToolTreeRenderOptions = {}): string[] {
	const normalizedOptions: Required<ToolTreeRenderOptions> = {
		maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
		maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
		maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
		previewLength: options.previewLength ?? DEFAULT_PREVIEW_LENGTH,
	};
	const paths = transcriptPathsForDetails(details);
	if (paths.length === 0) return [];

	const nodes: ToolNode[] = [];
	const warnings: string[] = [];
	const visited = new Set<string>();
	let truncated = false;
	for (const transcriptPath of paths) {
		const safePath = safeTranscriptPath(transcriptPath, details?.runDir);
		if (safePath.warning) warnings.push(safePath.warning);
		if (!safePath.path || visited.has(safePath.path)) continue;
		visited.add(safePath.path);
		const parsed = parseTranscript(safePath.path, normalizedOptions);
		nodes.push(...parsed.nodes);
		warnings.push(...parsed.warnings);
		truncated ||= parsed.truncated;
		warnings.push(...attachNestedSubagentTranscripts(parsed.nodes, normalizedOptions, visited, 0, details?.runDir));
	}
	if (nodes.length === 0 && warnings.length === 0 && !truncated) return [];

	const lines = ["", "Tool calls:"];
	const formatted = formatNodes(nodes, normalizedOptions, lines);
	if (nodes.length === 0) lines.push("- no visible tool calls found");
	if (truncated || formatted.omitted) lines.push("… tool call tree truncated");
	for (const warning of uniqueStrings(warnings).slice(0, 3)) lines.push(`(tool tree: ${warning})`);
	return lines;
}
