import { Text } from "@earendil-works/pi-tui";
import { formatSubagentProgress, type SubagentProgressSnapshot } from "./progress.ts";
import { renderExpandedToolCallTree } from "./tool-tree.ts";

export type RenderField = [label: string, value: string | number | boolean | undefined];

type ToolRenderSummary = {
	status?: "success" | "error" | "pending";
	fields: RenderField[];
	details?: string[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readSubagentProgressSnapshot(value: unknown): SubagentProgressSnapshot | undefined {
	const record = asRecord(value);
	const rawStatuses = record?.statuses;
	if (!Array.isArray(rawStatuses)) return undefined;
	const statuses = rawStatuses.flatMap((entry) => {
		const status = asRecord(entry);
		const key = typeof status?.key === "string" && status.key.trim() ? status.key : undefined;
		const text = typeof status?.text === "string" && status.text.trim() ? status.text : undefined;
		if (!key || !text) return [];
		const description = typeof status?.description === "string" && status.description.trim() ? status.description : undefined;
		return [{ key, text, ...(description ? { description } : {}) }];
	});
	if (statuses.length === 0) return undefined;
	const current = typeof record?.current === "string" && record.current.trim() ? record.current : undefined;
	const currentKey = typeof record?.currentKey === "string" && record.currentKey.trim() ? record.currentKey : undefined;
	return { statuses, ...(current ? { current } : {}), ...(currentKey ? { currentKey } : {}) };
}

function renderSubagentProgressDetails(details: Record<string, unknown> | undefined, content?: string): string[] {
	const progress = readSubagentProgressSnapshot(details?.subagentProgress);
	if (!progress) return [];
	// Expanded tool output can already contain the same live/final progress block in
	// `content` (updates publish it for the TUI, final summaries include it for the
	// transcript/model). Rendering the details copy as well makes Ctrl+O show the
	// whole subagent table twice.
	if (content && /^Subagents:\s/m.test(content)) return [];
	return ["", formatSubagentProgress(progress)];
}

function renderString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function renderNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" ? value : undefined;
}

function renderBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
	const value = record?.[key];
	return typeof value === "boolean" ? value : undefined;
}

function renderNested(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
	return asRecord(record?.[key]);
}

function renderArrayLength(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return Array.isArray(value) ? value.length : undefined;
}

function previewValue(value: unknown, fallback = "—", maxLength = 96): string {
	const raw = typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);
	const normalized = raw.trim().replace(/\s+/g, " ");
	if (!normalized) return fallback;
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function hasRenderableField([, value]: RenderField): boolean {
	return value !== undefined && value !== "";
}

function renderToolText(theme: any, title: string | undefined, fields: RenderField[], details: string[] = [], status: ToolRenderSummary["status"] = "pending"): Text {
	const marker = status === "success" ? theme.fg("success", "✓") : status === "error" ? theme.fg("error", "✗") : theme.fg("accent", "•");
	const lines = title ? [`${marker} ${theme.fg("toolTitle", theme.bold(title))}`] : [];
	for (const [label, value] of fields) {
		if (value === undefined || value === "") continue;
		lines.push(`${theme.fg("muted", `${label}:`)} ${String(value)}`);
	}
	for (const detail of details) {
		if (detail.trim()) lines.push(theme.fg("dim", detail));
	}
	return new Text(lines.join("\n"), 0, 0);
}

function resultContentText(result: Record<string, unknown> | undefined): string | undefined {
	const content = result?.content;
	if (!Array.isArray(content)) return undefined;
	const text = content.flatMap((part) => {
		const record = asRecord(part);
		return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
	}).join("\n").trim();
	return text || undefined;
}

