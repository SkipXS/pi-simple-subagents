import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupRunArtifacts, clearRunActive, ensureDir, formatArtifactCleanupResult, markRunActive, resolveRunBaseDir, runId, validateOutputArtifactPath, writeArtifact, type ArtifactCleanupResult } from "./artifacts.ts";
import { childResultText, spawnPiRole, throwChildRunError, type ChildRunResult, type ChildStatusUpdate } from "./child-runner.ts";
import { CONFIG_EFFECTIVE_FILE, DEFAULT_SCOUT_OUTPUT_FILE, DEFAULT_WORKER_OUTPUT_FILE, EXTRA_REVIEW_CONTEXT_FILE, FINAL_SUMMARY_FILE, IMPROVE_LOOP_SUMMARY_FILE, INPUT_SCOUT_TASK_FILE, INPUT_TARGET_FILE, INPUT_WORKER_TASK_FILE, PARALLEL_WORKERS_FILE, PARALLEL_WORKERS_SUMMARY_FILE, REVIEW_FAILURE_SUMMARY_FILE, SCOUT_REVIEW_CONTEXT_FILE } from "./constants.ts";
import { loadConfig, type Config } from "./config.ts";
import { reviewTargetSystemPrompt } from "./prompts.ts";
import { formatReferenceWarnings, readPlanReference, readReference } from "./references.ts";
import { DEFAULT_REVIEW_ANGLES } from "./roles.ts";
import type { ImproveLoopParams, ReviewersParams, ScoutParams, WorkerParams, WorkersParallelParams, WorkersParallelTaskParams } from "./schemas.ts";

type WorkflowUpdate = (text: string, status?: ChildStatusUpdate) => void;

export interface WorkflowDeps {
	loadConfig?: typeof loadConfig;
	readPlanReference?: typeof readPlanReference;
	readReference?: typeof readReference;
	spawnPiRole?: typeof spawnPiRole;
	existsSync?: typeof fs.existsSync;
}

const MAX_REVIEWERS = 8;

const defaultWorkflowDeps: Required<WorkflowDeps> = {
	loadConfig,
	readPlanReference,
	readReference,
	spawnPiRole,
	existsSync: fs.existsSync,
};

function workflowDeps(overrides?: WorkflowDeps): Required<WorkflowDeps> {
	return { ...defaultWorkflowDeps, ...(overrides ?? {}) };
}

function formatRunTask(planText: string, planSource: string, runDir: string, warnings: readonly string[] = []): string {
	return `Run directory: ${runDir}\nPlan source: ${planSource}${formatReferenceWarnings(warnings)}\n\nPlan / instruction:\n${planText}\n\nStart by writing orchestration.md. Then follow the orchestrator workflow. If the plan is unclear, stop and ask the user for clarification instead of guessing.`;
}

function tokenizeCommand(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else if (char === "\\" && quote === "\"" && index + 1 < input.length) {
				const next = input[index + 1];
				if (next === "\"" || next === "\\") {
					current += next;
					index++;
				} else {
					current += char;
				}
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote) throw new Error(`/review has unmatched ${quote === "\"" ? "double" : "single"} quote`);
	if (current) tokens.push(current);
	return tokens;
}

function quoteTargetIfNeeded(target: string): string {
	if (!target.startsWith("@") || !/\s/.test(target)) return target;
	return `@"${target.slice(1).replace(/"/g, "\\\"")}"`;
}

