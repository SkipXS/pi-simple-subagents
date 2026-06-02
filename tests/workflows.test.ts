import test from "node:test";
import assert from "node:assert/strict";
import { quoteAtReferencePath, shouldForwardCurrentExtension, wasLoadedWithExtensionFlag } from "../extensions/pi-simple-subagents/child-runner.ts";
import { parseReviewTargetCommand } from "../extensions/pi-simple-subagents/workflows.ts";

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