function childRunFields(details: Record<string, unknown> | undefined): RenderField[] {
	const child = renderNested(details, "result") ?? renderNested(details, "synthesis") ?? details;
	return [
		["Exit", renderNumber(child, "exitCode")],
		["Stop", renderString(child, "stopReason")],
		["Output", renderString(details, "outputArtifactPath") ?? renderString(details, "finalSummaryPath") ?? renderString(details, "outputPath") ?? renderString(child, "outputPath")],
		["Transcript", renderString(child, "transcriptPath")],
		["Stderr", renderString(child, "stderrPath")],
	];
}

function createCallRenderer(title: string, fieldsForArgs: (args: Record<string, unknown> | undefined) => RenderField[]) {
	return (args: unknown, theme: any) => renderToolText(theme, title, fieldsForArgs(asRecord(args)));
}

function createResultRenderer(title: string, summarize: (details: Record<string, unknown> | undefined, result: Record<string, unknown> | undefined) => ToolRenderSummary) {
	return (result: unknown, options: unknown, theme: any) => {
		const resultRecord = asRecord(result);
		const details = renderNested(resultRecord, "details");
		const summary = summarize(details, resultRecord);
		const optionRecord = asRecord(options);
		const expanded = renderBoolean(optionRecord, "expanded") === true;
		const content = expanded ? resultContentText(resultRecord) : undefined;
		const summaryDetails = summary.details ?? [];
		const progressDetails = renderSubagentProgressDetails(details, content);
		const toolTreeDetails = expanded ? renderExpandedToolCallTree(details) : [];
		const contentIsProgressOnly = content?.trimStart().startsWith("Subagents:") === true;
		const hasNonProgressContent = Boolean(content && !contentIsProgressOnly);
		const hasNonProgressSummary = summary.fields.some(hasRenderableField) || summaryDetails.some((detail) => detail.trim()) || hasNonProgressContent;
		const renderedTitle = hasNonProgressSummary ? title : undefined;
		return renderToolText(theme, renderedTitle, summary.fields, [...summaryDetails, ...progressDetails, ...toolTreeDetails, ...(content ? ["", content] : [])], summary.status ?? "success");
	};
}

export const renderOrchestratorCall = createCallRenderer("Run Orchestrator", (args) => [["Plan", previewValue(args?.plan)]]);
export const renderReviewersCall = createCallRenderer("Run Reviewers", (args) => [["Target", previewValue(args?.target)], ["Focus", previewValue(args?.focus, undefined)], ["Reviewers", renderArrayLength(args, "reviewers")], ["Scout", args?.includeScout === false ? "disabled" : "enabled"]]);
export const renderScoutCall = createCallRenderer("Run Scout", (args) => [["Task", previewValue(args?.task)], ["Output", renderString(args, "outputFile")]]);
export const renderWorkerCall = createCallRenderer("Run Worker", (args) => [["Purpose", renderString(args, "purpose") ?? "implementation"], ["Task", previewValue(args?.task)], ["Output", renderString(args, "outputFile")]]);
export const renderParallelWorkersCall = createCallRenderer("Run Workers Parallel", (args) => [["Workers", renderArrayLength(args, "tasks")]]);
export const renderRoleAgentCall = createCallRenderer("Run Role Agent", (args) => [["Role", renderString(args, "role")], ["Purpose", renderString(args, "purpose")], ["Worker", renderString(args, "workerId")], ["Task", previewValue(args?.task)], ["Output", renderString(args, "outputFile")]]);
export const renderArtifactCall = createCallRenderer("Write Run Artifact", (args) => [["Path", renderString(args, "path")], ["Bytes", typeof args?.content === "string" ? Buffer.byteLength(args.content, "utf8") : undefined]]);
export const renderCompactCall = createCallRenderer("Compact Session", (args) => [["Instructions", previewValue(args?.instructions, "default role-aware summary")]]);
export const renderMarkReviewCleanCall = createCallRenderer("Mark Review Clean", (args) => [["Round", renderNumber(args, "round")], ["Summary", previewValue(args?.summary)]]);

