import test from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getPiInvocation, quoteAtReferencePath, shouldForwardCurrentExtension, spawnPiRole, wasLoadedWithExtensionFlag, type ChildRunResult } from "../extensions/pi-simple-subagents/child-runner.ts";
import { DEFAULT_CONFIG, type Config } from "../extensions/pi-simple-subagents/config.ts";
import orchestratorAgentsExtension from "../extensions/pi-simple-subagents/index.ts";
import { runParallelWorkers, runReviewTarget, runScoutAgent, runWorkerAgent, parseReviewTargetCommand } from "../extensions/pi-simple-subagents/workflows.ts";

function tempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-test-"));
}

function cloneConfig(): Config {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
}

function fakeResult(role: ChildRunResult["role"], runDir: string): ChildRunResult {
	const file = path.join(runDir, `${role}-fake.md`);
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(file, `${role} output`, "utf8");
	return {
		role,
		exitCode: 0,
		output: `${role} output`,
		stderr: "",
		sessionFile: file,
		transcriptPath: file,
		stderrPath: file,
		outputPath: file,
		outputTruncated: false,
		stderrTruncated: false,
		outputBytes: 0,
		stderrBytes: 0,
		timedOut: false,
	};
}

function expectedArtifactFromTask(task: string): string | undefined {
	const explicit = /^Expected output artifact: (.+)$/m.exec(task)?.[1]?.trim();
	if (explicit) return explicit;
	return /write_run_artifact using path "([^"]+)"/.exec(task)?.[1];
}

function fakeCompliantResult(input: { role: ChildRunResult["role"]; runDir: string; task: string }): ChildRunResult {
	const result = fakeResult(input.role, input.runDir);
	const artifact = expectedArtifactFromTask(input.task);
	if (artifact) {
		const target = path.join(input.runDir, artifact);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, `${input.role} artifact`, "utf8");
	}
	return result;
}

test("parseReviewTargetCommand preserves existing simple syntax", () => {
	assert.deepEqual(parseReviewTargetCommand("@src/index.ts security focus"), {
		target: "@src/index.ts",
		focus: "security focus",
	});
});

test("parseReviewTargetCommand supports scout, context, and reviewer command options", () => {
	assert.deepEqual(parseReviewTargetCommand("--no-scout --context @reports/scout-report.md --reviewer \"security and boundaries\" @\"dir with spaces\" runtime bugs"), {
		target: "@\"dir with spaces\"",
		focus: "runtime bugs",
		extraContext: "@reports/scout-report.md",
		reviewers: ["security and boundaries"],
		includeScout: false,
	});
	assert.deepEqual(parseReviewTargetCommand("--context=@\"reports/old scout.md\" @README.md docs"), {
		target: "@README.md",
		focus: "docs",
		extraContext: "@\"reports/old scout.md\"",
	});
});

test("parseReviewTargetCommand preserves quoted Windows backslashes", () => {
	assert.deepEqual(parseReviewTargetCommand("--no-scout @\"C:\\Users\\Name With Spaces\\target\" runtime bugs"), {
		target: "@\"C:\\Users\\Name With Spaces\\target\"",
		focus: "runtime bugs",
		includeScout: false,
	});
});

test("parseReviewTargetCommand uses current /review error wording", () => {
	assert.throws(() => parseReviewTargetCommand("--reviewer"), /\/review --reviewer/);
	assert.throws(() => parseReviewTargetCommand("--context"), /\/review --context/);
	assert.throws(() => parseReviewTargetCommand("--no-scout"), /\/review requires a target/);
	assert.throws(() => parseReviewTargetCommand("--noScout @README.md docs"), /\/review unknown option: --noScout/);
	assert.throws(() => parseReviewTargetCommand("--reviewer security --bad @README.md"), /\/review unknown option: --bad/);
	assert.throws(() => parseReviewTargetCommand('--reviewer "security @README.md'), /\/review has unmatched double quote/);
	assert.throws(() => parseReviewTargetCommand("--context 'prior notes @README.md"), /\/review has unmatched single quote/);
});

