import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../extensions/pi-simple-subagents/config.ts";
import { readReference } from "../extensions/pi-simple-subagents/references.ts";
import { validateRolePurpose } from "../extensions/pi-simple-subagents/roles.ts";
import { ACTIVE_RUN_MARKER_FILE, appendArtifactFile, cleanupRunArtifacts, clearRunActive, copyArtifactFile, markRunActive, resolveArtifactPath, resolveRoleSessionFile, resolveRunBaseDir, validateOutputArtifactPath, writeArtifact } from "../extensions/pi-simple-subagents/artifacts.ts";
import { readOrchestrationState } from "../extensions/pi-simple-subagents/state.ts";

function tempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-test-"));
}

test("default config keeps YOLO roles but adds child/reference guardrails", () => {
	const cwd = tempProject();
	const config = loadConfig(cwd);

	assert.equal("workflow" in config, false);
	assert.equal("inheritExtensions" in config.children, false);
	assert.equal("inheritExtensionsForReadOnly" in config.children, false);
	assert.equal("inheritSkills" in config.children, false);
	assert.equal(config.children.forwardCurrentExtension, "auto");
	assert.equal(config.children.timeoutMs, 30 * 60 * 1000);
	assert.equal(config.children.maxConcurrentSubagents, 8);
	assert.equal(config.orchestration.maxWorkerTaskBytes, 16 * 1024);
	assert.equal(config.references.maxFileBytes, 1024 * 1024);
	assert.equal(config.references.allowOutsideCwd, false);
	assert.equal(config.references.allowBinary, false);
	assert.equal("allowOutsideCwd" in config.artifacts, false);
	assert.equal(config.artifacts.cleanup.maxAgeMs, 0);
	assert.equal(config.artifacts.cleanup.maxTotalBytes, 0);
	for (const role of Object.values(config.roles)) assert.equal("tools" in role, false);
});

test("guardrail config keys are parsed and pre-1.0 legacy keys are not accepted", () => {
	const cwd = tempProject();
	const configPath = path.join(cwd, ".pi", "pi-simple-subagents", "config.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({
		roles: { worker: { model: "openai-codex/gpt-5.5", thinking: "low" } },
		children: { timeoutMs: 1, maxConcurrentSubagents: 2 },
		orchestration: { maxWorkerTaskBytes: 2 },
		references: { maxFileBytes: 1, allowOutsideCwd: true, allowBinary: true },
		artifacts: { baseDir: ".pi/custom-runs", cleanup: { maxAgeMs: 1000, maxTotalBytes: 2048 } },
	}), "utf8");

	const config = loadConfig(cwd);

	assert.equal(config.roles.worker.thinking, "low");
	assert.equal(config.children.timeoutMs, 1);
	assert.equal(config.children.maxConcurrentSubagents, 2);
	assert.equal(config.orchestration.maxWorkerTaskBytes, 2);
	assert.equal(config.references.maxFileBytes, 1);
	assert.equal(config.references.allowOutsideCwd, true);
	assert.equal(config.references.allowBinary, true);
	assert.equal(config.artifacts.baseDir, ".pi/custom-runs");
	assert.equal(config.artifacts.cleanup.maxAgeMs, 1000);
	assert.equal(config.artifacts.cleanup.maxTotalBytes, 2048);

	fs.writeFileSync(configPath, JSON.stringify({ workflow: {} }), "utf8");
	assert.throws(() => loadConfig(cwd), /root contains unknown key: workflow/);

	fs.writeFileSync(configPath, JSON.stringify({ roles: { worker: { tools: ["read"] } } }), "utf8");
	assert.throws(() => loadConfig(cwd), /roles\.worker contains unknown key: tools/);

	fs.writeFileSync(configPath, JSON.stringify({ children: { inheritExtensions: false } }), "utf8");
	assert.throws(() => loadConfig(cwd), /children contains unknown key: inheritExtensions/);

	fs.writeFileSync(configPath, JSON.stringify({ children: { inheritExtensionsForReadOnly: false } }), "utf8");
	assert.throws(() => loadConfig(cwd), /children contains unknown key: inheritExtensionsForReadOnly/);

	fs.writeFileSync(configPath, JSON.stringify({ children: { inheritSkills: false } }), "utf8");
	assert.throws(() => loadConfig(cwd), /children contains unknown key: inheritSkills/);

	fs.writeFileSync(configPath, JSON.stringify({ children: { maxConcurrentSubagents: 0 } }), "utf8");
	assert.throws(() => loadConfig(cwd), /children\.maxConcurrentSubagents must be a positive integer/);

	fs.writeFileSync(configPath, JSON.stringify({ children: { piCliPath: "/tmp/pi" } }), "utf8");
	assert.throws(() => loadConfig(cwd), /piCliPath is only allowed in the global config/);
});

