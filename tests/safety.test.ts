import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeArtifact } from "../extensions/pi-simple-subagents/artifacts.ts";
import { createProjectWriteFence, restoreProjectSnapshotArchive, writeProjectSnapshotArchive } from "../extensions/pi-simple-subagents/snapshots.ts";
import { readOrchestrationState } from "../extensions/pi-simple-subagents/state.ts";

function tempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-test-"));
}

test("read-only write fence includes and restores protected project config under .pi", () => {
	const cwd = tempProject();
	const configPath = path.join(cwd, ".pi", "pi-simple-subagents", "config.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(path.join(cwd, "tracked.txt"), "source", "utf8");
	fs.writeFileSync(configPath, "{\"workflow\":{}}", "utf8");

	const fence = createProjectWriteFence(cwd);
	fs.writeFileSync(configPath, "{\"workflow\":{\"maxReviewRounds\":1}}", "utf8");
	const result = fence.restoreIfChanged();

	assert.equal(result.changed, true);
	assert.equal(result.restored, true);
	assert.equal(fs.readFileSync(configPath, "utf8"), "{\"workflow\":{}}");
});

test("authorized snapshot archive restores unauthorized source mutations", () => {
	const cwd = tempProject();
	const runDir = path.join(cwd, ".pi", "agent-runs", "run");
	fs.mkdirSync(runDir, { recursive: true });
	const sourcePath = path.join(cwd, "source.txt");
	fs.writeFileSync(sourcePath, "authorized", "utf8");
	const archiveDir = path.join(runDir, "source-snapshot-authorized.archive");

	const before = writeProjectSnapshotArchive(cwd, archiveDir, [runDir]);
	fs.writeFileSync(sourcePath, "unauthorized", "utf8");
	fs.writeFileSync(path.join(cwd, "extra.txt"), "extra", "utf8");
	const result = restoreProjectSnapshotArchive(cwd, archiveDir, [runDir]);

	assert.equal(result.before.hash, before.hash);
	assert.equal(result.changed, true);
	assert.equal(result.restored, true);
	assert.equal(fs.readFileSync(sourcePath, "utf8"), "authorized");
	assert.equal(fs.existsSync(path.join(cwd, "extra.txt")), false);
});

test("corrupt orchestration state is quarantined and ignored", () => {
	const runDir = tempProject();
	writeArtifact(runDir, "orchestration-state.json", "{not json");

	const state = readOrchestrationState(runDir);
	const quarantined = fs.readdirSync(runDir).filter((name) => name.startsWith("orchestration-state.invalid-"));

	assert.equal(state, undefined);
	assert.equal(quarantined.length, 1);
});