test("parseReviewTargetCommand supports quoted multi-word option values", () => {
	assert.deepEqual(parseReviewTargetCommand("--context 'prior scout notes' --reviewer 'runtime correctness' @README.md docs"), {
		target: "@README.md",
		focus: "docs",
		extraContext: "prior scout notes",
		reviewers: ["runtime correctness"],
	});
});

test("child task @ references are quoted for whitespace paths", () => {
	assert.equal(quoteAtReferencePath("/tmp/pi task.md"), "@\"/tmp/pi task.md\"");
	assert.equal(quoteAtReferencePath("C:\\Users\\Name With Spaces\\task.md"), "@\"C:\\\\Users\\\\Name With Spaces\\\\task.md\"");
	assert.equal(quoteAtReferencePath("/tmp/pi-task.md"), "@/tmp/pi-task.md");
});

test("child role prompt is passed via append-system-prompt file", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "argv.json"), JSON.stringify(process.argv.slice(2)), "utf8");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "fake", model: "fake-model", content: [{ type: "text", text: "done" }], stopReason: "stop" } }));
`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;
	const result = await spawnPiRole({ cwd, role: "worker", task: "prompt test", runDir, config, systemPrompt: "custom role prompt" });
	const argv = JSON.parse(fs.readFileSync(path.join(cwd, "argv.json"), "utf8")) as string[];
	const promptArgIndex = argv.indexOf("--append-system-prompt");

	assert.equal(result.exitCode, 0);
	assert.equal(argv.includes("--system-prompt"), false);
	assert.notEqual(promptArgIndex, -1);
	assert.match(fs.readFileSync(argv[promptArgIndex + 1], "utf8"), /custom role prompt/);
});

test("current extension forwarding supports temporary -e loading", () => {
	assert.equal(wasLoadedWithExtensionFlag(["node", "cli", "-e", "./extension.ts"]), true);
	assert.equal(wasLoadedWithExtensionFlag(["node", "cli", "--extension=./extension.ts"]), true);
	assert.equal(wasLoadedWithExtensionFlag(["node", "cli"]), false);
	assert.equal(shouldForwardCurrentExtension("auto", ["node", "cli", "-e", "./extension.ts"]), true);
	assert.equal(shouldForwardCurrentExtension("auto", ["node", "cli"]), false);
	assert.equal(shouldForwardCurrentExtension("always", ["node", "cli"]), true);
	assert.equal(shouldForwardCurrentExtension("never", ["node", "cli", "-e", "./extension.ts"]), false);
});

test("Pi CLI discovery supports config override", () => {
	const config = cloneConfig();
	config.children.piCliPath = "/custom/pi";
	assert.deepEqual(getPiInvocation(["--version"], config), { command: "/custom/pi", args: ["--version"] });
});

test("Pi CLI discovery resolves the package bin without override", () => {
	const oldEnv = process.env.PI_SIMPLE_SUBAGENTS_PI_CLI;
	try {
		delete process.env.PI_SIMPLE_SUBAGENTS_PI_CLI;
		const config = cloneConfig();
		delete config.children.piCliPath;
		const invocation = getPiInvocation(["--version"], config);
		assert.equal(invocation.command, process.execPath);
		assert.match(invocation.args[0] ?? "", /@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/);
		assert.equal(invocation.args.at(-1), "--version");
	} finally {
		if (oldEnv === undefined) delete process.env.PI_SIMPLE_SUBAGENTS_PI_CLI;
		else process.env.PI_SIMPLE_SUBAGENTS_PI_CLI = oldEnv;
	}
});

test("package pi.extensions manifest points at loadable extension modules", async () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
	assert.ok(Array.isArray(manifest.pi?.extensions));
	for (const extensionPath of manifest.pi.extensions) {
		assert.equal(typeof extensionPath, "string");
		const resolved = path.resolve(process.cwd(), extensionPath as string);
		const entrypoint = fs.statSync(resolved).isDirectory() ? path.join(resolved, "index.ts") : resolved;
		assert.equal(fs.existsSync(entrypoint), true);
		const module = await import(pathToFileURL(entrypoint).href);
		assert.equal(typeof module.default, "function");
	}
});

test("package tarball dry-run contains only release files", () => {
	const output = childProcess.execSync("npm pack --dry-run --json --ignore-scripts", { cwd: process.cwd(), encoding: "utf8", shell: process.platform === "win32" ? "cmd.exe" : undefined });
	const pack = (JSON.parse(output) as Array<{ files: Array<{ path: string }> }>)[0];
	const files = pack.files.map((file) => file.path).sort();
	assert.deepEqual(files, [
		"LICENSE",
		"README.md",
		"examples/config.json",
		"extensions/pi-simple-subagents/artifacts.ts",
		"extensions/pi-simple-subagents/child-runner.ts",
		"extensions/pi-simple-subagents/config.ts",
		"extensions/pi-simple-subagents/constants.ts",
		"extensions/pi-simple-subagents/index.ts",
		"extensions/pi-simple-subagents/prompts.ts",
		"extensions/pi-simple-subagents/references.ts",
		"extensions/pi-simple-subagents/role-registry.ts",
		"extensions/pi-simple-subagents/roles.ts",
		"extensions/pi-simple-subagents/schemas.ts",
		"extensions/pi-simple-subagents/state.ts",
		"extensions/pi-simple-subagents/text.ts",
		"extensions/pi-simple-subagents/workflows.ts",
		"package.json",
	].sort());
});

test("child runs report timeout accurately", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, "setTimeout(() => {}, 10000);", "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;
	config.children.timeoutMs = 50;
	const result = await spawnPiRole({ cwd, role: "worker", task: "timeout test", runDir, config });
	assert.equal(result.timedOut, true);
	assert.equal(result.exitCode, 124);
});

test("child runs emit per-subagent status with tool activity and usage metrics", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
console.log(JSON.stringify({ type: "message_start", message: { role: "assistant" } }));
console.log(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.5", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 1000, output: 2000, cacheRead: 3000, cacheWrite: 4000, totalTokens: 10000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.123 } } } }));
`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const result = await spawnPiRole({ cwd, role: "worker", task: "status test", runDir, config, statusKey: "subagent:test-worker", statusLabel: "test-worker", onStatus: (status) => statuses.push(status) });

	assert.equal(result.exitCode, 0);
	assert.equal(statuses.at(-1)?.key, "subagent:test-worker");
	assert.match(statuses.at(-1)?.text ?? "", /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] test-worker: ↑1\.0k ↓2\.0k R3\.0k W4\.0k \$0\.123 .* - finished$/u);
	assert.equal(statuses.some((status) => /↑1\.0k ↓2\.0k R3\.0k W4\.0k \$0\.123 3\.7%\/272k \(auto\) - gpt-5\.5 • medium - finished/.test(status.text ?? "")), true);
	assert.equal(statuses.some((status) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u.test(status.text ?? "")), true);
});