export const renderOrchestratorResult = createResultRenderer("Orchestration", (details, result) => ({
	status: renderNumber(renderNested(details, "result"), "exitCode") === 0 ? "success" : renderBoolean(result, "isError") ? "error" : "pending",
	fields: [["Run dir", renderString(details, "runDir")], ["Plan source", renderString(details, "planSource")], ...childRunFields(details), ["Cleanup", renderString(details, "cleanupSummary")]],
}));

export const renderReviewersResult = createResultRenderer("Review", (details, result) => ({
	status: renderNumber(renderNested(details, "synthesis"), "exitCode") === 0 ? "success" : renderBoolean(result, "isError") ? "error" : "pending",
	fields: [["Run dir", renderString(details, "runDir")], ["Target", renderString(details, "targetSource")], ["Reviews", renderArrayLength(details, "reviews")], ["Failures", renderArrayLength(details, "reviewFailures")], ["Final summary", renderString(details, "finalSummaryPath")], ["Transcript", renderString(renderNested(details, "synthesis"), "transcriptPath")], ["Cleanup", renderString(details, "cleanupSummary")]],
}));

export const renderScoutResult = createResultRenderer("Scout", (details, result) => ({
	status: renderNumber(renderNested(details, "result"), "exitCode") === 0 ? "success" : renderBoolean(result, "isError") ? "error" : "pending",
	fields: [["Run dir", renderString(details, "runDir")], ["Task source", renderString(details, "taskSource")], ...childRunFields(details), ["Cleanup", renderString(details, "cleanupSummary")]],
}));

export const renderWorkerResult = createResultRenderer("Worker", (details, result) => ({
	status: renderNumber(renderNested(details, "result"), "exitCode") === 0 ? "success" : renderBoolean(result, "isError") ? "error" : "pending",
	fields: [["Run dir", renderString(details, "runDir")], ["Task source", renderString(details, "taskSource")], ["Purpose", renderString(details, "purpose")], ...childRunFields(details), ["Cleanup", renderString(details, "cleanupSummary")]],
}));

export const renderParallelWorkersResult = createResultRenderer("Parallel Workers", (details, result) => ({
	status: renderArrayLength(details, "failed") && renderArrayLength(details, "failed")! > 0 ? "error" : renderBoolean(result, "isError") ? "error" : "success",
	fields: [["Run dir", renderString(details, "runDir")], ["Workers", renderArrayLength(details, "workers")], ["Failed", renderArrayLength(details, "failed")], ["Cleanup", renderString(details, "cleanupSummary")]],
	details: Array.isArray(details?.workers) ? details.workers.slice(0, 6).flatMap((worker, index) => {
		const record = asRecord(worker);
		return [`${index + 1}. ${renderString(record, "name") ?? "worker"}: ${renderString(record, "outputArtifactPath") ?? "no output artifact"}`];
	}) : [],
}));

export const renderRoleAgentResult = createResultRenderer("Role Agent", (details, result) => ({
	status: renderNumber(details, "exitCode") === 0 ? "success" : renderBoolean(result, "isError") ? "error" : "pending",
	fields: [["Purpose", renderString(details, "purpose")], ["Worker", renderString(details, "workerId")], ["Round", renderNumber(details, "round")], ...childRunFields(details), ["Worker runs", renderNumber(details, "workerRuns")], ["Review runs", renderNumber(details, "reviewRuns")]],
}));

export const renderArtifactResult = createResultRenderer("Run Artifact", (details) => ({ status: "success", fields: [["Path", renderString(details, "path")]] }));
export const renderCompactResult = createResultRenderer("Compaction", (details) => ({ status: renderBoolean(details, "requested") ? "success" : "pending", fields: [["Requested", renderBoolean(details, "requested")], ["Run dir", renderString(details, "runDir")]] }));
export const renderMarkReviewCleanResult = createResultRenderer("Review Clean", (details) => ({ status: "success", fields: [["Artifact", renderString(details, "path")], ["State", renderString(details, "statePath")], ["Worker runs", renderNumber(details, "workerRuns")], ["Review runs", renderNumber(details, "reviewRuns")]] }));