function safePathLabel(value: string | undefined, fallback: string): string {
	return (value ?? fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || fallback;
}

function forwardChildStatus(onUpdate: WorkflowUpdate | undefined): (status: ChildStatusUpdate) => void {
	return (status) => onUpdate?.("", status);
}

function requireNonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must be a non-empty string`);
	return trimmed;
}

function fanoutConcurrency(config: Config, itemCount: number): number {
	return Math.max(1, Math.min(itemCount, config.children.maxConcurrentSubagents));
}

async function allSettledWithConcurrency<T>(count: number, concurrency: number, run: (index: number) => Promise<T>, shouldStartMore: () => boolean = () => true): Promise<Array<PromiseSettledResult<T>>> {
	const settled = new Array<PromiseSettledResult<T>>(count);
	let next = 0;
	let active = 0;
	return await new Promise<Array<PromiseSettledResult<T>>>((resolve) => {
		const finishSkipped = () => {
			while (next < count) {
				settled[next++] = { status: "rejected", reason: new Error("not started because a sibling subagent failed or the run was aborted") };
			}
		};
		const pump = () => {
			if (!shouldStartMore()) finishSkipped();
			while (active < concurrency && next < count && shouldStartMore()) {
				const index = next++;
				active++;
				Promise.resolve(run(index)).then(
					(value) => { settled[index] = { status: "fulfilled", value }; },
					(reason) => { settled[index] = { status: "rejected", reason }; },
				).finally(() => {
					active--;
					if (next >= count && active === 0) resolve(settled);
					else pump();
				});
			}
			if (next >= count && active === 0) resolve(settled);
		};
		pump();
	});
}

async function runFanout<T>(input: {
	count: number;
	concurrency: number;
	signal?: AbortSignal;
	abortOnError: boolean;
	run: (index: number, signal: AbortSignal) => Promise<T>;
}): Promise<Array<PromiseSettledResult<T>>> {
	const localAbort = new AbortController();
	const forwardAbort = () => localAbort.abort(input.signal?.reason);
	if (input.signal) {
		if (input.signal.aborted) forwardAbort();
		else input.signal.addEventListener("abort", forwardAbort, { once: true });
	}
	try {
		return await allSettledWithConcurrency(input.count, input.concurrency, async (index) => {
			try {
				return await input.run(index, localAbort.signal);
			} catch (error) {
				if (input.abortOnError && !localAbort.signal.aborted) localAbort.abort(error);
				throw error;
			}
		}, () => !localAbort.signal.aborted);
	} finally {
		if (input.signal) input.signal.removeEventListener("abort", forwardAbort);
	}
}

export function assertWorkerTaskWithinBudget(taskText: string, source: string, config: Config, label = "worker task"): void {
	const limit = config.orchestration.maxWorkerTaskBytes;
	if (limit === 0) return;
	const bytes = Buffer.byteLength(taskText, "utf8");
	if (bytes <= limit) return;
	throw new Error(`${label} is ${bytes} bytes, exceeding orchestration.maxWorkerTaskBytes=${limit}. This usually means an entire milestone, broad plan section, or multiple deliverables were delegated to one worker. Split it into a smaller work package (one concrete deliverable, 1-3 likely files, 3-5 acceptance criteria, explicit non-goals, and one validation check), or set orchestration.maxWorkerTaskBytes=0/increase it intentionally. Task source: ${source}`);
}

function requireExpectedArtifact(dep: Required<WorkflowDeps>, runDir: string, outputFile: string, result: ChildRunResult, label: string): string {
	const target = validateOutputArtifactPath(runDir, outputFile);
	if (!dep.existsSync(target)) {
		throw new Error(`${label} did not write the expected output artifact.\nExpected output artifact: ${outputFile}\nExpected path: ${target}\nRun dir: ${runDir}\nChild output log: ${result.outputPath}\nTranscript: ${result.transcriptPath}\nUse write_run_artifact with path ${JSON.stringify(outputFile)}; do not write artifacts via absolute paths or the generic write tool.`);
	}
	return validateOutputArtifactPath(runDir, outputFile);
}

function unknownOptionError(command: string, token: string): Error {
	return new Error(`${command} unknown option: ${token}`);
}

export function parseReviewTargetCommand(input: string): ReviewersParams {
	const trimmed = input.trim();
	const tokens = tokenizeCommand(trimmed);
	const reviewers: string[] = [];
	let includeScout: boolean | undefined;
	let continueOnReviewerFailure: boolean | undefined;
	let extraContext: string | undefined;
	let cursor = 0;
	while (cursor < tokens.length) {
		const token = tokens[cursor];
		if (token === "--") {
			cursor++;
			break;
		}
		if (token === "--no-scout") {
			includeScout = false;
			cursor++;
			continue;
		}
		if (token === "--scout") {
			includeScout = true;
			cursor++;
			continue;
		}
		if (token === "--continue-on-reviewer-failure") {
			continueOnReviewerFailure = true;
			cursor++;
			continue;
		}
		if (token === "--fail-on-reviewer-failure") {
			continueOnReviewerFailure = false;
			cursor++;
			continue;
		}
		if (token === "--reviewer") {
			const reviewer = tokens[cursor + 1];
			if (!reviewer) throw new Error("/review --reviewer requires an angle/focus value");
			reviewers.push(reviewer);
			cursor += 2;
			continue;
		}
		if (token === "--context") {
			const context = tokens[cursor + 1];
			if (!context) throw new Error("/review --context requires an inline value or @file");
			extraContext = context;
			cursor += 2;
			continue;
		}
		if (token.startsWith("--reviewer=")) {
			const reviewer = token.slice("--reviewer=".length).trim();
			if (!reviewer) throw new Error("/review --reviewer requires an angle/focus value");
			reviewers.push(reviewer);
			cursor++;
			continue;
		}
		if (token.startsWith("--context=")) {
			const context = token.slice("--context=".length).trim();
			if (!context) throw new Error("/review --context requires an inline value or @file");
			extraContext = context;
			cursor++;
			continue;
		}
		if (token.startsWith("--")) throw unknownOptionError("/review", token);
		break;
	}
	if (tokens[0]?.startsWith("--") && cursor === 0) throw unknownOptionError("/review", tokens[0]);
	if (cursor > 0) {
		const target = tokens[cursor];
		if (!target) throw new Error("/review requires a target after options");
		if (target.startsWith("--") && tokens[cursor - 1] !== "--") throw unknownOptionError("/review", target);
		const focus = tokens.slice(cursor + 1).join(" ").trim();
		return {
			target: quoteTargetIfNeeded(target),
			...(focus ? { focus } : {}),
			...(extraContext !== undefined ? { extraContext: quoteTargetIfNeeded(extraContext) } : {}),
			...(reviewers.length > 0 ? { reviewers } : {}),
			...(includeScout !== undefined ? { includeScout } : {}),
			...(continueOnReviewerFailure !== undefined ? { continueOnReviewerFailure } : {}),
		};
	}
	const match = /^(@(?:"[^"]+"|'[^']+'|\S+))(?:\s+([\s\S]+))?$/.exec(trimmed);
	if (!match) return { target: trimmed };
	const focus = match[2]?.trim();
	return focus ? { target: match[1], focus } : { target: match[1] };
}

const IMPROVE_LOOP_MIN_SEVERITIES = ["blocker", "high", "medium", "low", "optional"] as const;
type FindingSeverity = typeof IMPROVE_LOOP_MIN_SEVERITIES[number];
const SEVERITY_RANK: Record<FindingSeverity, number> = { optional: 0, low: 1, medium: 2, high: 3, blocker: 4 };

export interface ImproveLoopFinding {
	id: string;
	title: string;
	severity: FindingSeverity;
	category?: string;
	evidence?: string;
	recommendation?: string;
}

function normalizeSeverity(value: string | undefined, label = "minSeverity"): FindingSeverity {
	const normalized = value?.trim().toLowerCase();
	if (!normalized || !(IMPROVE_LOOP_MIN_SEVERITIES as readonly string[]).includes(normalized)) throw new Error(`${label} must be one of ${IMPROVE_LOOP_MIN_SEVERITIES.join(", ")}`);
	return normalized as FindingSeverity;
}

function normalizeFinding(raw: unknown, index: number): ImproveLoopFinding | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const item = raw as Record<string, unknown>;
	const severity = typeof item.severity === "string" ? normalizeSeverity(item.severity, `finding ${index + 1} severity`) : undefined;
	if (!severity) return undefined;
	const titleValue = item.title ?? item.id ?? item.summary;
	const title = typeof titleValue === "string" ? titleValue.trim() : "";
	if (!title) return undefined;
	const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `finding-${index + 1}`;
	return {
		id,
		title,
		severity,
		...(typeof item.category === "string" && item.category.trim() ? { category: item.category.trim() } : {}),
		...(typeof item.evidence === "string" && item.evidence.trim() ? { evidence: item.evidence.trim() } : {}),
		...(typeof item.recommendation === "string" && item.recommendation.trim() ? { recommendation: item.recommendation.trim() } : {}),
	};
}

function parseJsonFindings(markdown: string): ImproveLoopFinding[] {
	const candidates: string[] = [];
	for (const match of markdown.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
	candidates.push(markdown.trim());
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			const rawFindings = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { findings?: unknown }).findings) ? (parsed as { findings: unknown[] }).findings : undefined;
			if (rawFindings) return rawFindings.flatMap((finding, index) => normalizeFinding(finding, index) ?? []);
		} catch { /* try the next candidate */ }
	}
	return [];
}

function extractLabeledValue(text: string, labels: readonly string[]): string | undefined {
	for (const label of labels) {
		const match = new RegExp(`${label}\\s*:\\s*([^\\n]+)`, "i").exec(text);
		if (match?.[1]?.trim()) return match[1].trim();
	}
	return undefined;
}

function stripMarkdownEmphasis(value: string): string {
	return value.replace(/^\*\*|\*\*$/g, "").trim();
}

function splitInlineFindingTitle(value: string): { severity?: FindingSeverity; title: string } {
	const cleaned = stripMarkdownEmphasis(value);
	const match = /^(?:\*\*)?(blocker|high|medium|low|optional)(?:\*\*)?\s*(?:[:\]-]|—|–)\s*([\s\S]+)$/i.exec(cleaned);
	if (!match) return { title: cleaned };
	return { severity: normalizeSeverity(match[1], "inline finding severity"), title: stripMarkdownEmphasis(match[2]).replace(/^\*\*|\*\*/g, "").trim() };
}

function sectionSeverity(heading: string): FindingSeverity | undefined {
	const normalized = heading.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	if (/^blockers?$/.test(normalized)) return "blocker";
	if (normalized.includes("fixes worth doing now") || normalized.includes("fixes now") || normalized.includes("actionable")) return "medium";
	if (normalized.includes("optional") || normalized.includes("deferred")) return "optional";
	return undefined;
}

function isEmptyFindingText(value: string): boolean {
	return /^(none|none\.|no findings?\.?|n\/a)$/i.test(stripMarkdownEmphasis(value));
}

function findingFromText(text: string, fallbackSeverity: FindingSeverity | undefined, index: number): ImproveLoopFinding | undefined {
	const titleText = text.split(/\r?\n/)[0].replace(/\s+(?:Evidence|Recommendation|Fix|Category)\s*:.+$/i, "").trim();
	const { severity = fallbackSeverity, title } = splitInlineFindingTitle(titleText);
	if (!severity || !title || isEmptyFindingText(title)) return undefined;
	return {
		id: `finding-${index + 1}`,
		title: title.replace(/\s+/g, " ").trim(),
		severity,
		...(extractLabeledValue(text, ["category"]) ? { category: extractLabeledValue(text, ["category"]) } : {}),
		...(extractLabeledValue(text, ["evidence"]) ? { evidence: extractLabeledValue(text, ["evidence"]) } : {}),
		...(extractLabeledValue(text, ["recommendation", "fix"]) ? { recommendation: extractLabeledValue(text, ["recommendation", "fix"]) } : {}),
	};
}

export function extractImproveLoopFindings(markdown: string): ImproveLoopFinding[] {
	const fromJson = parseJsonFindings(markdown);
	if (fromJson.length > 0) return fromJson;
	const findings: ImproveLoopFinding[] = [];
	const lines = markdown.split(/\r?\n/);
	let currentSectionSeverity: FindingSeverity | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line);
		if (heading) {
			currentSectionSeverity = sectionSeverity(heading[1]);
			continue;
		}
		const bullet = /^(?:[-*]|\d+\.)\s+([\s\S]+)$/.exec(line);
		if (bullet && currentSectionSeverity) {
			const continuation: string[] = [];
			for (let lookahead = index + 1; lookahead < lines.length; lookahead++) {
				const next = lines[lookahead];
				if (/^\s*(?:[-*]|\d+\.)\s+/.test(next) || /^#{1,6}\s+/.test(next)) break;
				if (next.trim()) continuation.push(next.trim());
			}
			const finding = findingFromText([bullet[1], ...continuation].join("\n"), currentSectionSeverity, findings.length);
			if (finding) findings.push(finding);
			continue;
		}
		const finding = findingFromText(line, undefined, findings.length);
		if (finding) {
			const following = lines.slice(index + 1, Math.min(lines.length, index + 6)).join("\n");
			findings.push({
				...finding,
				...(finding.category ? {} : extractLabeledValue(following, ["category"]) ? { category: extractLabeledValue(following, ["category"]) } : {}),
				...(finding.evidence ? {} : extractLabeledValue(following, ["evidence"]) ? { evidence: extractLabeledValue(following, ["evidence"]) } : {}),
				...(finding.recommendation ? {} : extractLabeledValue(following, ["recommendation", "fix"]) ? { recommendation: extractLabeledValue(following, ["recommendation", "fix"]) } : {}),
			});
		}
	}
	return findings;
}

function findingFingerprint(finding: ImproveLoopFinding): string {
	return `${finding.severity}:${finding.category ?? ""}:${finding.title}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function actionableFindings(findings: readonly ImproveLoopFinding[], minSeverity: FindingSeverity): ImproveLoopFinding[] {
	return findings.filter((finding) => finding.severity !== "optional" && SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[minSeverity] && typeof finding.evidence === "string" && finding.evidence.trim() !== "");
}

function actionableFingerprints(findings: readonly ImproveLoopFinding[], minSeverity: FindingSeverity): string[] {
	return actionableFindings(findings, minSeverity).map(findingFingerprint).sort();
}

function sameFingerprints(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseIntegerOption(value: string, label: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer`);
	return Number(value);
}

export function parseImproveLoopCommand(input: string): ImproveLoopParams {
	const tokens = tokenizeCommand(input.trim());
	const params: ImproveLoopParams = {};
	let cursor = 0;
	while (cursor < tokens.length) {
		const token = tokens[cursor];
		if (token === "--") { cursor++; break; }
		if (token === "--no-scout") { params.includeScout = false; cursor++; continue; }
		if (token === "--scout") { params.includeScout = true; cursor++; continue; }
		if (token === "--continue-on-reviewer-failure") { params.continueOnReviewerFailure = true; cursor++; continue; }
		if (token === "--fail-on-reviewer-failure") { params.continueOnReviewerFailure = false; cursor++; continue; }
		if (token === "--auto-fix" || token === "--autofix") { params.autoFix = true; cursor++; continue; }
		if (token === "--no-auto-fix" || token === "--no-autofix") { params.autoFix = false; cursor++; continue; }
		if (token === "--reviewer" || token === "--context" || token === "--max-rounds" || token === "--min-severity" || token === "--target" || token === "--plan" || token === "--reference") {
			const value = tokens[cursor + 1];
			if (!value) throw new Error(`/improve-loop ${token} requires a value`);
			if (token === "--reviewer") params.reviewers = [...(params.reviewers ?? []), value];
			if (token === "--context") params.extraContext = value;
			if (token === "--max-rounds") params.maxRounds = parseIntegerOption(value, "/improve-loop --max-rounds");
			if (token === "--min-severity") params.minSeverity = normalizeSeverity(value, "/improve-loop --min-severity");
			if (token === "--target") params.target = quoteTargetIfNeeded(value);
			if (token === "--plan") params.plan = quoteTargetIfNeeded(value);
			if (token === "--reference") params.reference = quoteTargetIfNeeded(value);
			cursor += 2;
			continue;
		}
		if (token.startsWith("--reviewer=")) { params.reviewers = [...(params.reviewers ?? []), token.slice("--reviewer=".length)]; cursor++; continue; }
		if (token.startsWith("--context=")) { params.extraContext = token.slice("--context=".length); cursor++; continue; }
		if (token.startsWith("--max-rounds=")) { params.maxRounds = parseIntegerOption(token.slice("--max-rounds=".length), "/improve-loop --max-rounds"); cursor++; continue; }
		if (token.startsWith("--min-severity=")) { params.minSeverity = normalizeSeverity(token.slice("--min-severity=".length), "/improve-loop --min-severity"); cursor++; continue; }
		if (token.startsWith("--target=")) { params.target = quoteTargetIfNeeded(token.slice("--target=".length)); cursor++; continue; }
		if (token.startsWith("--plan=")) { params.plan = quoteTargetIfNeeded(token.slice("--plan=".length)); cursor++; continue; }
		if (token.startsWith("--reference=")) { params.reference = quoteTargetIfNeeded(token.slice("--reference=".length)); cursor++; continue; }
		if (token.startsWith("--")) throw unknownOptionError("/improve-loop", token);
		break;
	}
	const target = tokens[cursor];
	if (target) params.target = quoteTargetIfNeeded(target);
	if (!params.target && !params.plan && !params.reference) throw new Error("/improve-loop requires a target, plan, or reference after options");
	const focus = target ? tokens.slice(cursor + 1).join(" ").trim() : tokens.slice(cursor).join(" ").trim();
	if (focus) params.focus = focus;
	return params;
}

export async function runOrchestrator(cwd: string, rawPlan: string, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps): Promise<{ result: ChildRunResult; runDir: string; planSource: string } & CleanupRecord> {
	const dep = workflowDeps(deps);
	const planInput = requireNonEmpty(rawPlan, "orchestration plan");
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	markRunActive(dir);
	try {
		const cleanupRecord = runConfiguredArtifactCleanup(baseDir, config, dir);
		const { planText, planSource, warnings } = dep.readPlanReference(cwd, planInput, config);
		writeArtifact(dir, "input-plan.md", `Source: ${planSource}${formatReferenceWarnings(warnings)}

${planText}
`);
		writeArtifact(dir, CONFIG_EFFECTIVE_FILE, JSON.stringify(config, null, 2));
		const task = formatRunTask(planText, planSource, dir, warnings);
		const result = await dep.spawnPiRole({ cwd, role: "orchestrator", task, runDir: dir, config, signal, onUpdate, onStatus: forwardChildStatus(onUpdate), statusKey: "subagent:orchestrator", statusLabel: "orchestrator" });
		return { result, runDir: dir, planSource, ...cleanupRecord };
	} finally {
		clearRunActive(dir);
	}
}

interface CleanupRecord {
	cleanup?: ArtifactCleanupResult;
	cleanupSummary?: string;
}

function runConfiguredArtifactCleanup(baseDir: string, config: Config, activeRunDir: string): CleanupRecord {
	const cleanup = cleanupRunArtifacts(baseDir, config, activeRunDir);
	return cleanup ? { cleanup, cleanupSummary: formatArtifactCleanupResult(cleanup) } : {};
}

interface ScoutRunRecord extends CleanupRecord {
	runDir: string;
	taskSource: string;
	result: ChildRunResult;
	outputArtifactPath: string;
}

export async function runScout(cwd: string, params: ScoutParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps): Promise<ScoutRunRecord> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	markRunActive(dir);
	try {
		const cleanupRecord = runConfiguredArtifactCleanup(baseDir, config, dir);
		const taskInput = requireNonEmpty(params.task, "scout task");
		const scoutTask = dep.readReference(cwd, taskInput, "scout task", config, { allowDirectory: true });
		const outputFile = params.outputFile?.trim() || DEFAULT_SCOUT_OUTPUT_FILE;
		const outputArtifactPath = validateOutputArtifactPath(dir, outputFile);
		const referenceWarningText = formatReferenceWarnings(scoutTask.warnings);
		writeArtifact(dir, INPUT_SCOUT_TASK_FILE, `Source: ${scoutTask.source}\nExpected output artifact: ${outputFile}${referenceWarningText}\n\n${scoutTask.text}\n`);
		writeArtifact(dir, CONFIG_EFFECTIVE_FILE, JSON.stringify(config, null, 2));
		const task = `Scout task source: ${scoutTask.source}\nExpected output artifact: ${outputFile}${referenceWarningText}\nRun directory: ${dir}\nRead input-scout-task.md, gather relevant context, inspect files directly when useful, and write the expected output artifact with write_run_artifact using path ${JSON.stringify(outputFile)}. Do not use absolute paths or the generic write tool for the handoff artifact. Do not implement changes. Do not intentionally modify project/source files; if a command may write generated output, prefer read-only alternatives or explain the risk before running it. Produce a compact handoff for the parent agent.`;
		const result = await dep.spawnPiRole({ cwd, role: "scout", task, runDir: dir, config, signal, onUpdate: (text) => onUpdate?.(`scout: ${text}`), onStatus: forwardChildStatus(onUpdate), statusKey: "subagent:scout", statusLabel: "scout" });
		if (result.exitCode !== 0) throwChildRunError("scout failed", result);
		requireExpectedArtifact(dep, dir, outputFile, result, "scout");
		return { runDir: dir, taskSource: scoutTask.source, result: { ...result, outputPath: outputArtifactPath }, outputArtifactPath, ...cleanupRecord };
	} finally {
		clearRunActive(dir);
	}
}

type WorkerPurpose = NonNullable<WorkerParams["purpose"]>;

interface WorkerRunRecord extends CleanupRecord {
	name: string;
	runDir: string;
	taskSource: string;
	result: ChildRunResult;
	outputArtifactPath: string;
	purpose: WorkerPurpose;
}

interface PreparedWorkerTask {
	name: string;
	purpose: WorkerPurpose;
	text: string;
	source: string;
	warnings: readonly string[];
	outputFile: string;
	outputArtifactPath: string;
}

function prepareWorkerTask(cwd: string, dir: string, params: WorkerParams | WorkersParallelTaskParams, config: Config, dep: Required<WorkflowDeps>, progressLabel = "worker", taskLabel = "worker task"): PreparedWorkerTask {
	const taskInput = requireNonEmpty(params.task, taskLabel);
	const workerTask = dep.readReference(cwd, taskInput, taskLabel, config, { allowDirectory: true });
	assertWorkerTaskWithinBudget(workerTask.text, workerTask.source, config, `${progressLabel} task`);
	const purpose: WorkerPurpose = params.purpose ?? "implementation";
	const outputFile = params.outputFile?.trim() || DEFAULT_WORKER_OUTPUT_FILE;
	const outputArtifactPath = validateOutputArtifactPath(dir, outputFile);
	const name = "name" in params && params.name?.trim() ? params.name.trim() : progressLabel;
	return { name, purpose, text: workerTask.text, source: workerTask.source, warnings: workerTask.warnings, outputFile, outputArtifactPath };
}

async function runWorkerInDir(cwd: string, dir: string, params: WorkerParams | WorkersParallelTaskParams, signal: AbortSignal | undefined, onUpdate: WorkflowUpdate | undefined, progressLabel = "worker", deps?: WorkflowDeps, prepared?: PreparedWorkerTask): Promise<WorkerRunRecord> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	ensureDir(dir);
	const workerTask = prepared ?? prepareWorkerTask(cwd, dir, params, config, dep, progressLabel);
	const referenceWarningText = formatReferenceWarnings(workerTask.warnings);
	writeArtifact(dir, INPUT_WORKER_TASK_FILE, `Source: ${workerTask.source}\nName: ${workerTask.name}\nPurpose: ${workerTask.purpose}\nExpected output artifact: ${workerTask.outputFile}${referenceWarningText}\n\n${workerTask.text}\n`);
	writeArtifact(dir, CONFIG_EFFECTIVE_FILE, JSON.stringify(config, null, 2));
	const task = `Worker task source: ${workerTask.source}\nName: ${workerTask.name}\nPurpose: ${workerTask.purpose}\nExpected output artifact: ${workerTask.outputFile}${referenceWarningText}\nRun directory: ${dir}\nRead input-worker-task.md, perform the requested work, run useful checks, and write the expected output artifact with write_run_artifact using path ${JSON.stringify(workerTask.outputFile)}. Do not use absolute paths or the generic write tool for the handoff artifact. If running as part of a parallel worker batch, stay within the assigned task and avoid editing files likely owned by sibling workers. If a product, architecture, or scope decision is missing, stop and report it instead of guessing.`;
	const result = await dep.spawnPiRole({ cwd, role: "worker", task, runDir: dir, config, signal, onUpdate: (text) => onUpdate?.(`${progressLabel}: ${text}`), onStatus: forwardChildStatus(onUpdate), statusKey: `subagent:${safePathLabel(progressLabel, "worker")}`, statusLabel: progressLabel });
	if (result.exitCode === 0) requireExpectedArtifact(dep, dir, workerTask.outputFile, result, `worker ${workerTask.name}`);
	return { name: workerTask.name, runDir: dir, taskSource: workerTask.source, result: { ...result, outputPath: result.exitCode === 0 ? workerTask.outputArtifactPath : result.outputPath }, outputArtifactPath: workerTask.outputArtifactPath, purpose: workerTask.purpose };
}

export async function runWorker(cwd: string, params: WorkerParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps): Promise<WorkerRunRecord> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	markRunActive(dir);
	try {
		const cleanupRecord = runConfiguredArtifactCleanup(baseDir, config, dir);
		const record = await runWorkerInDir(cwd, dir, params, signal, onUpdate, "worker", dep);
		if (record.result.exitCode !== 0) throwChildRunError("worker failed", record.result);
		return { ...record, ...cleanupRecord };
	} finally {
		clearRunActive(dir);
	}
}

export async function runWorkersParallel(cwd: string, params: WorkersParallelParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps): Promise<{ runDir: string; workers: WorkerRunRecord[]; failed: WorkerRunRecord[] } & CleanupRecord> {
	if (params.tasks.length < 2 || params.tasks.length > 8) throw new Error("run_workers_parallel requires 2-8 tasks");
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());

	ensureDir(dir);
	markRunActive(dir);
	try {
		// Resolve references/output paths before spawning any children so setup errors do not leave siblings running.
		// Prepared task content is reused at launch time so @ references are read exactly once per task.
		const preparedTasks = params.tasks.map((task, index) => {
			const label = safePathLabel(task.name, `worker-${index + 1}`);
			const workerDir = path.join(dir, `${String(index + 1).padStart(2, "0")}-${label}`);
			return {
				params: task,
				workerDir,
				progress: `worker ${index + 1}/${params.tasks.length}${task.name ? ` ${task.name}` : ""}`,
				prepared: prepareWorkerTask(cwd, workerDir, task, config, dep, `worker ${index + 1}`, `worker ${index + 1} task`),
			};
		});

		const cleanupRecord = runConfiguredArtifactCleanup(baseDir, config, dir);
		writeArtifact(dir, PARALLEL_WORKERS_FILE, `# Parallel Workers\n\n${params.tasks.map((task, index) => `## Worker ${index + 1}: ${task.name?.trim() || `worker-${index + 1}`}\n\nPurpose: ${task.purpose ?? "implementation"}\n\n${task.task}`).join("\n\n")}\n`);
		writeArtifact(dir, CONFIG_EFFECTIVE_FILE, JSON.stringify(config, null, 2));
		const concurrency = fanoutConcurrency(config, params.tasks.length);
		onUpdate?.(`parallel-workers: starting ${params.tasks.length} workers (max concurrency ${concurrency})`);
		const settled = await runFanout({
			count: preparedTasks.length,
			concurrency,
			signal,
			abortOnError: true,
			run: async (index, childSignal) => {
				const task = preparedTasks[index];
				return await runWorkerInDir(cwd, task.workerDir, task.params, childSignal, onUpdate, task.progress, dep, task.prepared);
			},
		});
		const workers = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
		const rejected = settled.flatMap((entry, index) => entry.status === "rejected" ? [{ index, reason: entry.reason }] : []);
		const failed = workers.filter((worker) => worker.result.exitCode !== 0);
		const summaryPath = writeArtifact(dir, PARALLEL_WORKERS_SUMMARY_FILE, `# Parallel Workers Summary\n\n${workers.map((worker, index) => `## Worker ${index + 1}: ${worker.name}\n\n- Exit code: ${worker.result.exitCode}\n- Run dir: ${worker.runDir}\n- Output: ${worker.outputArtifactPath}\n- Transcript: ${worker.result.transcriptPath}`).join("\n\n")}${rejected.length > 0 ? `\n\n## Setup/spawn errors\n\n${rejected.map((entry) => `- Worker ${entry.index + 1}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`).join("\n")}` : ""}\n`);
		if (rejected.length > 0) {
			throw new Error(`Parallel workers aborted after error(s): ${rejected.map((entry) => `worker ${entry.index + 1}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`).join("; ")}\nRun dir: ${dir}\nSummary: ${summaryPath}`);
		}
		if (failed.length > 0) {
			throw new Error(`Parallel workers failed: ${failed.map((worker) => `${worker.name} exit ${worker.result.exitCode}`).join(", ")}\nRun dir: ${dir}\nSummary: ${summaryPath}`);
		}
		return { runDir: dir, workers, failed, ...cleanupRecord };
	} finally {
		clearRunActive(dir);
	}
}

export async function runReviewers(cwd: string, params: ReviewersParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps): Promise<{ runDir: string; targetSource: string; extraContextSource?: string; scout?: ChildRunResult; reviews: ChildRunResult[]; reviewFailures?: string[]; reviewFailureSummaryPath?: string; synthesis: ChildRunResult; finalSummaryPath: string } & CleanupRecord> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	markRunActive(dir);
	try {
	const cleanupRecord = runConfiguredArtifactCleanup(baseDir, config, dir);
	const target = dep.readReference(cwd, requireNonEmpty(params.target, "review target"), "review target", config, { allowDirectory: true });
	const focus = params.focus?.trim() || "runtime bugs, security boundaries, API/UX, packaging, and maintainability";
	const referenceWarningText = formatReferenceWarnings(target.warnings);
	const extraContextInput = params.extraContext?.trim();
	const extraContext = extraContextInput ? dep.readReference(cwd, extraContextInput, "extra review context", config) : undefined;
	const extraContextWarningText = formatReferenceWarnings(extraContext?.warnings ?? []);
	const extraContextInstruction = extraContext ? `\nSupplemental context source: ${extraContext.source}${extraContextWarningText}\nUse extra-review-context.md as orientation only; verify it against the current target before trusting findings.` : "";
	if (params.reviewers && params.reviewers.length > MAX_REVIEWERS) throw new Error(`run_reviewers supports at most ${MAX_REVIEWERS} reviewers`);
	const reviewers = params.reviewers && params.reviewers.length > 0 ? params.reviewers.map((reviewer, index) => requireNonEmpty(reviewer, `reviewer ${index + 1}`)) : [...DEFAULT_REVIEW_ANGLES];
	writeArtifact(dir, INPUT_TARGET_FILE, `Source: ${target.source}\nFocus: ${focus}${referenceWarningText}\n\n${target.text}\n`);
	if (extraContext) writeArtifact(dir, EXTRA_REVIEW_CONTEXT_FILE, `Source: ${extraContext.source}${extraContextWarningText}\n\n${extraContext.text}\n`);
	writeArtifact(dir, CONFIG_EFFECTIVE_FILE, JSON.stringify(config, null, 2));

	let scout: ChildRunResult | undefined;
	if (params.includeScout ?? true) {
		onUpdate?.("review-target: scout running");
		scout = await dep.spawnPiRole({
			cwd,
			role: "scout",
			task: `Review target source: ${target.source}\nFocus: ${focus}${referenceWarningText}${extraContextInstruction}\nRun directory: ${dir}\nRead input-target.md${extraContext ? " and extra-review-context.md" : ""}, inspect the target directly, and write the expected output artifact with write_run_artifact using path ${JSON.stringify(SCOUT_REVIEW_CONTEXT_FILE)}. Do not use absolute paths or the generic write tool for the handoff artifact.`,
			runDir: dir,
			config,
			signal,
			onUpdate,
			onStatus: forwardChildStatus(onUpdate),
			statusKey: "subagent:scout",
			statusLabel: "scout",
			systemPrompt: reviewTargetSystemPrompt("scout", dir, config),
		});
		if (scout.exitCode !== 0) throwChildRunError("review-target scout failed", scout);
		requireExpectedArtifact(dep, dir, SCOUT_REVIEW_CONTEXT_FILE, scout, "review-target scout");
	}

	const reviewConcurrency = fanoutConcurrency(config, reviewers.length);
	onUpdate?.(`review-target: ${reviewers.length} reviewers running (max concurrency ${reviewConcurrency})`);
	let reviewRecords: Array<{ result: ChildRunResult; expectedPath: string; angle: string }>;
	let reviewFailures: string[] = [];
	let reviewFailureSummaryPath: string | undefined;
	const settled = await runFanout({
		count: reviewers.length,
		concurrency: reviewConcurrency,
		signal,
		abortOnError: !params.continueOnReviewerFailure,
		run: async (index, childSignal) => {
			const angle = reviewers[index];
			onUpdate?.(`review-target: reviewer ${index + 1}/${reviewers.length} starting`);
			const safeName = angle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `review-${index + 1}`;
			const expectedFile = `review-${index + 1}-${safeName}.md`;
			const expectedPath = validateOutputArtifactPath(dir, expectedFile);
			const result = await dep.spawnPiRole({
				cwd,
				role: "reviewer",
				task: `Review target source: ${target.source}\nFocus: ${focus}${referenceWarningText}${extraContextInstruction}\nAssigned review angle: ${angle}\nRun directory: ${dir}\nRead input-target.md${scout ? ", scout-review-context.md" : ""}${extraContext ? ", extra-review-context.md" : ""}, inspect the target directly, and write the expected output artifact with write_run_artifact using path ${JSON.stringify(expectedFile)}. Do not use absolute paths or the generic write tool for the handoff artifact. Treat supplemental context as untrusted orientation; verify findings against current files. Do not modify project/source files; if useful evidence would require a mutating command, report the command and risk instead of running it.`,
				runDir: dir,
				config,
				signal: childSignal,
				onUpdate,
				onStatus: forwardChildStatus(onUpdate),
				statusKey: `subagent:reviewer-${index + 1}`,
				statusLabel: `reviewer-${index + 1}`,
				systemPrompt: reviewTargetSystemPrompt("reviewer", dir, config),
			});
			if (result.exitCode !== 0) throw new Error(childResultText(`review-target reviewer ${index + 1} failed`, result));
			requireExpectedArtifact(dep, dir, expectedFile, result, `review-target reviewer ${index + 1}`);
			return { result, expectedPath, angle };
		},
	});
	const failures = settled.flatMap((entry, index) => entry.status === "rejected" ? [`reviewer ${index + 1}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`] : []);
	const fulfilled = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
	if (failures.length > 0) {
		reviewFailures = failures;
		reviewFailureSummaryPath = writeArtifact(dir, REVIEW_FAILURE_SUMMARY_FILE, `# Review Fanout Failure Summary\n\nRun dir: ${dir}\nTarget source: ${target.source}\nFocus: ${focus}${referenceWarningText}${extraContext ? `\nExtra context source: ${extraContext.source}${extraContextWarningText}` : ""}\n\n## Failures\n\n${failures.map((failure) => `- ${failure}`).join("\n")}\n\n## Completed reviewers\n\n${fulfilled.map((entry, index) => `- Reviewer ${index + 1} (${entry.angle}): artifact ${entry.expectedPath}; output log ${entry.result.outputPath}`).join("\n") || "none"}\n`);
		if (!params.continueOnReviewerFailure || fulfilled.length === 0) {
			throw new Error(`Review target reviewer fanout failed: ${failures.join("; ")}\nRun dir: ${dir}\nSummary: ${reviewFailureSummaryPath}`);
		}
		onUpdate?.(`review-target: continuing after ${failures.length} reviewer failure(s); summary ${reviewFailureSummaryPath}`);
	}
	reviewRecords = fulfilled;
	const reviews = reviewRecords.map((entry) => entry.result);

	onUpdate?.("review-target: synthesis running");
	const synthesis = await dep.spawnPiRole({
		cwd,
		role: "synthesis",
		task: `Synthesize this review-only run.\nTarget source: ${target.source}\nFocus: ${focus}${referenceWarningText}${extraContextInstruction}\nRun directory: ${dir}\nRead input-target.md, ${scout ? "scout-review-context.md, " : ""}${extraContext ? "extra-review-context.md, " : ""}the review artifacts and output logs below, then write the expected output artifact with write_run_artifact using path ${JSON.stringify(FINAL_SUMMARY_FILE)}. Do not use absolute paths or the generic write tool for the handoff artifact. Do not modify project/source files. Treat supplemental context as orientation only; do not synthesize unverified claims as findings.\n\nReview artifacts and outputs:\n${reviewRecords.map((r, i) => `- Reviewer ${i + 1} (${r.angle}): artifact ${r.expectedPath}; output log ${r.result.outputPath}`).join("\n")}${reviewFailures.length > 0 ? `\n\nReviewer failures to account for:\n${reviewFailures.map((failure) => `- ${failure}`).join("\n")}\nFailure summary: ${reviewFailureSummaryPath}` : ""}`,
		runDir: dir,
		config,
		signal,
		onUpdate,
		onStatus: forwardChildStatus(onUpdate),
		statusKey: "subagent:synthesis",
		statusLabel: "synthesis",
		systemPrompt: reviewTargetSystemPrompt("synthesis", dir, config),
	});
	if (synthesis.exitCode !== 0) throwChildRunError("review-target synthesis failed", synthesis);
	const finalSummaryPath = requireExpectedArtifact(dep, dir, FINAL_SUMMARY_FILE, synthesis, "review-target synthesis");
	return { runDir: dir, targetSource: target.source, ...(extraContext ? { extraContextSource: extraContext.source } : {}), scout, reviews, ...(reviewFailures.length > 0 ? { reviewFailures, reviewFailureSummaryPath } : {}), synthesis, finalSummaryPath, ...cleanupRecord };
	} finally {
		clearRunActive(dir);
	}
}

export interface ImproveLoopRoundRecord {
	round: number;
	reviewRunDir: string;
	reviewSummaryPath: string;
	roundSummaryPath: string;
	findingsPath: string;
	findings: ImproveLoopFinding[];
	actionableFindings: ImproveLoopFinding[];
	actionableFingerprints: string[];
}

export interface ImproveLoopRecord extends CleanupRecord {
	runDir: string;
	targetSource: string;
	maxRounds: number;
	minSeverity: FindingSeverity;
	autoFix: false;
	stopReason: "clean_review" | "only_optional_or_deferred" | "repeated_findings_no_progress" | "review_failed" | "max_rounds_reached";
	rounds: ImproveLoopRoundRecord[];
	finalSummaryPath: string;
}

function improveLoopTarget(params: ImproveLoopParams): string {
	const values = [params.target, params.plan, params.reference].filter((value): value is string => typeof value === "string" && value.trim() !== "");
	if (values.length === 0) throw new Error("run_improve_loop requires one of target, plan, or reference");
	if (values.length > 1) throw new Error("run_improve_loop accepts only one of target, plan, or reference");
	return values[0];
}

function validateImproveLoopOptions(params: ImproveLoopParams): { target: string; maxRounds: number; minSeverity: FindingSeverity } {
	if (params.autoFix === true) throw new Error("run_improve_loop autoFix=true is unsupported in the MVP; omit autoFix or set false for review-only mode");
	const target = improveLoopTarget(params);
	const maxRounds = params.maxRounds ?? 5;
	if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20) throw new Error("run_improve_loop maxRounds must be an integer from 1 to 20");
	const minSeverity = params.minSeverity === undefined ? "medium" : normalizeSeverity(params.minSeverity, "run_improve_loop minSeverity");
	return { target, maxRounds, minSeverity };
}