test("orchestrator child forwards nested run_role_agent subagent status", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
const args = { role: "worker", purpose: "implementation", task: "do work" };
const progress = (text) => ({ details: { subagentProgress: { statuses: [{ key: "subagent:worker", text }] } } });
const events = [
	{ type: "message_start", message: { role: "assistant" } },
	{ type: "tool_execution_start", toolName: "run_role_agent", args },
	{ type: "tool_execution_update", toolName: "run_role_agent", args, partialResult: progress("⠋ worker: thinking") },
	{ type: "tool_execution_update", toolName: "run_role_agent", args, partialResult: progress("⠙ worker: ↑1.0k - finished") },
	{ type: "tool_execution_end", toolName: "run_role_agent", args, result: progress("⠹ worker: ↑1.0k - finished") },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "orchestration done" }], stopReason: "stop" } },
];
for (const event of events) console.log(JSON.stringify(event));
`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const result = await spawnPiRole({ cwd, role: "orchestrator", task: "nested status test", runDir, config, statusKey: "subagent:orchestrator", statusLabel: "orchestrator", onStatus: (status) => statuses.push(status) });

	assert.equal(result.exitCode, 0);
	assert.equal(statuses.some((status) => status.key === "subagent:worker" && /worker: .*finished/.test(status.text ?? "")), true);
	assert.equal(statuses.some((status) => status.key === "subagent:orchestrator" && /run_role_agent worker\/implementation/.test(status.text ?? "")), true);
});

test("child status spinner updates faster than model status cadence", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
setTimeout(() => {
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "fake", model: "fake-model", content: [{ type: "text", text: "done" }], stopReason: "stop" } }));
}, 450);
`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const result = await spawnPiRole({ cwd, role: "worker", task: "spinner test", runDir, config, statusKey: "subagent:test-worker", statusLabel: "test-worker", onStatus: (status) => statuses.push(status) });
	const spinnerFrames = new Set(statuses.flatMap((status) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.exec(status.text ?? "")?.[0] ?? []));

	assert.equal(result.exitCode, 0);
	assert.ok(statuses.length >= 3, `expected multiple fast spinner updates, got ${statuses.length}: ${statuses.map((status) => status.text).join(" | ")}`);
	assert.ok(spinnerFrames.size >= 2, `expected spinner to advance frames, got ${[...spinnerFrames].join("")}`);
});

