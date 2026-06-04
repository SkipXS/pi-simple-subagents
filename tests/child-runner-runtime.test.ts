import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setChildRunnerPlatformForTests, setChildRunnerTaskkillForTests, spawnPiRole } from "../extensions/pi-simple-subagents/child-runner.ts";
import { DEFAULT_CONFIG, type Config } from "../extensions/pi-simple-subagents/config.ts";

function tempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-runtime-test-"));
}

function cloneConfig(): Config {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
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
