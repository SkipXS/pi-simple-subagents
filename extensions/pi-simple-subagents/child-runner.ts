import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { appendArtifactFile, resolveArtifactPath, resolveRoleSessionFile, uniqueSuffix, writeArtifact } from "./artifacts.ts";
import { applyThinking, type Config, type ExtensionForwardMode } from "./config.ts";
import { roleSystemPrompt } from "./prompts.ts";
import {
	MAX_PROGRESS_LINE_BYTES,
	MAX_STDERR_BYTES,
	MAX_TOOL_OUTPUT_BYTES,
	ROLE_ENV,
	REVIEW_RUNS_ENV,
	RUN_DIR_ENV,
	WORKER_RUNS_ENV,
	type RoleName,
} from "./roles.ts";
import { appendBoundedTail, takeUtf8Head, truncateForTool } from "./text.ts";

const EXTENSION_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
const PI_CLI_PATH_ENV = "PI_SIMPLE_SUBAGENTS_PI_CLI";
const MAX_TRANSCRIPT_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_ARTIFACT_BYTES = 1024 * 1024;
const MAX_PENDING_STDOUT_LINE_BYTES = MAX_TRANSCRIPT_ARTIFACT_BYTES;
const MAX_MALFORMED_STDOUT_DIAGNOSTIC_BYTES = 8 * 1024;
let platformOverrideForTests: NodeJS.Platform | undefined;
let taskkillOverrideForTests: { command: string; argsPrefix?: string[] } | undefined;

export function setChildRunnerPlatformForTests(platform: NodeJS.Platform | undefined): void {
	platformOverrideForTests = platform;
}

export function setChildRunnerTaskkillForTests(invocation: { command: string; argsPrefix?: string[] } | undefined): void {
	taskkillOverrideForTests = invocation;
}

function runtimePlatform(): NodeJS.Platform {
	return platformOverrideForTests ?? process.platform;
}

function taskkillInvocation(): { command: string; argsPrefix: string[] } {
	return { command: taskkillOverrideForTests?.command ?? "taskkill", argsPrefix: taskkillOverrideForTests?.argsPrefix ?? [] };
}

export interface ChildStatusUpdate {
	key: string;
	text: string | undefined;
	description?: string;
}

export interface ChildRunResult {
	role: RoleName;
	exitCode: number;
	output: string;
	stderr: string;
	sessionFile: string;
	transcriptPath: string;
	stderrPath: string;
	outputPath: string;
	outputTruncated: boolean;
	stderrTruncated: boolean;
	outputBytes: number;
	stderrBytes: number;
	timedOut: boolean;
	stopReason?: string;
	errorMessage?: string;
}

function isFailedStopReason(stopReason: string | undefined): boolean {
	return stopReason === "error" || stopReason === "aborted";
}

