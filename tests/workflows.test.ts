import test from "node:test";
import assert from "node:assert/strict";
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