test("config rejects unknown keys so typos are visible", () => {
	const cwd = tempProject();
	const configPath = path.join(cwd, ".pi", "pi-simple-subagents", "config.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });

	fs.writeFileSync(configPath, JSON.stringify({ children: { timeuotMs: 1 } }), "utf8");
	assert.throws(() => loadConfig(cwd), /children contains unknown key: timeuotMs/);

	fs.writeFileSync(configPath, JSON.stringify({ roles: { worker: { thinkng: "high" } } }), "utf8");
	assert.throws(() => loadConfig(cwd), /roles\.worker contains unknown key: thinkng/);

	fs.writeFileSync(configPath, JSON.stringify({ references: { allowBinary: true, maxFileBytez: 1 } }), "utf8");
	assert.throws(() => loadConfig(cwd), /references contains unknown key: maxFileBytez/);

	fs.writeFileSync(configPath, JSON.stringify({ orchestration: { maxWorkerTaskBytez: 1 } }), "utf8");
	assert.throws(() => loadConfig(cwd), /orchestration contains unknown key: maxWorkerTaskBytez/);
});

test("references enforce outside-cwd and binary guardrails by default", () => {
	const cwd = tempProject();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-outside-"));
	const textPath = path.join(outside, "outside.txt");
	fs.writeFileSync(textPath, "secret-ish", "utf8");
	const binaryPath = path.join(cwd, "binary.bin");
	fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3, 255]));
	const config = loadConfig(cwd);

	assert.throws(() => readReference(cwd, `@${textPath}`, "plan", config), /outside the current project/);
	assert.throws(() => readReference(cwd, `@${binaryPath}`, "plan", config), /binary or non-text/);
});

