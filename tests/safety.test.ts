import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../extensions/pi-simple-subagents/config.ts";
import { readReference } from "../extensions/pi-simple-subagents/references.ts";
import { validateRolePurpose } from "../extensions/pi-simple-subagents/roles.ts";
import { appendArtifactFile, copyArtifactFile, writeArtifact } from "../extensions/pi-simple-subagents/artifacts.ts";
import { readOrchestrationState } from "../extensions/pi-simple-subagents/state.ts";

function tempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-test-"));
}

test("default config keeps YOLO roles but adds child/reference guardrails", () => {
	const cwd = tempProject();
	const config = loadConfig(cwd);

	assert.equal("workflow" in config, false);
	assert.equal(config.children.forwardCurrentExtension, "auto");
	assert.equal(config.children.timeoutMs, 30 * 60 * 1000);
	assert.equal(config.references.maxFileBytes, 1024 * 1024);
	assert.equal(config.references.allowOutsideCwd, false);
	assert.equal(config.references.allowBinary, false);
	assert.equal("allowOutsideCwd" in config.artifacts, false);
	for (const role of Object.values(config.roles)) assert.equal("tools" in role, false);
});

test("guardrail config keys are parsed while unrelated legacy workflow keys are ignored", () => {
	const cwd = tempProject();
	const configPath = path.join(cwd, ".pi", "pi-simple-subagents", "config.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({
		roles: { worker: { tools: ["read"] } },
		workflow: {
			maxReviewRounds: "legacy value",
			allowParallelWorkers: false,
			parallelWorkersRequireWorktrees: true,
			runTestsOnlyAfterReviewLoop: true,
		},
		children: { roleTimeoutMs: "legacy value" },
		references: { maxFileBytes: 1, allowOutsideCwd: true, allowBinary: true },
		artifacts: { allowOutsideCwd: false },
	}), "utf8");

	const config = loadConfig(cwd);

	assert.equal("workflow" in config, false);
	assert.equal("roleTimeoutMs" in config.children, false);
	assert.equal(config.references.maxFileBytes, 1);
	assert.equal(config.references.allowOutsideCwd, true);
	assert.equal(config.references.allowBinary, true);
	assert.equal("allowOutsideCwd" in config.artifacts, false);
	assert.equal("tools" in config.roles.worker, false);
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
