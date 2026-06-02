import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { appendArtifactFile, resolveRoleSessionFile, uniqueSuffix, writeArtifact } from "./artifacts.ts";
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
const requireFromExtension = createRequire(import.meta.url);
const PI_CLI_PATH_ENV = "PI_SIMPLE_SUBAGENTS_PI_CLI";
const MAX_TRANSCRIPT_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_ARTIFACT_BYTES = 1024 * 1024;
const MAX_PENDING_STDOUT_LINE_BYTES = 1024 * 1024;

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

function resolvePiCliPath(overridePath?: string): string | undefined {
	const configured = process.env[PI_CLI_PATH_ENV]?.trim() || overridePath?.trim();
	if (configured) return configured;
	try {
		const packageEntry = requireFromExtension.resolve("@earendil-works/pi-coding-agent");
		const candidate = path.join(path.dirname(path.dirname(packageEntry)), "dist", "cli.js");
		return fs.existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function isJavaScriptEntrypoint(filePath: string): boolean {
	return /\.[cm]?js$/i.test(filePath);
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
	return { command: process.platform === "win32" ? "pi.cmd" : "pi", args };
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
	systemPrompt?: string;
}): Promise<ChildRunResult> {
	const roleConfig = input.config.roles[input.role];
	const sessionFile = resolveRoleSessionFile(input.runDir, input.role);
	const promptPath = writeArtifact(input.runDir, `prompts/${input.role}-system-${uniqueSuffix()}.md`, input.systemPrompt ?? roleSystemPrompt(input.role, input.runDir, input.config));
	const taskPath = writeArtifact(input.runDir, `tasks/${input.role}-${uniqueSuffix()}.md`, input.task);
	const args = [
		"--mode", "json",
		"--session", sessionFile,
	];
	const inheritExtensions = input.role === "worker" ? input.config.children.inheritExtensions : input.config.children.inheritExtensionsForReadOnly;
	if (!inheritExtensions) {
		args.push("--no-extensions", "--extension", EXTENSION_PATH);
	} else if (shouldForwardCurrentExtension(input.config.children.forwardCurrentExtension)) {
		args.push("--extension", EXTENSION_PATH);
	}
	if (!input.config.children.inheritSkills) {
		args.push("--no-skills");
	}
	args.push(
		"--model", applyThinking(roleConfig.model, roleConfig.thinking),
		"--system-prompt", promptPath,
	);
	args.push("-p", quoteAtReferencePath(taskPath));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[ROLE_ENV]: input.role,
		[RUN_DIR_ENV]: input.runDir,
		...(input.envExtra ?? {}),
	};
	if (inheritExtensions) {
		delete env.CONTEXT_MODE_BRIDGE_DEPTH;
	}
	return await new Promise<ChildRunResult>((resolve) => {
		const stampBase = `${Date.now()}-${uniqueSuffix()}`;
		const transcriptPath = writeArtifact(input.runDir, `logs/${input.role}-${stampBase}.jsonl`, "");
		const stderrPath = writeArtifact(input.runDir, `logs/${input.role}-${stampBase}.stderr.log`, "");

		const invocation = getPiInvocation(args, input.config);
		const child = spawn(invocation.command, invocation.args, { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform !== "win32", windowsHide: true });
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let buffer = "";
		let stderr = "";
		let finalOutput = "";
		let assistantStopReason: string | undefined;
		let assistantErrorMessage: string | undefined;
		let settled = false;
		let aborted = false;
		let timedOut = false;
		const transcriptCap = { bytes: 0, capped: false };
		const stderrCap = { bytes: 0, capped: false };
		const processLine = (line: string) => {
			if (!line.trim()) return;
			appendCappedArtifactFile(input.runDir, transcriptPath, `${line}\n`, transcriptCap, MAX_TRANSCRIPT_ARTIFACT_BYTES);
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
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
					} else if (isFailedStopReason(assistantStopReason) && assistantErrorMessage) {
						input.onUpdate?.(`${input.role}: ${takeUtf8Head(assistantErrorMessage, MAX_PROGRESS_LINE_BYTES)}`);
					}
				}
			} catch { /* ignore non-json */ }
		};
		const signalChildTree = (signalName: NodeJS.Signals) => {
			if (process.platform !== "win32" && child.pid) {
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
			if (options.timeout) timedOut = true;
			aborted = true;
			const line = `${reason}\n`;
			const artifactLine = stderr.endsWith("\n") || stderr.length === 0 ? line : `\n${line}`;
			stderr = appendBoundedTail(stderr, artifactLine, MAX_STDERR_BYTES);
			appendCappedArtifactFile(input.runDir, stderrPath, artifactLine, stderrCap, MAX_STDERR_ARTIFACT_BYTES);
			if (process.platform === "win32" && child.pid) {
				const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
				killer.on("error", () => child.kill());
				killer.on("close", (code) => { if (code !== 0) child.kill(); });
				return;
			}
			signalChildTree("SIGTERM");
			const killTimer = setTimeout(() => {
				signalChildTree("SIGKILL");
			}, 5000);
			(killTimer as { unref?: () => void }).unref?.();
		};
		const onAbort = () => abortChild();
		const timeoutMs = input.config.children.timeoutMs;
		const timeoutTimer = timeoutMs > 0 ? setTimeout(() => abortChild(`Child run timed out after ${timeoutMs} ms.`, { timeout: true }), timeoutMs) : undefined;
		(timeoutTimer as { unref?: () => void } | undefined)?.unref?.();
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (input.signal) input.signal.removeEventListener("abort", onAbort);
			buffer += stdoutDecoder.end();
			const stderrTail = stderrDecoder.end();
			if (stderrTail) {
				appendCappedArtifactFile(input.runDir, stderrPath, stderrTail, stderrCap, MAX_STDERR_ARTIFACT_BYTES);
				stderr = appendBoundedTail(stderr, stderrTail, MAX_STDERR_BYTES);
			}
			if (buffer.trim()) processLine(buffer);
			const effectiveExitCode = exitCode === 0 && isFailedStopReason(assistantStopReason) ? 1 : exitCode;
			const baseOutput = finalOutput
				|| (assistantErrorMessage ? `Assistant ${assistantStopReason ?? "failed"}: ${assistantErrorMessage}` : "")
				|| (stderr ? `No assistant output. Stderr log: ${stderrPath}\n\n${stderr}` : "(no output)");
			const fullOutput = baseOutput;
			const outputPath = writeArtifact(input.runDir, `outputs/${input.role}-${stampBase}.md`, fullOutput);
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
				stopReason: assistantStopReason,
				errorMessage: assistantErrorMessage,
			});
		};
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += stdoutDecoder.write(chunk);
			if (Buffer.byteLength(buffer, "utf8") > MAX_PENDING_STDOUT_LINE_BYTES) {
				processLine(takeUtf8Head(buffer, MAX_PENDING_STDOUT_LINE_BYTES));
				buffer = "";
			}
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = stderrDecoder.write(chunk);
			if (!text) return;
			appendCappedArtifactFile(input.runDir, stderrPath, text, stderrCap, MAX_STDERR_ARTIFACT_BYTES);
			stderr = appendBoundedTail(stderr, text, MAX_STDERR_BYTES);
		});
		child.on("close", (code, signal) => {
			finish(timedOut ? 124 : aborted ? 130 : code ?? (signal ? 1 : 0));
		});
		child.on("error", (error) => {
			const message = error instanceof Error ? error.message : String(error);
			appendCappedArtifactFile(input.runDir, stderrPath, message, stderrCap, MAX_STDERR_ARTIFACT_BYTES);
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