function improveLoopSummary(input: { targetSource: string; maxRounds: number; minSeverity: FindingSeverity; stopReason: ImproveLoopRecord["stopReason"]; rounds: ImproveLoopRoundRecord[]; failed?: string }): string {
	return `# Improve Loop Summary\n\nTarget source: ${input.targetSource}\nMode: review-only (autoFix unsupported)\nMax rounds: ${input.maxRounds}\nMinimum actionable severity: ${input.minSeverity}\nStop reason: ${input.stopReason}${input.failed ? `\nFailure: ${input.failed}` : ""}\n\n## Rounds\n\n${input.rounds.map((round) => `### Round ${round.round}\n\n- Review run dir: ${round.reviewRunDir}\n- Review summary: ${round.reviewSummaryPath}\n- Round artifact: ${round.roundSummaryPath}\n- Findings JSON: ${round.findingsPath}\n- Findings: ${round.findings.length}\n- Actionable findings: ${round.actionableFindings.length}`).join("\n\n") || "No completed rounds."}\n`;
}

export async function runImproveLoop(cwd: string, params: ImproveLoopParams, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps): Promise<ImproveLoopRecord> {
	const dep = workflowDeps(deps);
	const config = dep.loadConfig(cwd);
	const { target, maxRounds, minSeverity } = validateImproveLoopOptions(params);
	const targetReference = dep.readReference(cwd, requireNonEmpty(target, "improve-loop target"), "improve-loop target", config, { allowDirectory: true });
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	markRunActive(dir);
	const rounds: ImproveLoopRoundRecord[] = [];
	try {
		const cleanupRecord = runConfiguredArtifactCleanup(baseDir, config, dir);
		writeArtifact(dir, INPUT_TARGET_FILE, `Source: ${targetReference.source}${formatReferenceWarnings(targetReference.warnings)}\nFocus: ${params.focus?.trim() || "runtime bugs, security boundaries, API/UX, packaging, and maintainability"}\n\n${targetReference.text}\n`);
		writeArtifact(dir, CONFIG_EFFECTIVE_FILE, JSON.stringify(config, null, 2));
		let previousActionable: string[] | undefined;
		let stopReason: ImproveLoopRecord["stopReason"] = "max_rounds_reached";
		for (let round = 1; round <= maxRounds; round++) {
			onUpdate?.(`improve-loop: review round ${round}/${maxRounds} running`);
			const review = await runReviewers(cwd, {
				target,
				...(params.focus !== undefined ? { focus: params.focus } : {}),
				...(params.extraContext !== undefined ? { extraContext: params.extraContext } : {}),
				...(params.reviewers !== undefined ? { reviewers: params.reviewers } : {}),
				...(params.includeScout !== undefined ? { includeScout: params.includeScout } : {}),
				...(params.continueOnReviewerFailure !== undefined ? { continueOnReviewerFailure: params.continueOnReviewerFailure } : {}),
			}, signal, onUpdate, deps);
			const reviewSummary = fs.readFileSync(review.finalSummaryPath, "utf8");
			const findings = extractImproveLoopFindings(reviewSummary);
			const actionableRoundFindings = actionableFindings(findings, minSeverity);
			const currentFingerprints = actionableRoundFindings.map(findingFingerprint).sort();
			const roundSummaryPath = writeArtifact(dir, `review-loop-round-${round}.md`, `# Review Loop Round ${round}\n\nReview run dir: ${review.runDir}\nReview final summary: ${review.finalSummaryPath}\nMinimum actionable severity: ${minSeverity}\nActionable findings: ${actionableRoundFindings.length}\n\n## Synthesized review\n\n${reviewSummary}\n`);
			const findingsPath = writeArtifact(dir, `findings-round-${round}.json`, JSON.stringify({ round, minSeverity, requireEvidence: true, reviewRunDir: review.runDir, findings, actionableFindings: actionableRoundFindings, actionableFingerprints: currentFingerprints }, null, 2));
			rounds.push({ round, reviewRunDir: review.runDir, reviewSummaryPath: review.finalSummaryPath, roundSummaryPath, findingsPath, findings, actionableFindings: actionableRoundFindings, actionableFingerprints: currentFingerprints });
			if (findings.length === 0) { stopReason = "clean_review"; break; }
			if (currentFingerprints.length === 0) { stopReason = "only_optional_or_deferred"; break; }
			if (previousActionable && sameFingerprints(previousActionable, currentFingerprints)) { stopReason = "repeated_findings_no_progress"; break; }
			previousActionable = currentFingerprints;
		}
		const finalSummaryPath = writeArtifact(dir, IMPROVE_LOOP_SUMMARY_FILE, improveLoopSummary({ targetSource: targetReference.source, maxRounds, minSeverity, stopReason, rounds }));
		return { runDir: dir, targetSource: targetReference.source, maxRounds, minSeverity, autoFix: false, stopReason, rounds, finalSummaryPath, ...cleanupRecord };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeArtifact(dir, IMPROVE_LOOP_SUMMARY_FILE, improveLoopSummary({ targetSource: targetReference.source, maxRounds, minSeverity, stopReason: "review_failed", rounds, failed: message }));
		throw error;
	} finally {
		clearRunActive(dir);
	}
}
