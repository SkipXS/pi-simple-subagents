import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setChildRunnerKillFallbackMsForTests, setChildRunnerPlatformForTests, setChildRunnerTaskkillForTests, setChildRunnerTerminalCloseGraceMsForTests, spawnPiRole } from "../extensions/pi-simple-subagents/child-runner.ts";
import { DEFAULT_CONFIG, type Config } from "../extensions/pi-simple-subagents/config.ts";

function tempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-runtime-test-"));
}

function cloneConfig(): Config {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await sleep(25);
	}
	return !isProcessAlive(pid);
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(filePath)) return true;
		await sleep(25);
	}
	return fs.existsSync(filePath);
}

test("pre-aborted child runs do not create artifacts or spawn a child", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const spawnedMarker = path.join(cwd, "spawned.txt");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `require("node:fs").writeFileSync(${JSON.stringify(spawnedMarker)}, "spawned");`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;
	const controller = new AbortController();
	controller.abort();

	const result = await spawnPiRole({ cwd, role: "worker", task: "must not start", runDir, config, signal: controller.signal });

	assert.equal(result.exitCode, 130);
	assert.equal(result.stopReason, "aborted");
	assert.match(result.output, /aborted before start/i);
	assert.equal(fs.existsSync(spawnedMarker), false);
	assert.equal(fs.existsSync(runDir), false);
});

test("exit-0 child with non-JSON stdout and no assistant event fails with diagnostics", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
console.log("hello from a broken wrapper");
`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;

	const result = await spawnPiRole({ cwd, role: "worker", task: "malformed stdout", runDir, config });

	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "error");
	assert.match(result.output, /non-JSON line/i);
	assert.match(result.output, /without a parsed assistant message_end/i);
	assert.match(result.output, /hello from a broken wrapper/);
	assert.equal(result.output.includes("(no output)"), false);
});

test("single-line JSONL stdout below the 4 MiB hard cap is parsed instead of reported as no output", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
const text = "long-jsonl-output-" + "x".repeat(1024 * 1024 + 128);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }));
`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;

	const result = await spawnPiRole({ cwd, role: "worker", task: "long stdout", runDir, config });

	assert.equal(result.exitCode, 0);
	assert.match(result.output, /^long-jsonl-output-/);
	assert.equal(result.output.includes("(no output)"), false);
	assert.equal(result.outputTruncated, true);
	assert.ok(result.outputBytes > 1024 * 1024);
});

test("stdout JSONL lines beyond the hard cap fail with a clear oversized-output error", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
process.stdout.write("{" + "x".repeat(5 * 1024 * 1024));
setTimeout(() => {}, 10000);
`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;
	config.children.timeoutMs = 5000;

	const result = await spawnPiRole({ cwd, role: "worker", task: "oversized stdout", runDir, config });

	assert.notEqual(result.exitCode, 0);
	assert.match(result.output, /JSONL line exceeded \d+ bytes/i);
	assert.equal(result.output.includes("(no output)"), false);
});

test("oversized stdout failure is not masked by later assistant output", async (t) => {
	if (process.platform === "win32") {
		t.skip("Windows taskkill forcibly terminates the fake child before it can emit later stdout");
		return;
	}
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
process.on("SIGTERM", () => {});
async function writeOversizedLineThenLaterOutput() {
  process.stdout.write("{");
  const chunk = "x".repeat(64 * 1024);
  for (let index = 0; index < 80; index++) {
    if (!process.stdout.write(chunk)) await new Promise((resolve) => process.stdout.once("drain", resolve));
  }
  setTimeout(() => {
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "later output masked error" }], stopReason: "stop" } }));
    process.exit(0);
  }, 50);
}
writeOversizedLineThenLaterOutput();
`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;
	config.children.timeoutMs = 5000;

	const result = await spawnPiRole({ cwd, role: "worker", task: "oversized stdout mask", runDir, config });

	assert.notEqual(result.exitCode, 0);
	assert.equal(result.stopReason, "error");
	assert.match(result.output, /JSONL line exceeded \d+ bytes/i);
	assert.equal(result.output.includes("later output masked error"), false);
});

