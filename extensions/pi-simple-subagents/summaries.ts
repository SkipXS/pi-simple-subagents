import { formatSubagentProgress, type SubagentProgressSnapshot } from "./progress.ts";

function verboseResultsRequested(includeOutput?: boolean): boolean {
	if (includeOutput === true) return true;
	return /^(1|true|yes|on)$/i.test(process.env.PI_SIMPLE_SUBAGENTS_VERBOSE_RESULTS ?? "") || /^(1|true|yes|on)$/i.test(process.env.PI_DEBUG ?? "");
}

function outputLocationNote(kind: string): string {
	return `Full ${kind} output is preserved in the artifact paths above. To include it inline, set includeOutput=true on the tool call or PI_SIMPLE_SUBAGENTS_VERBOSE_RESULTS=1.`;
}

export function childSummary(prefix: string, fields: Array<[string, string | number | undefined]>, output: string, options: { kind?: string; includeOutput?: boolean; subagentProgress?: SubagentProgressSnapshot } = {}): string {
	const lines = [prefix, ...fields.flatMap(([label, value]) => value === undefined || value === "" ? [] : [`${label}: ${value}`])];
	const progress = options.subagentProgress && options.subagentProgress.statuses.length > 0 ? `\n\n${formatSubagentProgress(options.subagentProgress)}` : "";
	const header = `${lines.join("\n")}${progress}`;
	if (verboseResultsRequested(options.includeOutput)) return `${header}\n\n${output}`;
	return `${header}\n\n${outputLocationNote(options.kind ?? "child")}`;
}
