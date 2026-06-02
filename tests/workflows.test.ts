import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPiInvocation, quoteAtReferencePath, shouldForwardCurrentExtension, spawnPiRole, wasLoadedWithExtensionFlag, type ChildRunResult } from "../extensions/pi-simple-subagents/child-runner.ts";
import { DEFAULT_CONFIG, type Config } from "../extensions/pi-simple-subagents/config.ts";
import orchestratorAgentsExtension from "../extensions/pi-simple-subagents/index.ts";
import { runParallelWorkers, runReviewTarget, parseReviewTargetCommand } from "../extensions/pi-simple-subagents/workflows.ts";

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

test("parseReviewTargetCommand preserves existing simple syntax", () => {
	assert.deepEqual(parseReviewTargetCommand("@src/index.ts security focus"), {
		target: "@src/index.ts",
		focus: "security focus",
	});
});

test("parseReviewTargetCommand supports scout and reviewer command options", () => {
	assert.deepEqual(parseReviewTargetCommand("--no-scout --reviewer \"security and boundaries\" @\"dir with spaces\" runtime bugs"), {
		target: "@\"dir with spaces\"",
		focus: "runtime bugs",
		reviewers: ["security and boundaries"],
		includeScout: false,
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
	assert.throws(() => parseReviewTargetCommand("--no-scout"), /\/review requires a target/);
});

test("child task @ references are quoted for whitespace paths", () => {
	assert.equal(quoteAtReferencePath("/tmp/pi task.md"), "@\"/tmp/pi task.md\"");
	assert.equal(quoteAtReferencePath("C:\\Users\\Name With Spaces\\task.md"), "@\"C:\\\\Users\\\\Name With Spaces\\\\task.md\"");
	assert.equal(quoteAtReferencePath("/tmp/pi-task.md"), "@/tmp/pi-task.md");
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
			return fakeResult(input.role, input.runDir);
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
			return fakeResult(input.role, input.runDir);
		},
	});

	assert.equal(maxActiveReviewers, 2);
	assert.deepEqual(result.reviews.map((review) => review.role), ["reviewer", "reviewer"]);
	assert.deepEqual(calls.slice(0, 2), ["reviewer:b", "reviewer:a"]);
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
	} finally {
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
		assert.deepEqual(rootTools.slice(0, 4), ["orchestrate_plan", "review_target", "run_worker_agent", "run_parallel_workers"]);
		assert.equal(rootCommands.includes("review"), true);

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