test("parallel workers abort and await siblings after a child setup/spawn failure", async () => {
	const cwd = tempProject();
	const config = cloneConfig();
	config.artifacts.baseDir = ".pi/runs";
	let secondWorkerAborted = false;
	await assert.rejects(() => runParallelWorkers(cwd, { tasks: [{ name: "fail", task: "first" }, { name: "wait", task: "second" }] }, undefined, undefined, {
		loadConfig: () => config,
		async spawnPiRole(input) {
			if (input.task.includes("Name: fail")) throw new Error("spawn failed");
			await new Promise<void>((resolve) => {
				input.signal?.addEventListener("abort", () => {
					secondWorkerAborted = true;
					resolve();
				}, { once: true });
			});
			return fakeCompliantResult(input);
		},
	}), /spawn failed/);
	assert.equal(secondWorkerAborted, true);
});

test("review target reviewers run in parallel and preserve result order", async () => {
	const cwd = tempProject();
	const config = cloneConfig();
	config.artifacts.baseDir = ".pi/runs";
	let activeReviewers = 0;
	let maxActiveReviewers = 0;
	const calls: string[] = [];
	const result = await runReviewTarget(cwd, { target: "inline target", includeScout: false, reviewers: ["b", "a"] }, undefined, undefined, {
		loadConfig: () => config,
		async spawnPiRole(input) {
			calls.push(`${input.role}:${input.task.includes("Assigned review angle: b") ? "b" : input.task.includes("Assigned review angle: a") ? "a" : "synthesis"}`);
			if (input.task.includes("Assigned review angle:")) {
				activeReviewers++;
				maxActiveReviewers = Math.max(maxActiveReviewers, activeReviewers);
				await new Promise((resolve) => setTimeout(resolve, input.task.includes("angle: b") ? 80 : 10));
				activeReviewers--;
			}
			return fakeCompliantResult(input);
		},
	});

	assert.equal(maxActiveReviewers, 2);
	assert.deepEqual(result.reviews.map((review) => review.role), ["reviewer", "reviewer"]);
	assert.equal(result.synthesis.role, "synthesis");
	assert.deepEqual(calls, ["reviewer:b", "reviewer:a", "synthesis:synthesis"]);
});

test("review target writes and passes extra context to scout, reviewers, and synthesis", async () => {
	const cwd = tempProject();
	const contextPath = path.join(cwd, "scout-report.md");
	fs.writeFileSync(contextPath, "prior scout context", "utf8");
	const config = cloneConfig();
	config.artifacts.baseDir = ".pi/runs";
	const tasks: string[] = [];
	const result = await runReviewTarget(cwd, { target: "inline target", extraContext: "@scout-report.md", reviewers: ["runtime bugs"] }, undefined, undefined, {
		loadConfig: () => config,
		async spawnPiRole(input) {
			tasks.push(input.task);
			return fakeCompliantResult(input);
		},
	});

	assert.equal(result.extraContextSource, contextPath);
	assert.equal(fs.readFileSync(path.join(result.runDir, "extra-review-context.md"), "utf8").includes("prior scout context"), true);
	assert.equal(tasks.length, 3);
	assert.equal(tasks.every((task) => task.includes("extra-review-context.md")), true);
	assert.equal(tasks.every((task) => task.includes("verify") || task.includes("unverified")), true);
});

