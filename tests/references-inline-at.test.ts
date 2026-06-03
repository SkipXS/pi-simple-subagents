import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, type Config } from "../extensions/pi-simple-subagents/config.ts";
import { readReference } from "../extensions/pi-simple-subagents/references.ts";

function tempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-reference-test-"));
}

function cloneConfig(): Config {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
}

test("inline scoped npm package tokens are treated as literal text when no file exists", () => {
	const cwd = tempProject();
	const input = "Install @scope/package before running this task";

	const result = readReference(cwd, input, "task", cloneConfig());

	assert.equal(result.text, input);
	assert.equal(result.source, "inline task");
	assert.deepEqual(result.warnings, []);
});

test("non-leading inline at-sign references still read existing files", () => {
	const cwd = tempProject();
	const referencePath = path.join(cwd, "notes.md");
	fs.writeFileSync(referencePath, "referenced body", "utf8");

	const result = readReference(cwd, `Please use @notes.md for context`, "task", cloneConfig());

	assert.equal(result.source, fs.realpathSync.native(referencePath));
	assert.match(result.text, /^referenced body\n\nAdditional user instruction:\nPlease use\s+for context$/);
	assert.deepEqual(result.warnings, []);
});

test("leading at-sign references still report missing files", () => {
	const cwd = tempProject();

	assert.throws(() => readReference(cwd, "@scope/package", "task", cloneConfig()), /task reference not found: scope\/package/);
});

test("multiple inline at-sign references are rejected clearly", () => {
	const cwd = tempProject();
	fs.writeFileSync(path.join(cwd, "one.md"), "one", "utf8");
	fs.writeFileSync(path.join(cwd, "two.md"), "two", "utf8");

	assert.throws(() => readReference(cwd, "@one.md @two.md", "task", cloneConfig()), /exactly one inline @ reference/);
	assert.throws(() => readReference(cwd, "Use @one.md and @two.md", "task", cloneConfig()), /additional existing reference token: @two\.md/);
});