test("references enforce outside-cwd guardrails through symlinks and junctions", (t) => {
	const cwd = tempProject();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-outside-"));
	const secretPath = path.join(outside, "secret.txt");
	fs.writeFileSync(secretPath, "secret-ish", "utf8");
	const linkPath = path.join(cwd, "outside-link");
	try {
		fs.symlinkSync(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		t.skip(`symlink/junction creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const config = loadConfig(cwd);

	assert.throws(() => readReference(cwd, "@outside-link/secret.txt", "plan", config), /outside the current project/);
	assert.throws(() => readReference(cwd, "@outside-link", "target", config, { allowDirectory: true }), /outside the current project/);

	config.references.allowOutsideCwd = true;
	const result = readReference(cwd, "@outside-link/secret.txt", "plan", config);
	assert.equal(result.source, fs.realpathSync.native(secretPath));
	assert.equal(result.text, "secret-ish");
	assert.match(result.warnings.join("\n"), /outside/);
});

test("references can intentionally allow outside, binary, and truncate large files", () => {
	const cwd = tempProject();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-outside-"));
	const largePath = path.join(outside, "large.txt");
	fs.writeFileSync(largePath, "x".repeat(600 * 1024), "utf8");
	const binaryPath = path.join(outside, "binary.bin");
	fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3, 255]));
	const config = loadConfig(cwd);
	config.references.allowOutsideCwd = true;
	config.references.allowBinary = true;
	config.references.maxFileBytes = 10;

	const large = readReference(cwd, `@${largePath}`, "plan", config);
	const binary = readReference(cwd, `@${binaryPath}`, "plan", config);

	assert.equal(large.source, largePath);
	assert.match(large.text, /^x{10}/);
	assert.match(large.text, /Reference truncated/);
	assert.match(large.warnings.join("\n"), /truncated|outside/);
	assert.equal(binary.source, binaryPath);
	assert.match(binary.warnings.join("\n"), /binary|non-text/);
});

test("artifact absolute paths inside the run dir are not rewritten as relative names", () => {
	const runDir = tempProject();
	const absoluteLog = path.join(runDir, "logs", "child.jsonl");
	const outside = path.join(tempProject(), "outside.log");

	assert.equal(resolveArtifactPath(runDir, absoluteLog), absoluteLog);
	assert.throws(() => resolveArtifactPath(runDir, outside), /escapes run dir/);

	const written = writeArtifact(runDir, absoluteLog, "first\n");
	appendArtifactFile(runDir, written, "second\n");
	appendArtifactFile(runDir, "logs/child.jsonl", "third\n");

	assert.equal(written, absoluteLog);
	assert.equal(fs.readFileSync(absoluteLog, "utf8"), "first\nsecond\nthird\n");
});

test("artifact writes do not follow existing links outside the run dir", () => {
	const runDir = tempProject();
	const outside = path.join(tempProject(), "outside.txt");
	fs.writeFileSync(outside, "outside", "utf8");
	const hardlink = path.join(runDir, "linked.txt");
	fs.linkSync(outside, hardlink);

	assert.throws(() => appendArtifactFile(runDir, hardlink, "mutate"), /multiple hard links/);
	writeArtifact(runDir, "linked.txt", "replacement");
	assert.equal(fs.readFileSync(outside, "utf8"), "outside");
	assert.equal(fs.readFileSync(hardlink, "utf8"), "replacement");

	fs.writeFileSync(outside, "copy-source", "utf8");
	copyArtifactFile(runDir, outside, hardlink);
	assert.equal(fs.readFileSync(outside, "utf8"), "copy-source");
	assert.equal(fs.readFileSync(hardlink, "utf8"), "copy-source");
});

test("child session files reject existing hard links and non-files", () => {
	const runDir = tempProject();
	const outside = path.join(tempProject(), "outside-session.jsonl");
	fs.writeFileSync(outside, "outside", "utf8");
	fs.mkdirSync(path.join(runDir, "sessions"), { recursive: true });
	fs.linkSync(outside, path.join(runDir, "sessions", "worker.jsonl"));

	assert.throws(() => resolveRoleSessionFile(runDir, "worker"), /multiple hard links/);
	assert.equal(fs.readFileSync(outside, "utf8"), "outside");

	fs.rmSync(path.join(runDir, "sessions", "worker.jsonl"), { force: true });
	fs.mkdirSync(path.join(runDir, "sessions", "worker.jsonl"));
	assert.throws(() => resolveRoleSessionFile(runDir, "worker"), /not a regular file/);
});

test("output artifact targets reject reserved dirs, directories, and hard links", () => {
	const runDir = tempProject();
	assert.throws(() => validateOutputArtifactPath(runDir, "/tmp/report.md"), /relative to the run dir/);
	assert.throws(() => validateOutputArtifactPath(runDir, "logs"), /reserved run directory/);
	assert.throws(() => validateOutputArtifactPath(runDir, "sessions/worker-report.md"), /reserved run directory/);
	assert.throws(() => validateOutputArtifactPath(runDir, "input-plan.md"), /protected run file/);
	assert.throws(() => validateOutputArtifactPath(runDir, "config-effective.json"), /protected run file/);
	assert.throws(() => validateOutputArtifactPath(runDir, ".pi-simple-subagents-active-run"), /protected run file/);
	assert.equal(validateOutputArtifactPath(runDir, "reports/input-plan.md"), path.join(runDir, "reports", "input-plan.md"));
	fs.mkdirSync(path.join(runDir, "report.md"));
	assert.throws(() => validateOutputArtifactPath(runDir, "report.md"), /not a regular file/);

	const outside = path.join(tempProject(), "outside-report.md");
	fs.writeFileSync(outside, "outside", "utf8");
	const hardlink = path.join(runDir, "linked-report.md");
	fs.linkSync(outside, hardlink);
	assert.throws(() => validateOutputArtifactPath(runDir, "linked-report.md"), /multiple hard links/);
});

test("artifact base dir rejects symlinks and junctions", (t) => {
	const cwd = tempProject();
	const outside = tempProject();
	const piDir = path.join(cwd, ".pi");
	try {
		fs.symlinkSync(outside, piDir, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		t.skip(`symlink/junction creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const config = loadConfig(cwd);
	assert.throws(() => resolveRunBaseDir(cwd, config), /symbolic link|junction/);
});

function makeOwnedRun(baseDir: string, name: string, contentBytes: number, mtimeMs: number): string {
	const dir = path.join(baseDir, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "config-effective.json"), "{}", "utf8");
	fs.writeFileSync(path.join(dir, "payload.txt"), "x".repeat(contentBytes), "utf8");
	const date = new Date(mtimeMs);
	fs.utimesSync(path.join(dir, "config-effective.json"), date, date);
	fs.utimesSync(path.join(dir, "payload.txt"), date, date);
	fs.utimesSync(dir, date, date);
	return dir;
}

test("artifact cleanup is disabled by default", () => {
	const baseDir = tempProject();
	const oldRun = makeOwnedRun(baseDir, "old-run", 10, 1000);
	const config = loadConfig(tempProject());
	const result = cleanupRunArtifacts(baseDir, config, undefined, 10_000);

	assert.equal(result, undefined);
	assert.equal(fs.existsSync(oldRun), true);
});

test("artifact cleanup deletes old owned runs while preserving current and foreign dirs", () => {
	const baseDir = tempProject();
	const oldRun = makeOwnedRun(baseDir, "old-run", 10, 1000);
	const activeRun = makeOwnedRun(baseDir, "active-run", 10, 1000);
	const freshRun = makeOwnedRun(baseDir, "fresh-run", 10, 9000);
	const foreignDir = path.join(baseDir, "foreign-dir");
	fs.mkdirSync(foreignDir);
	fs.writeFileSync(path.join(foreignDir, "payload.txt"), "foreign", "utf8");
	const config = loadConfig(tempProject());
	config.artifacts.cleanup.maxAgeMs = 5000;

	const result = cleanupRunArtifacts(baseDir, config, activeRun, 10_000);

	assert.equal(result?.deletedRuns, 1);
	assert.equal(fs.existsSync(oldRun), false);
	assert.equal(fs.existsSync(activeRun), true);
	assert.equal(fs.existsSync(freshRun), true);
	assert.equal(fs.existsSync(foreignDir), true);
});

test("artifact cleanup enforces total size by deleting oldest non-active runs", () => {
	const baseDir = tempProject();
	const oldest = makeOwnedRun(baseDir, "001-oldest", 50, 1000);
	const middle = makeOwnedRun(baseDir, "002-middle", 50, 2000);
	const newest = makeOwnedRun(baseDir, "003-newest", 50, 3000);
	const activeRun = makeOwnedRun(baseDir, "004-active", 100, 4000);
	const config = loadConfig(tempProject());
	config.artifacts.cleanup.maxTotalBytes = 175;

	const result = cleanupRunArtifacts(baseDir, config, activeRun, 10_000);

	assert.ok((result?.deletedRuns ?? 0) >= 2);
	assert.equal(fs.existsSync(oldest), false);
	assert.equal(fs.existsSync(middle), false);
	assert.equal(fs.existsSync(newest), true);
	assert.equal(fs.existsSync(activeRun), true);
});

test("artifact cleanup preserves other marked active runs during age cleanup", () => {
	const baseDir = tempProject();
	const oldInactive = makeOwnedRun(baseDir, "old-inactive", 10, 1000);
	const otherActive = makeOwnedRun(baseDir, "other-active", 10, 1000);
	const currentRun = makeOwnedRun(baseDir, "current", 10, 1000);
	markRunActive(otherActive);
	const config = loadConfig(tempProject());
	config.artifacts.cleanup.maxAgeMs = 5000;

	const result = cleanupRunArtifacts(baseDir, config, currentRun, 10_000);

	assert.equal(result?.deletedRuns, 1);
	assert.equal(fs.existsSync(oldInactive), false);
	assert.equal(fs.existsSync(otherActive), true);
	assert.equal(fs.existsSync(path.join(otherActive, ACTIVE_RUN_MARKER_FILE)), true);
	assert.equal(fs.existsSync(currentRun), true);
});

test("artifact cleanup preserves other marked active runs during size cleanup", () => {
	const baseDir = tempProject();
	const oldInactive = makeOwnedRun(baseDir, "001-old-inactive", 50, 1000);
	const otherActive = makeOwnedRun(baseDir, "002-other-active", 50, 2000);
	const newest = makeOwnedRun(baseDir, "003-newest", 50, 3000);
	const currentRun = makeOwnedRun(baseDir, "004-current", 50, 4000);
	markRunActive(otherActive);
	const config = loadConfig(tempProject());
	config.artifacts.cleanup.maxTotalBytes = 125;

	const result = cleanupRunArtifacts(baseDir, config, currentRun, 10_000);

	assert.ok((result?.deletedRuns ?? 0) >= 1);
	assert.equal(fs.existsSync(oldInactive), false);
	assert.equal(fs.existsSync(otherActive), true);
	assert.equal(fs.existsSync(newest), true);
	assert.equal(fs.existsSync(currentRun), true);
});

test("active run markers are created and cleared", () => {
	const runDir = makeOwnedRun(tempProject(), "run", 1, 1000);
	const marker = markRunActive(runDir);
	assert.equal(marker, path.join(runDir, ACTIVE_RUN_MARKER_FILE));
	assert.equal(fs.existsSync(marker), true);
	clearRunActive(runDir);
	assert.equal(fs.existsSync(marker), false);
});

test("role and purpose combinations are validated", () => {
	assert.doesNotThrow(() => validateRolePurpose("worker", "implementation"));
	assert.doesNotThrow(() => validateRolePurpose("worker", "fix"));
	assert.doesNotThrow(() => validateRolePurpose("worker", "validation"));
	assert.doesNotThrow(() => validateRolePurpose("scout", "context"));
	assert.doesNotThrow(() => validateRolePurpose("reviewer", "review"));
	assert.throws(() => validateRolePurpose("worker", "review"), /Invalid role\/purpose/);
	assert.throws(() => validateRolePurpose("reviewer", "implementation"), /Invalid role\/purpose/);
});

test("corrupt orchestration state is quarantined and ignored", () => {
	const runDir = tempProject();
	writeArtifact(runDir, "orchestration-state.json", "{not json");

	const state = readOrchestrationState(runDir);
	const quarantined = fs.readdirSync(runDir).filter((name) => name.startsWith("orchestration-state.invalid-"));

	assert.equal(state, undefined);
	assert.equal(quarantined.length, 1);
});