test("review target caps custom reviewer fanout", async () => {
	const cwd = tempProject();
	const config = cloneConfig();
	await assert.rejects(() => runReviewTarget(cwd, { target: "inline target", includeScout: false, reviewers: Array.from({ length: 9 }, (_, index) => `reviewer-${index}`) }, undefined, undefined, {
		loadConfig: () => config,
		async spawnPiRole(input) {
			return fakeResult(input.role, input.runDir);
		},
	}), /at most 8 reviewers/);
});

test("review target rejects non-regular reviewer artifact and writes failure summary", async () => {
	const cwd = tempProject();
	const config = cloneConfig();
	config.artifacts.baseDir = ".pi/runs";
	let summaryPath = "";
	await assert.rejects(async () => {
		try {
			await runReviewTarget(cwd, { target: "inline target", includeScout: false, reviewers: ["runtime bugs"] }, undefined, undefined, {
				loadConfig: () => config,
				async spawnPiRole(input) {
					if (input.task.includes("Assigned review angle:")) {
						fs.mkdirSync(path.join(input.runDir, "review-1-runtime-bugs.md"), { recursive: true });
					}
					return fakeResult(input.role, input.runDir);
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			summaryPath = /Summary: (.+)$/m.exec(message)?.[1] ?? "";
			throw error;
		}
	}, /not a regular file/);
	assert.match(summaryPath, /review-failure-summary\.md$/);
	assert.equal(fs.existsSync(summaryPath), true);
});

test("review target rejects non-regular final summary artifact", async () => {
	const cwd = tempProject();
	const config = cloneConfig();
	config.artifacts.baseDir = ".pi/runs";
	await assert.rejects(() => runReviewTarget(cwd, { target: "inline target", includeScout: false, reviewers: ["runtime bugs"] }, undefined, undefined, {
		loadConfig: () => config,
		async spawnPiRole(input) {
			if (input.task.includes("Synthesize this review-only run")) {
				fs.mkdirSync(path.join(input.runDir, "final-summary.md"), { recursive: true });
				return fakeResult(input.role, input.runDir);
			}
			return fakeCompliantResult(input);
		},
	}), /not a regular file/);
});

test("scout outputFile validates reserved paths before spawning", async () => {
	const cwd = tempProject();
	const config = cloneConfig();
	let spawned = false;
	await assert.rejects(() => runScoutAgent(cwd, { task: "inline scout task", outputFile: "logs" }, undefined, undefined, {
		loadConfig: () => config,
		async spawnPiRole(input) {
			spawned = true;
			return fakeResult(input.role, input.runDir);
		},
	}), /reserved run directory/);
	assert.equal(spawned, false);
});

test("worker outputFile validates reserved paths before spawning", async () => {
	const cwd = tempProject();
	const config = cloneConfig();
	let spawned = false;
	await assert.rejects(() => runWorkerAgent(cwd, { task: "inline task", outputFile: "logs" }, undefined, undefined, {
		loadConfig: () => config,
		async spawnPiRole(input) {
			spawned = true;
			return fakeResult(input.role, input.runDir);
		},
	}), /reserved run directory/);
	assert.equal(spawned, false);
});

test("standalone roles fail when the expected artifact is missing", async () => {
	const cwd = tempProject();
	const config = cloneConfig();
	config.artifacts.baseDir = ".pi/runs";
	await assert.rejects(() => runScoutAgent(cwd, { task: "inline scout task", outputFile: "scout.md" }, undefined, undefined, {
		loadConfig: () => config,
		async spawnPiRole(input) {
			fs.mkdirSync(path.join(input.runDir, "..", "wrong-place"), { recursive: true });
			fs.writeFileSync(path.join(input.runDir, "..", "wrong-place", "scout.md"), "wrong path", "utf8");
			return fakeResult(input.role, input.runDir);
		},
	}), /scout did not write the expected output artifact[\s\S]*Use write_run_artifact/);
});

test("parallel workers collect non-zero child exits without aborting siblings", async () => {
	const cwd = tempProject();
	const config = cloneConfig();
	config.artifacts.baseDir = ".pi/runs";
	let secondSawAbort = false;
	await assert.rejects(() => runParallelWorkers(cwd, { tasks: [{ name: "fail", task: "first" }, { name: "finish", task: "second" }] }, undefined, undefined, {
		loadConfig: () => config,
		async spawnPiRole(input) {
			if (input.task.includes("Name: fail")) return { ...fakeResult(input.role, input.runDir), exitCode: 2 };
			secondSawAbort = input.signal?.aborted ?? false;
			return fakeCompliantResult(input);
		},
	}), /Parallel workers failed: fail exit 2/);
	assert.equal(secondSawAbort, false);
});

test("run_role_agent requires the default output artifact", async () => {
	const oldRole = process.env.PI_ORCHESTRATOR_AGENT_ROLE;
	const oldRunDir = process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
	const oldCli = process.env.PI_SIMPLE_SUBAGENTS_PI_CLI;
	try {
		const cwd = tempProject();
		const runDir = path.join(cwd, ".pi", "run");
		const cli = path.join(cwd, "fake-pi.js");
		fs.writeFileSync(cli, `
const fs = require("node:fs");
const path = require("node:path");
const runDir = process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, "worker.md"), "child done", "utf8");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "fake", model: "fake-model", content: [{ type: "text", text: "child done" }], stopReason: "stop" } }));
`, "utf8");
		process.env.PI_ORCHESTRATOR_AGENT_ROLE = "orchestrator";
		process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR = runDir;
		process.env.PI_SIMPLE_SUBAGENTS_PI_CLI = cli;
		let runRole: { execute: (...args: any[]) => Promise<any> } | undefined;
		orchestratorAgentsExtension({ registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => { if (tool.name === "run_role_agent") runRole = tool; }, registerCommand() {}, sendMessage() {} } as never);
		assert.ok(runRole);
		const result = await runRole.execute("id", { role: "worker", purpose: "implementation", task: "do work" }, new AbortController().signal, undefined, { cwd } as never);
		const expected = path.join(runDir, "worker.md");
		assert.equal(fs.existsSync(expected), true);
		assert.equal(result.details.outputPath, expected);
		assert.match(fs.readFileSync(expected, "utf8"), /child done/);
	} finally {
		if (oldRole === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_ROLE;
		else process.env.PI_ORCHESTRATOR_AGENT_ROLE = oldRole;
		if (oldRunDir === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
		else process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR = oldRunDir;
		if (oldCli === undefined) delete process.env.PI_SIMPLE_SUBAGENTS_PI_CLI;
		else process.env.PI_SIMPLE_SUBAGENTS_PI_CLI = oldCli;
	}
});

test("run_role_agent fails instead of copying child output when artifact is missing", async () => {
	const oldRole = process.env.PI_ORCHESTRATOR_AGENT_ROLE;
	const oldRunDir = process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
	const oldCli = process.env.PI_SIMPLE_SUBAGENTS_PI_CLI;
	try {
		const cwd = tempProject();
		const runDir = path.join(cwd, ".pi", "run");
		const cli = path.join(cwd, "fake-pi.js");
		fs.writeFileSync(cli, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "fake", model: "fake-model", content: [{ type: "text", text: "child output only" }], stopReason: "stop" } }));\n`, "utf8");
		process.env.PI_ORCHESTRATOR_AGENT_ROLE = "orchestrator";
		process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR = runDir;
		process.env.PI_SIMPLE_SUBAGENTS_PI_CLI = cli;
		let runRole: { execute: (...args: any[]) => Promise<any> } | undefined;
		orchestratorAgentsExtension({ registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => { if (tool.name === "run_role_agent") runRole = tool; }, registerCommand() {}, sendMessage() {} } as never);
		assert.ok(runRole);
		const tool = runRole;
		await assert.rejects(() => tool.execute("id", { role: "worker", purpose: "implementation", task: "do work" }, new AbortController().signal, undefined, { cwd } as never), /worker did not write the expected output artifact[\s\S]*Use write_run_artifact/);
		assert.equal(fs.existsSync(path.join(runDir, "worker.md")), false);
	} finally {
		if (oldRole === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_ROLE;
		else process.env.PI_ORCHESTRATOR_AGENT_ROLE = oldRole;
		if (oldRunDir === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
		else process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR = oldRunDir;
		if (oldCli === undefined) delete process.env.PI_SIMPLE_SUBAGENTS_PI_CLI;
		else process.env.PI_SIMPLE_SUBAGENTS_PI_CLI = oldCli;
	}
});

test("write_run_artifact rejects reserved internal run directories", async () => {
	const oldRole = process.env.PI_ORCHESTRATOR_AGENT_ROLE;
	const oldRunDir = process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
	try {
		const runDir = tempProject();
		process.env.PI_ORCHESTRATOR_AGENT_ROLE = "worker";
		process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR = runDir;
		let writeRunArtifact: { execute: (...args: any[]) => Promise<any> } | undefined;
		orchestratorAgentsExtension({ registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => { if (tool.name === "write_run_artifact") writeRunArtifact = tool; }, registerCommand() {}, sendMessage() {} } as never);
		const tool = writeRunArtifact;
		assert.ok(tool);
		await assert.rejects(() => tool.execute("id", { path: "logs/evil.md", content: "evil" }), /reserved run directory/);
		const result = await tool.execute("id", { path: "scout-report.md", content: "ok" });
		assert.match(result.details.path, /scout-report\.md$/);
		assert.equal(fs.readFileSync(path.join(runDir, "scout-report.md"), "utf8"), "ok");
	} finally {
		if (oldRole === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_ROLE;
		else process.env.PI_ORCHESTRATOR_AGENT_ROLE = oldRole;
		if (oldRunDir === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
		else process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR = oldRunDir;
	}
});

test("/work-parallel validates object fields before running", async () => {
	const oldRole = process.env.PI_ORCHESTRATOR_AGENT_ROLE;
	const oldRunDir = process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
	try {
		delete process.env.PI_ORCHESTRATOR_AGENT_ROLE;
		delete process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
		let handler: ((args: string, ctx: { cwd: string; signal: AbortSignal; ui: { notify(message: string, level: string): void; setStatus(): void } }) => Promise<void>) | undefined;
		orchestratorAgentsExtension({ registerTool() {}, registerCommand: (name: string, command: { handler: typeof handler }) => { if (name === "work-parallel") handler = command.handler; }, sendMessage() {} } as never);
		const notifications: string[] = [];
		await handler?.('[{"task":"ok"},{"task":"bad","purpose":"review"}]', { cwd: tempProject(), signal: new AbortController().signal, ui: { notify: (message) => notifications.push(message), setStatus() {} } });
		assert.match(notifications.join("\n"), /purpose must be implementation, fix, or validation/);
		notifications.length = 0;
		await handler?.('["ok","   "]', { cwd: tempProject(), signal: new AbortController().signal, ui: { notify: (message) => notifications.push(message), setStatus() {} } });
		assert.match(notifications.join("\n"), /task must be a non-empty string/);
		notifications.length = 0;
		await handler?.('[{"task":"ok"},{"task":"bad","output_file":"report.md"}]', { cwd: tempProject(), signal: new AbortController().signal, ui: { notify: (message) => notifications.push(message), setStatus() {} } });
		assert.match(notifications.join("\n"), /unknown field: output_file/);
		notifications.length = 0;
		await handler?.('{"tasks":["ok","also ok"],"extra":true}', { cwd: tempProject(), signal: new AbortController().signal, ui: { notify: (message) => notifications.push(message), setStatus() {} } });
		assert.match(notifications.join("\n"), /unknown field: extra/);
	} finally {
		if (oldRole === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_ROLE;
		else process.env.PI_ORCHESTRATOR_AGENT_ROLE = oldRole;
		if (oldRunDir === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
		else process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR = oldRunDir;
	}
});

test("invalid role environment falls back to root registration and warns", () => {
	const oldRole = process.env.PI_ORCHESTRATOR_AGENT_ROLE;
	const oldRunDir = process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
	const oldWarn = console.warn;
	try {
		process.env.PI_ORCHESTRATOR_AGENT_ROLE = "orchestratorx";
		delete process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
		const tools: string[] = [];
		const commands: string[] = [];
		const messages: Array<{ content?: string }> = [];
		const warnings: string[] = [];
		console.warn = (message?: unknown) => { warnings.push(String(message)); };
		assert.doesNotThrow(() => orchestratorAgentsExtension({ registerTool: (tool: { name: string }) => tools.push(tool.name), registerCommand: (name: string) => commands.push(name), sendMessage(message: { content?: string }) { messages.push(message); } } as never));
		assert.equal(tools.includes("orchestrate_plan"), true);
		assert.equal(commands.includes("review"), true);
		assert.match(warnings.join("\n"), /Invalid PI_ORCHESTRATOR_AGENT_ROLE: orchestratorx/);
		assert.match(messages.map((message) => message.content ?? "").join("\n"), /root mode/);
	} finally {
		console.warn = oldWarn;
		if (oldRole === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_ROLE;
		else process.env.PI_ORCHESTRATOR_AGENT_ROLE = oldRole;
		if (oldRunDir === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
		else process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR = oldRunDir;
	}
});

test("extension registration is role-gated", () => {
	const oldRole = process.env.PI_ORCHESTRATOR_AGENT_ROLE;
	const oldRunDir = process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
	try {
		delete process.env.PI_ORCHESTRATOR_AGENT_ROLE;
		delete process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
		const rootTools: string[] = [];
		const rootCommands: string[] = [];
		orchestratorAgentsExtension({ registerTool: (tool: { name: string }) => rootTools.push(tool.name), registerCommand: (name: string) => rootCommands.push(name), sendMessage() {} } as never);
		assert.deepEqual(rootTools.slice(0, 5), ["orchestrate_plan", "review_target", "run_scout_agent", "run_worker_agent", "run_parallel_workers"]);
		assert.equal(rootCommands.includes("scout"), true);
		assert.equal(rootCommands.includes("review"), true);

		process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR = tempProject();
		const staleRunDirTools: string[] = [];
		orchestratorAgentsExtension({ registerTool: (tool: { name: string }) => staleRunDirTools.push(tool.name), registerCommand() {}, sendMessage() {} } as never);
		assert.equal(staleRunDirTools.includes("write_run_artifact"), false);
		delete process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;

		process.env.PI_ORCHESTRATOR_AGENT_ROLE = "orchestrator";
		process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR = tempProject();
		const orchestratorTools: string[] = [];
		orchestratorAgentsExtension({ registerTool: (tool: { name: string }) => orchestratorTools.push(tool.name), registerCommand() {}, sendMessage() {} } as never);
		assert.equal(orchestratorTools.includes("run_role_agent"), true);
		assert.equal(orchestratorTools.includes("write_run_artifact"), true);

		process.env.PI_ORCHESTRATOR_AGENT_ROLE = "worker";
		const workerTools: string[] = [];
		orchestratorAgentsExtension({ registerTool: (tool: { name: string }) => workerTools.push(tool.name), registerCommand() {}, sendMessage() {} } as never);
		assert.equal(workerTools.includes("run_role_agent"), false);
		assert.equal(workerTools.includes("write_run_artifact"), true);
	} finally {
		if (oldRole === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_ROLE;
		else process.env.PI_ORCHESTRATOR_AGENT_ROLE = oldRole;
		if (oldRunDir === undefined) delete process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR;
		else process.env.PI_ORCHESTRATOR_AGENT_RUN_DIR = oldRunDir;
	}
});