test("buffered transcript and stderr chunks are flushed on normal completion", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
for (let index = 0; index < 40; index++) {
  process.stdout.write(JSON.stringify({ type: "message_start", index }) + "\\n");
  process.stderr.write(` + "`stderr-${index}\\n`" + `);
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "buffered final" }], stopReason: "stop" } }));
`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;

	const result = await spawnPiRole({ cwd, role: "worker", task: "buffered artifact flush", runDir, config });

	assert.equal(result.exitCode, 0);
	assert.equal(result.stopReason, "stop");
	assert.match(result.output, /buffered final/);
	const transcript = fs.readFileSync(result.transcriptPath, "utf8");
	assert.match(transcript, /"index":0/);
	assert.match(transcript, /"index":39/);
	assert.match(transcript, /buffered final/);
	const stderr = fs.readFileSync(result.stderrPath, "utf8");
	assert.match(stderr, /stderr-0/);
	assert.match(stderr, /stderr-39/);
});

test("buffered transcript and stderr caps write one marker and preserve utf8", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
async function write(stream, text) {
  if (!stream.write(text)) await new Promise((resolve) => stream.once("drain", resolve));
}
(async () => {
  const transcriptPayload = "😀".repeat(2048);
  for (let index = 0; index < 560; index++) {
    await write(process.stdout, JSON.stringify({ type: "message_start", index, transcriptPayload }) + "\\n");
  }
  const stderrPayload = "é".repeat(4096);
  for (let index = 0; index < 300; index++) {
    await write(process.stderr, ` + "`stderr-${index}-${stderrPayload}\\n`" + `);
  }
  await write(process.stdout, JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "capped final" }], stopReason: "stop" } }) + "\\n");
})().catch((error) => { console.error(error); process.exitCode = 1; });
`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;

	const result = await spawnPiRole({ cwd, role: "worker", task: "buffered artifact caps", runDir, config });

	assert.equal(result.exitCode, 0);
	assert.equal(result.stopReason, "stop");
	assert.match(result.output, /capped final/);
	const capMarker = /\[Artifact cap reached at \d+ bytes; further output omitted\.\]/g;
	const transcript = fs.readFileSync(result.transcriptPath, "utf8");
	assert.equal(transcript.match(capMarker)?.length, 1);
	assert.doesNotMatch(transcript, /\uFFFD/);
	assert.match(transcript, /"index":0/);
	const stderr = fs.readFileSync(result.stderrPath, "utf8");
	assert.equal(stderr.match(capMarker)?.length, 1);
	assert.doesNotMatch(stderr, /\uFFFD/);
	assert.match(stderr, /stderr-0/);
});

test("orchestrator default timeout is disabled while child role timeout remains configured", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
setTimeout(() => {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "orchestrator completed after child timeout" }], stopReason: "stop" } }));
}, 120);
`, "utf8");
	const config = cloneConfig();
	config.children.piCliPath = cli;
	config.children.timeoutMs = 50;

	const result = await spawnPiRole({ cwd, role: "orchestrator", task: "long orchestration", runDir, config });

	assert.equal(result.exitCode, 0);
	assert.equal(result.timedOut, false);
	assert.match(result.output, /orchestrator completed after child timeout/);
});

test("timeout on Windows uses taskkill cleanup path and still finalizes artifacts", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const taskkillLog = path.join(cwd, "taskkill-args.json");
	const taskkillRecorder = path.join(cwd, "taskkill-recorder.js");
	fs.writeFileSync(taskkillRecorder, `require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n`, "utf8");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "started" }], stopReason: "stop" } }));
setTimeout(() => process.exit(0), 250);
`, "utf8");
	try {
		setChildRunnerPlatformForTests("win32");
		setChildRunnerTaskkillForTests({ command: process.execPath, argsPrefix: [taskkillRecorder, taskkillLog] });
		const config = cloneConfig();
		config.children.piCliPath = cli;
		config.children.timeoutMs = 50;

		const result = await spawnPiRole({ cwd, role: "worker", task: "timeout taskkill", runDir, config });

		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, 124);
		assert.equal(result.stopReason, "timed_out");
		assert.match(result.stderr, /Child run timed out after 50 ms/);
		assert.equal(fs.existsSync(result.outputPath), true);
		assert.equal(fs.existsSync(result.transcriptPath), true);
		assert.equal(fs.existsSync(result.stderrPath), true);
		assert.equal(await waitForFile(taskkillLog, 1000), true);
		const taskkillArgs = JSON.parse(fs.readFileSync(taskkillLog, "utf8")) as string[];
		assert.equal(taskkillArgs[0]?.toLowerCase(), "/pid");
		assert.match(taskkillArgs[1] ?? "", /^\d+$/);
		assert.equal(taskkillArgs[2]?.toLowerCase(), "/t");
		assert.equal(taskkillArgs[3]?.toLowerCase(), "/f");
	} finally {
		setChildRunnerPlatformForTests(undefined);
		setChildRunnerTaskkillForTests(undefined);
	}
});