const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_SPINNER_INTERVAL_MS = 120;
const STATUS_ACTION_INTERVAL_MS = 900;

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestTotalTokens: number;
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`;
	return String(count);
}

function inferContextWindow(model: string | undefined): number | undefined {
	if (!model) return undefined;
	const lower = model.toLowerCase();
	if (/gpt-5|gpt-4\.1|o3|o4/.test(lower)) return 272_000;
	if (/claude/.test(lower)) return 200_000;
	if (/gemini/.test(lower)) return 1_000_000;
	return undefined;
}

function compactArgs(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const record = value as Record<string, unknown>;
	if (typeof record.role === "string" && record.role.trim()) {
		const purpose = typeof record.purpose === "string" && record.purpose.trim() ? `/${record.purpose.trim()}` : "";
		return `${record.role.trim()}${purpose}`;
	}
	for (const key of ["command", "path", "target", "task", "plan", "url"] as const) {
		const raw = record[key];
		if (typeof raw === "string" && raw.trim()) return raw.trim().replace(/\s+/g, " ").slice(0, 64);
	}
	return "";
}

function nestedSubagentStatuses(value: unknown): ChildStatusUpdate[] {
	if (!value || typeof value !== "object") return [];
	const root = value as Record<string, unknown>;
	const details = root.details && typeof root.details === "object" ? root.details as Record<string, unknown> : undefined;
	const progress = details?.subagentProgress && typeof details.subagentProgress === "object" ? details.subagentProgress as Record<string, unknown> : undefined;
	const statuses = Array.isArray(progress?.statuses) ? progress.statuses : [];
	return statuses.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const status = entry as Record<string, unknown>;
		return typeof status.key === "string" && typeof status.text === "string"
			? [{ key: status.key, text: status.text, ...(typeof status.description === "string" && status.description.trim() ? { description: status.description.trim() } : {}) }]
			: [];
	});
}

function messageUsage(message: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number } | undefined {
	if (!message || typeof message !== "object") return undefined;
	const usage = (message as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return undefined;
	const record = usage as Record<string, unknown>;
	const cost = record.cost && typeof record.cost === "object" ? (record.cost as Record<string, unknown>).total : undefined;
	return {
		input: typeof record.input === "number" ? record.input : 0,
		output: typeof record.output === "number" ? record.output : 0,
		cacheRead: typeof record.cacheRead === "number" ? record.cacheRead : 0,
		cacheWrite: typeof record.cacheWrite === "number" ? record.cacheWrite : 0,
		totalTokens: typeof record.totalTokens === "number" ? record.totalTokens : 0,
		cost: typeof cost === "number" ? cost : 0,
	};
}

function statusMetrics(totals: UsageTotals, model: string | undefined, thinking: string | undefined): string {
	const parts: string[] = [];
	if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
	if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
	const contextWindow = inferContextWindow(model);
	if (contextWindow) {
		const percent = totals.latestTotalTokens > 0 ? `${((totals.latestTotalTokens / contextWindow) * 100).toFixed(1)}%` : "?";
		parts.push(`${percent}/${formatTokens(contextWindow)} (auto)`);
	}
	if (model) parts.push(`- ${model}${thinking && thinking !== "off" ? ` • ${thinking}` : thinking === "off" ? " • thinking off" : ""}`);
	return parts.join(" ");
}

export function childResultText(prefix: string, result: ChildRunResult): string {
	const stopDetails = [
		result.stopReason ? `Stop reason: ${result.stopReason}` : undefined,
		result.errorMessage ? `Error: ${result.errorMessage}` : undefined,
	].filter(Boolean).join("\n");
	return `${prefix} with exit code ${result.exitCode}.${stopDetails ? `\n${stopDetails}` : ""}\nSession: ${result.sessionFile}\nOutput: ${result.outputPath}\nTranscript: ${result.transcriptPath}${result.stderrPath ? `\nStderr: ${result.stderrPath}` : ""}\n\n${result.output}`;
}

export function throwChildRunError(prefix: string, result: ChildRunResult): never {
	throw new Error(childResultText(prefix, result));
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

function configuredPiCliPath(config?: Config): { value: string; source: string } | undefined {
	const envValue = process.env[PI_CLI_PATH_ENV]?.trim();
	if (envValue) return { value: envValue, source: PI_CLI_PATH_ENV };
	const configValue = config?.children.piCliPath?.trim();
	return configValue ? { value: configValue, source: "global children.piCliPath" } : undefined;
}

function piInvocationWarnings(config: Config | undefined, cwd: string, invocation: { command: string; args: string[] }): string[] {
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

function appendCappedArtifactFile(runDir: string, target: string, content: string, state: { bytes: number; capped: boolean }, maxBytes: number): void {
	if (content.length === 0 || state.capped) return;
	const contentBytes = Buffer.byteLength(content, "utf8");
	if (state.bytes + contentBytes <= maxBytes) {
		appendArtifactFile(runDir, target, content);
		state.bytes += contentBytes;
		return;
	}
	const remaining = Math.max(0, maxBytes - state.bytes);
	if (remaining > 0) {
		appendArtifactFile(runDir, target, takeUtf8Head(content, remaining));
		state.bytes = maxBytes;
	}
	appendArtifactFile(runDir, target, `\n[Artifact cap reached at ${maxBytes} bytes; further output omitted.]\n`);
	state.capped = true;
}

export async function spawnPiRole(input: {
	cwd: string;
	role: RoleName;
	task: string;
	runDir: string;
	config: Config;
	envExtra?: Record<string, string>;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
	onStatus?: (status: ChildStatusUpdate) => void;
	statusKey?: string;
	statusLabel?: string;
	statusDescription?: string;
	systemPrompt?: string;
}): Promise<ChildRunResult> {
	const roleConfig = input.config.roles[input.role];
	if (input.signal?.aborted) {
		const stampBase = `${Date.now()}-${uniqueSuffix()}`;
		const sessionFile = resolveArtifactPath(input.runDir, input.role === "worker" || input.role === "orchestrator" ? `sessions/${input.role}.jsonl` : `sessions/${input.role}-${stampBase}.jsonl`);
		const transcriptPath = resolveArtifactPath(input.runDir, `logs/${input.role}-${stampBase}.jsonl`);
		const stderrPath = resolveArtifactPath(input.runDir, `logs/${input.role}-${stampBase}.stderr.log`);
		const outputPath = resolveArtifactPath(input.runDir, `outputs/${input.role}-${stampBase}.md`);
		const output = "Child run aborted before start.";
		return {
			role: input.role,
			exitCode: 130,
			output,
			stderr: output,
			sessionFile,
			transcriptPath,
			stderrPath,
			outputPath,
			outputTruncated: false,
			stderrTruncated: false,
			outputBytes: Buffer.byteLength(output, "utf8"),
			stderrBytes: Buffer.byteLength(output, "utf8"),
			timedOut: false,
			stopReason: "aborted",
			errorMessage: output,
		};
	}
	const sessionFile = resolveRoleSessionFile(input.runDir, input.role);
	const promptPath = writeArtifact(input.runDir, `prompts/${input.role}-system-${uniqueSuffix()}.md`, input.systemPrompt ?? roleSystemPrompt(input.role, input.runDir, input.config));
	const taskPath = writeArtifact(input.runDir, `tasks/${input.role}-${uniqueSuffix()}.md`, input.task);
	const args = [
		"--mode", "json",
		"--session", sessionFile,
	];
	if (shouldForwardCurrentExtension(input.config.children.forwardCurrentExtension)) {
		args.push("--extension", EXTENSION_PATH);
	}
	args.push(
		"--model", applyThinking(roleConfig.model, roleConfig.thinking),
		"--append-system-prompt", promptPath,
	);
	args.push("-p", quoteAtReferencePath(taskPath));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[ROLE_ENV]: input.role,
		[RUN_DIR_ENV]: input.runDir,
		...(input.envExtra ?? {}),
	};
	delete env.CONTEXT_MODE_BRIDGE_DEPTH;
	return await new Promise<ChildRunResult>((resolve) => {
		const stampBase = `${Date.now()}-${uniqueSuffix()}`;
		const transcriptPath = writeArtifact(input.runDir, `logs/${input.role}-${stampBase}.jsonl`, "");
		const stderrPath = writeArtifact(input.runDir, `logs/${input.role}-${stampBase}.stderr.log`, "");
		let invocation: { command: string; args: string[] };
		let invocationWarnings: string[] = [];
		try {
			invocation = getPiInvocation(args, input.config);
			invocationWarnings = piInvocationWarnings(input.config, input.cwd, invocation);
			writeArtifact(input.runDir, `logs/${input.role}-${stampBase}.invocation.json`, JSON.stringify({
				role: input.role,
				cwd: input.cwd,
				command: invocation.command,
				args: invocation.args,
				configuredPiCliPath: configuredPiCliPath(input.config),
				warnings: invocationWarnings,
			}, null, 2));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			writeArtifact(input.runDir, stderrPath, `${message}\n`);
			const outputPath = writeArtifact(input.runDir, `outputs/${input.role}-${stampBase}.md`, `Child run failed before spawn:\n${message}`);
			resolve({
				role: input.role,
				exitCode: 1,
				output: `Child run failed before spawn:\n${message}`,
				stderr: message,
				sessionFile,
				transcriptPath,
				stderrPath,
				outputPath,
				outputTruncated: false,
				stderrTruncated: false,
				outputBytes: Buffer.byteLength(`Child run failed before spawn:\n${message}`, "utf8"),
				stderrBytes: Buffer.byteLength(message, "utf8"),
				timedOut: false,
				stopReason: "error",
				errorMessage: message,
			});
			return;
		}
		const child = spawn(invocation.command, invocation.args, { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: runtimePlatform() !== "win32", windowsHide: true });
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let buffer = "";
		let stderr = invocationWarnings.length > 0 ? `${invocationWarnings.map((warning) => `Pi CLI warning: ${warning}`).join("\n")}\n` : "";
		let finalOutput = "";
		let assistantStopReason: string | undefined;
		let assistantErrorMessage: string | undefined;
		let childModel = roleConfig.model.split("/").pop()?.replace(/:(off|minimal|low|medium|high|xhigh)$/, "") || roleConfig.model;
		const usageTotals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestTotalTokens: 0 };
		const statusKey = input.statusKey ?? `subagent:${input.role}`;
		const statusLabel = input.statusLabel ?? input.role;
		const statusDescription = input.statusDescription?.trim() || undefined;
		let statusFrame = 0;
		let statusAction = "starting";
		let pendingStatusAction = statusAction;
		let lastStatusActionAt = 0;
		let lastStatusText = "";
		let settled = false;
		let aborted = false;
		let timedOut = false;
		let stdoutLineTooLarge = false;
		let parsedAssistantMessageEnd = false;
		let malformedStdoutLineCount = 0;
		let malformedStdoutTail = "";
		let artifactErrorMessage: string | undefined;
		let killFallbackTimer: ReturnType<typeof setTimeout> | undefined;
		const transcriptCap = { bytes: 0, capped: false };
		const stderrCap = { bytes: 0, capped: false };
		if (stderr) {
			appendArtifactFile(input.runDir, stderrPath, stderr);
			stderrCap.bytes = Buffer.byteLength(stderr, "utf8");
		}
		const commitPendingStatusAction = (options: { force?: boolean } = {}) => {
			const now = Date.now();
			const actionChanged = pendingStatusAction !== statusAction;
			if (!actionChanged) return;
			const firstUsefulAction = statusAction === "starting" && pendingStatusAction !== "starting";
			if (!options.force && !firstUsefulAction && now - lastStatusActionAt < STATUS_ACTION_INTERVAL_MS) return;
			statusAction = pendingStatusAction;
			lastStatusActionAt = now;
		};
		const formatStatusText = (action = statusAction) => {
			const frame = STATUS_SPINNER_FRAMES[statusFrame++ % STATUS_SPINNER_FRAMES.length];
			const metrics = statusMetrics(usageTotals, childModel, roleConfig.thinking);
			return `${frame} ${statusLabel}: ${metrics ? `${metrics} - ${action}` : action}`;
		};
		const emitStatus = (options: { force?: boolean; action?: string } = {}) => {
			if (!input.onStatus) return;
			if (options.action === undefined) commitPendingStatusAction({ force: options.force });
			const text = formatStatusText(options.action);
			if (!options.force && text === lastStatusText) return;
			lastStatusText = text;
			input.onStatus({ key: statusKey, text, ...(statusDescription ? { description: statusDescription } : {}) });
		};
		const setStatusAction = (action: string, options: { force?: boolean } = {}) => {
			pendingStatusAction = action;
			const before = statusAction;
			commitPendingStatusAction(options);
			if (options.force || statusAction !== before) emitStatus(options);
		};
		emitStatus({ force: true });
		const statusTimer = input.onStatus ? setInterval(emitStatus, STATUS_SPINNER_INTERVAL_MS) : undefined;
		(statusTimer as { unref?: () => void } | undefined)?.unref?.();
		const rememberArtifactError = (context: string, error: unknown) => {
			if (artifactErrorMessage) return;
			const message = error instanceof Error ? error.message : String(error);
			artifactErrorMessage = `Child artifact write failed (${context}): ${message}`;
			stderr = appendBoundedTail(stderr, `${artifactErrorMessage}\n`, MAX_STDERR_BYTES);
		};
		const safeAppendCappedArtifactFile = (target: string, content: string, state: { bytes: number; capped: boolean }, maxBytes: number, context: string) => {
			try {
				appendCappedArtifactFile(input.runDir, target, content, state, maxBytes);
			} catch (error) {
				rememberArtifactError(context, error);
			}
		};
		const processLine = (line: string) => {
			if (stdoutLineTooLarge || !line.trim()) return;
			safeAppendCappedArtifactFile(transcriptPath, `${line}\n`, transcriptCap, MAX_TRANSCRIPT_ARTIFACT_BYTES, "transcript");
			try {
				const event = JSON.parse(line) as { type?: string; toolName?: string; args?: unknown; input?: unknown; partialResult?: unknown; result?: unknown; isError?: boolean; message?: { role?: string; content?: Array<{ type?: string; text?: unknown }>; stopReason?: unknown; errorMessage?: unknown; provider?: unknown; model?: unknown } };
				if (event.type === "tool_execution_start") {
					const detail = compactArgs(event.args ?? event.input);
					setStatusAction(`${event.toolName ?? "tool"}${detail ? ` ${detail}` : ""}`, { force: event.toolName === "run_role_agent" });
				} else if (event.type === "tool_execution_update") {
					for (const nestedStatus of nestedSubagentStatuses(event.partialResult)) input.onStatus?.(nestedStatus);
					const detail = compactArgs(event.args ?? event.input);
					setStatusAction(`${event.toolName ?? "tool"}${detail ? ` ${detail}` : ""}`);
				} else if (event.type === "tool_execution_end") {
					for (const nestedStatus of nestedSubagentStatuses(event.result)) input.onStatus?.(nestedStatus);
					setStatusAction(event.isError ? `${event.toolName ?? "tool"} failed` : `${event.toolName ?? "tool"} done`);
				} else if (event.type === "message_start") {
					setStatusAction("thinking");
				} else if (event.type === "message_end" && event.message?.role === "assistant") {
					parsedAssistantMessageEnd = true;
					if (typeof event.message.provider === "string" && typeof event.message.model === "string") childModel = event.message.model;
					const usage = messageUsage(event.message);
					if (usage) {
						usageTotals.input += usage.input;
						usageTotals.output += usage.output;
						usageTotals.cacheRead += usage.cacheRead;
						usageTotals.cacheWrite += usage.cacheWrite;
						usageTotals.cost += usage.cost;
						usageTotals.latestTotalTokens = usage.totalTokens;
					}
					if (typeof event.message.stopReason === "string") assistantStopReason = event.message.stopReason;
					if (typeof event.message.errorMessage === "string") assistantErrorMessage = event.message.errorMessage;
					const textParts = (event.message.content ?? [])
						.filter((part: { type?: string }) => part.type === "text")
						.map((part: { text?: unknown }) => typeof part.text === "string" ? part.text : "")
						.filter((text: string) => text.length > 0);
					if (textParts.length > 0) finalOutput = textParts.join("\n\n");
					if (finalOutput) {
						const firstLine = finalOutput.split("\n")[0] ?? "";
						input.onUpdate?.(`${input.role}: ${takeUtf8Head(firstLine, MAX_PROGRESS_LINE_BYTES)}`);
						setStatusAction(takeUtf8Head(firstLine, MAX_PROGRESS_LINE_BYTES));
					} else if (isFailedStopReason(assistantStopReason) && assistantErrorMessage) {
						input.onUpdate?.(`${input.role}: ${takeUtf8Head(assistantErrorMessage, MAX_PROGRESS_LINE_BYTES)}`);
						setStatusAction(takeUtf8Head(assistantErrorMessage, MAX_PROGRESS_LINE_BYTES));
					} else {
						setStatusAction("waiting");
					}
				}
			} catch {
				malformedStdoutLineCount++;
				malformedStdoutTail = appendBoundedTail(malformedStdoutTail, `${line}\n`, MAX_MALFORMED_STDOUT_DIAGNOSTIC_BYTES);
				setStatusAction("invalid child JSON");
			}
		};
		const signalChildTree = (signalName: NodeJS.Signals) => {
			if (runtimePlatform() !== "win32" && child.pid) {
				try {
					process.kill(-child.pid, signalName);
					return;
				} catch {
					// Fall back to signalling only the direct child below.
				}
			}
			child.kill(signalName);
		};
		const abortChild = (reason = "Child run aborted.", options: { timeout?: boolean } = {}) => {
			if (aborted) return;
			if (options.timeout) timedOut = true;
			aborted = true;
			const line = `${reason}\n`;
			const artifactLine = stderr.endsWith("\n") || stderr.length === 0 ? line : `\n${line}`;
			stderr = appendBoundedTail(stderr, artifactLine, MAX_STDERR_BYTES);
			safeAppendCappedArtifactFile(stderrPath, artifactLine, stderrCap, MAX_STDERR_ARTIFACT_BYTES, "stderr");
			if (runtimePlatform() === "win32" && child.pid) {
				const taskkill = taskkillInvocation();
				const killer = spawn(taskkill.command, [...taskkill.argsPrefix, "/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
				killer.on("error", () => child.kill());
				killer.on("close", (code) => { if (code !== 0) child.kill(); });
				return;
			}
			signalChildTree("SIGTERM");
			killFallbackTimer = setTimeout(() => {
				signalChildTree("SIGKILL");
				killFallbackTimer = undefined;
			}, 5000);
			(killFallbackTimer as { unref?: () => void }).unref?.();
		};
		const onAbort = () => abortChild();
		const timeoutMs = input.config.children.timeoutMs;
		const timeoutTimer = timeoutMs > 0 ? setTimeout(() => abortChild(`Child run timed out after ${timeoutMs} ms.`, { timeout: true }), timeoutMs) : undefined;
		(timeoutTimer as { unref?: () => void } | undefined)?.unref?.();
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			if (statusTimer) clearInterval(statusTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killFallbackTimer) {
				clearTimeout(killFallbackTimer);
				killFallbackTimer = undefined;
			}
			if (input.signal) input.signal.removeEventListener("abort", onAbort);
			buffer += stdoutDecoder.end();
			const stderrTail = stderrDecoder.end();
			if (stderrTail) {
				safeAppendCappedArtifactFile(stderrPath, stderrTail, stderrCap, MAX_STDERR_ARTIFACT_BYTES, "stderr");
				stderr = appendBoundedTail(stderr, stderrTail, MAX_STDERR_BYTES);
			}
			if (buffer.trim()) processLine(buffer);
			const protocolErrors = [
				malformedStdoutLineCount > 0 ? `Child stdout contained ${malformedStdoutLineCount} non-JSON line${malformedStdoutLineCount === 1 ? "" : "s"} while --mode json was expected.\nTranscript: ${transcriptPath}\n\n${malformedStdoutTail.trimEnd()}` : undefined,
				!parsedAssistantMessageEnd ? `Child exited without a parsed assistant message_end event.\nTranscript: ${transcriptPath}` : undefined,
			].filter(Boolean).join("\n\n");
			const protocolErrorMessage = protocolErrors || undefined;
			const baseOutput = protocolErrorMessage
				? `Child run infrastructure error:\n${protocolErrorMessage}${stderr ? `\n\nStderr log: ${stderrPath}\n\n${stderr}` : ""}`
				: stdoutLineTooLarge && assistantErrorMessage
					? `Assistant ${assistantStopReason ?? "failed"}: ${assistantErrorMessage}`
					: finalOutput
						|| (assistantErrorMessage ? `Assistant ${assistantStopReason ?? "failed"}: ${assistantErrorMessage}` : "")
						|| (stderr ? `No assistant output. Stderr log: ${stderrPath}\n\n${stderr}` : "(no output)");
			let fullOutput = artifactErrorMessage ? `${baseOutput}\n\nChild run infrastructure error:\n${artifactErrorMessage}` : baseOutput;
			let outputPath = resolveArtifactPath(input.runDir, `outputs/${input.role}-${stampBase}.md`);
			try {
				outputPath = writeArtifact(input.runDir, `outputs/${input.role}-${stampBase}.md`, fullOutput);
			} catch (error) {
				rememberArtifactError("output", error);
				fullOutput = `${fullOutput}\n\nChild run infrastructure error:\n${artifactErrorMessage}`;
			}
			const effectiveExitCode = timedOut || aborted ? exitCode : artifactErrorMessage || stdoutLineTooLarge || protocolErrorMessage ? 1 : exitCode === 0 && isFailedStopReason(assistantStopReason) ? 1 : exitCode;
			const finalStopReason = timedOut ? "timed_out" : stdoutLineTooLarge || artifactErrorMessage || protocolErrorMessage ? "error" : aborted ? "aborted" : assistantStopReason;
			const finalErrorMessage = timedOut ? `Child run timed out after ${timeoutMs} ms.` : stdoutLineTooLarge ? assistantErrorMessage : artifactErrorMessage ?? protocolErrorMessage ?? (aborted ? "Child run aborted." : assistantErrorMessage);
			const finalStatus = timedOut ? "timed out"
				: artifactErrorMessage || stdoutLineTooLarge || protocolErrorMessage ? "failed"
					: aborted ? "aborted"
						: effectiveExitCode !== 0 ? "failed" : "finished";
			input.onStatus?.({ key: statusKey, text: formatStatusText(finalStatus), ...(statusDescription ? { description: statusDescription } : {}) });
			const truncatedOutput = truncateForTool(fullOutput, MAX_TOOL_OUTPUT_BYTES);
			const truncatedStderr = truncateForTool(stderr, MAX_STDERR_BYTES);
			resolve({
				role: input.role,
				exitCode: effectiveExitCode,
				output: truncatedOutput.text,
				stderr: truncatedStderr.text,
				sessionFile,
				transcriptPath,
				stderrPath,
				outputPath,
				outputTruncated: truncatedOutput.truncated,
				stderrTruncated: truncatedStderr.truncated,
				outputBytes: truncatedOutput.totalBytes,
				stderrBytes: truncatedStderr.totalBytes,
				timedOut,
				stopReason: finalStopReason,
				errorMessage: finalErrorMessage,
			});
		};
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += stdoutDecoder.write(chunk);
			if (stdoutLineTooLarge) {
				buffer = "";
				return;
			}
			if (Buffer.byteLength(buffer, "utf8") > MAX_PENDING_STDOUT_LINE_BYTES) {
				const message = `Child stdout JSONL line exceeded ${MAX_PENDING_STDOUT_LINE_BYTES} bytes before a newline; aborting child run to avoid silently dropping output.`;
				assistantStopReason = "error";
				assistantErrorMessage = message;
				const preserved = takeUtf8Head(buffer, MAX_PENDING_STDOUT_LINE_BYTES);
				safeAppendCappedArtifactFile(transcriptPath, `${preserved}\n[Stdout line exceeded ${MAX_PENDING_STDOUT_LINE_BYTES} bytes; remaining bytes omitted.]\n`, transcriptCap, MAX_TRANSCRIPT_ARTIFACT_BYTES, "transcript");
				buffer = "";
				stdoutLineTooLarge = true;
				abortChild(message);
				return;
			}
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = stderrDecoder.write(chunk);
			if (!text) return;
			safeAppendCappedArtifactFile(stderrPath, text, stderrCap, MAX_STDERR_ARTIFACT_BYTES, "stderr");
			stderr = appendBoundedTail(stderr, text, MAX_STDERR_BYTES);
		});
		child.on("close", (code, signal) => {
			finish(timedOut ? 124 : aborted ? 130 : code ?? (signal ? 1 : 0));
		});
		child.on("error", (error) => {
			const message = error instanceof Error ? error.message : String(error);
			safeAppendCappedArtifactFile(stderrPath, message, stderrCap, MAX_STDERR_ARTIFACT_BYTES, "stderr");
			stderr = appendBoundedTail(stderr, message, MAX_STDERR_BYTES);
			finish(1);
		});
		if (input.signal) {
			if (input.signal.aborted) onAbort();
			else input.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

export function childEnvCounts(workerRuns: number, reviewRuns: number): Record<string, string> {
	return {
		[WORKER_RUNS_ENV]: String(workerRuns),
		[REVIEW_RUNS_ENV]: String(reviewRuns),
	};
}
