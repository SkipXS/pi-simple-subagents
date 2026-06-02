import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../extensions/pi-simple-subagents/config.ts";
import { readReference } from "../extensions/pi-simple-subagents/references.ts";
import { validateRolePurpose } from "../extensions/pi-simple-subagents/roles.ts";
import { writeArtifact } from "../extensions/pi-simple-subagents/artifacts.ts";
import { readOrchestrationState } from "../extensions/pi-simple-subagents/state.ts";

function tempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-test-"));
}

test("default config is YOLO without boundary config knobs", () => {
	const cwd = tempProject();
	const config = loadConfig(cwd);

	assert.equal("workflow" in config, false);
	assert.equal("references" in config, false);
	assert.equal("roleTimeoutMs" in config.children, false);
	assert.equal(config.children.forwardCurrentExtension, "auto");
	assert.equal("allowOutsideCwd" in config.artifacts, false);
	for (const role of Object.values(config.roles)) assert.equal("tools" in role, false);
});

test("legacy boundary config keys are ignored", () => {
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
		references: { maxFileBytes: 1, allowOutsideCwd: false, allowBinary: false },
		artifacts: { allowOutsideCwd: false },
	}), "utf8");

	const config = loadConfig(cwd);

	assert.equal("workflow" in config, false);
	assert.equal("references" in config, false);
	assert.equal("roleTimeoutMs" in config.children, false);
	assert.equal("allowOutsideCwd" in config.artifacts, false);
	assert.equal("tools" in config.roles.worker, false);
});

test("references are not blocked by size, outside-cwd, or binary-looking content", () => {
	const cwd = tempProject();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-outside-"));
	const largePath = path.join(outside, "large.txt");
	fs.writeFileSync(largePath, "x".repeat(600 * 1024), "utf8");
	const binaryPath = path.join(outside, "binary.bin");
	fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3, 255]));
	const config = loadConfig(cwd);

	const large = readReference(cwd, `@${largePath}`, "plan", config);
	const binary = readReference(cwd, `@${binaryPath}`, "plan", config);

	assert.equal(large.source, largePath);
	assert.equal(large.text.length, 600 * 1024);
	assert.match(large.warnings.join("\n"), /large/);
	assert.equal(binary.source, binaryPath);
	assert.match(binary.warnings.join("\n"), /binary|non-text/);
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