test("non-terminal toolUse assistant output does not trigger lingering-process cleanup", async () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "toolUse" } }));
setTimeout(() => {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final after tool use" }], stopReason: "stop" } }));
}, 120);
`, "utf8");
	try {
		setChildRunnerTerminalCloseGraceMsForTests(50);
		const config = cloneConfig();
		config.children.piCliPath = cli;
		config.children.timeoutMs = 5000;

		const result = await spawnPiRole({ cwd, role: "worker", task: "tool use then final", runDir, config });

		assert.equal(result.exitCode, 0);
		assert.equal(result.stopReason, "stop");
		assert.match(result.output, /final after tool use/);
		assert.doesNotMatch(fs.readFileSync(result.stderrPath, "utf8"), /stayed alive after terminal assistant output/);
	} finally {
		setChildRunnerTerminalCloseGraceMsForTests(undefined);
	}
});

test("terminal assistant output terminates lingering child process tree without failing the run", async (t) => {
	if (process.env.CI && process.platform !== "linux") {
		t.skip("non-Linux CI runners are flaky for process-tree termination timing; Linux CI and local Windows runs cover this behavior");
		return;
	}
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const lingeringPidFile = path.join(cwd, "lingering.pid");
	const lingering = path.join(cwd, "lingering.js");
	fs.writeFileSync(lingering, `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`, "utf8");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, [${JSON.stringify(lingering)}], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(lingeringPidFile)}, String(child.pid));
child.unref();
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "terminal output" }], stopReason: "stop" } }));
setInterval(() => {}, 1000);
`, "utf8");
	let lingeringPid: number | undefined;
	try {
		setChildRunnerTerminalCloseGraceMsForTests(50);
		setChildRunnerKillFallbackMsForTests(100);
		const config = cloneConfig();
		config.children.piCliPath = cli;
		config.children.timeoutMs = 5000;

		const result = await spawnPiRole({ cwd, role: "worker", task: "terminal cleanup", runDir, config });

		assert.equal(result.exitCode, 0);
		assert.equal(result.stopReason, "stop");
		assert.match(result.output, /terminal output/);
		lingeringPid = Number(fs.readFileSync(lingeringPidFile, "utf8"));
		assert.ok(Number.isInteger(lingeringPid) && lingeringPid > 0);
		assert.equal(await waitForProcessExit(lingeringPid, 1000), true);
		assert.match(fs.readFileSync(result.stderrPath, "utf8"), /stayed alive after terminal assistant output/);
	} finally {
		setChildRunnerTerminalCloseGraceMsForTests(undefined);
		setChildRunnerKillFallbackMsForTests(undefined);
		if (lingeringPid && isProcessAlive(lingeringPid)) {
			try { process.kill(lingeringPid, "SIGKILL"); } catch {}
		}
	}
});

test("timeout keeps Unix kill fallback alive long enough to kill process-group descendants", async (t) => {
	if (process.platform === "win32") {
		t.skip("Unix process-group fallback does not run on Windows");
		return;
	}
	if (process.env.CI && process.platform !== "linux") {
		t.skip("non-Linux CI runners are flaky for process-group descendant timing; Linux CI covers this behavior");
		return;
	}
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "run");
	const descendantPidFile = path.join(cwd, "descendant.pid");
	const descendant = path.join(cwd, "descendant.js");
	fs.writeFileSync(descendant, `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`, "utf8");
	const cli = path.join(cwd, "fake-pi.js");
	fs.writeFileSync(cli, `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));
child.unref();
setInterval(() => {}, 1000);
`, "utf8");
	let descendantPid: number | undefined;
	try {
		setChildRunnerKillFallbackMsForTests(100);
		const config = cloneConfig();
		config.children.piCliPath = cli;
		config.children.timeoutMs = 50;

		const result = await spawnPiRole({ cwd, role: "worker", task: "timeout descendant cleanup", runDir, config });

		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, 124);
		descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
		assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
		assert.equal(await waitForProcessExit(descendantPid, 1000), true);
	} finally {
		setChildRunnerKillFallbackMsForTests(undefined);
		if (descendantPid && isProcessAlive(descendantPid)) {
			try { process.kill(descendantPid, "SIGKILL"); } catch {}
		}
	}
});
