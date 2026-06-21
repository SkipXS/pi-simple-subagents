import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderOrchestratorResult, renderRoleAgentResult, renderWorkerResult } from "../extensions/pi-simple-subagents/rendering.ts";
import { renderExpandedToolCallTree } from "../extensions/pi-simple-subagents/tool-tree.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-tool-tree-test-"));
}

function writeJsonl(file: string, events: unknown[]): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n"), "utf8");
	return file;
}

function renderText(rendered: { render(width: number): string[] }): string {
	return rendered.render(240).map((line) => line.trimEnd()).join("\n");
}

test("worker expanded renderer includes tool tree while collapsed renderer omits it", () => {
	const dir = tempDir();
	const transcript = writeJsonl(path.join(dir, "worker.jsonl"), [
		{ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } },
		{ type: "tool_execution_end", toolName: "read", result: { ok: true } },
	]);
	const result = {
		content: [{ type: "text", text: "FULL CHILD OUTPUT" }],
		details: {
			runDir: dir,
			taskSource: "inline",
			purpose: "implementation",
			result: { exitCode: 0, transcriptPath: transcript },
			subagentProgress: { statuses: [{ key: "subagent:worker", text: "✓ worker: done", description: "implementation: ok" }] },
		},
	};

	const expanded = renderText(renderWorkerResult(result, { expanded: true }, theme));
	assert.match(expanded, /Tool calls:\n- read \{"path":"README\.md"\}/);
	assert.ok(expanded.indexOf("Transcript:") < expanded.indexOf("Subagents:"));
	assert.ok(expanded.indexOf("Subagents:") < expanded.indexOf("Tool calls:"));
	assert.ok(expanded.indexOf("Tool calls:") < expanded.indexOf("FULL CHILD OUTPUT"));

	const collapsed = renderText(renderWorkerResult(result, {}, theme));
	assert.doesNotMatch(collapsed, /Tool calls:/);
	assert.doesNotMatch(collapsed, /- read/);
	assert.doesNotMatch(collapsed, /FULL CHILD OUTPUT/);
});

test("orchestrator expanded renderer nests child transcript calls under run_role_agent", () => {
	const dir = tempDir();
	const childTranscript = writeJsonl(path.join(dir, "child.jsonl"), [
		{ type: "tool_execution_start", toolName: "write_run_artifact", args: { path: "worker.md" } },
		{ type: "tool_execution_end", toolName: "write_run_artifact", result: { path: "worker.md" } },
	]);
	const orchestratorTranscript = writeJsonl(path.join(dir, "orchestrator.jsonl"), [
		{ type: "tool_execution_start", toolName: "read", args: { path: "plan.md" } },
		{ type: "tool_execution_end", toolName: "read", result: { ok: true } },
		{ type: "tool_execution_start", toolName: "run_role_agent", args: { role: "worker", task: "implement" } },
		{ type: "tool_execution_end", toolName: "run_role_agent", result: { exitCode: 0, transcriptPath: childTranscript } },
	]);

	const rendered = renderText(renderOrchestratorResult({
		content: [{ type: "text", text: "FULL ORCHESTRATOR OUTPUT" }],
		details: { runDir: dir, planSource: "inline", result: { exitCode: 0, transcriptPath: orchestratorTranscript } },
	}, { expanded: true }, theme));

	assert.match(rendered, /Tool calls:\n- read \{"path":"plan\.md"\}\n- run_role_agent \{"role":"worker","task":"implement"\}\n  └─ write_run_artifact \{"path":"worker\.md"\}/);
	assert.ok(rendered.indexOf("Transcript:") < rendered.indexOf("Tool calls:"));
	assert.ok(rendered.indexOf("Tool calls:") < rendered.indexOf("FULL ORCHESTRATOR OUTPUT"));
});

test("nested run_worker transcript expansion uses known subagent result shape", () => {
	const dir = tempDir();
	const workerTranscript = writeJsonl(path.join(dir, "worker-child.jsonl"), [
		{ type: "tool_execution_start", toolName: "write_run_artifact", args: { path: "worker-package.md" } },
		{ type: "tool_execution_end", toolName: "write_run_artifact", result: { path: "worker-package.md" } },
	]);
	const parentTranscript = writeJsonl(path.join(dir, "parent-run-worker.jsonl"), [
		{ type: "tool_execution_start", toolName: "run_worker", args: { workerId: "worker-3" } },
		{ type: "tool_execution_end", toolName: "run_worker", result: { result: { exitCode: 0, transcriptPath: workerTranscript } } },
	]);

	const rendered = renderExpandedToolCallTree({ runDir: dir, result: { transcriptPath: parentTranscript } }).join("\n");
	assert.match(rendered, /- run_worker \{"workerId":"worker-3"\}\n  └─ write_run_artifact \{"path":"worker-package\.md"\}/);
});

test("nested run_reviewers expands multiple transcript paths and skips duplicates", () => {
	const dir = tempDir();
	const scoutTranscript = writeJsonl(path.join(dir, "review-scout.jsonl"), [
		{ type: "tool_execution_start", toolName: "read", args: { path: "scout.md" } },
		{ type: "tool_execution_end", toolName: "read", result: { ok: true } },
	]);
	const reviewTranscript = writeJsonl(path.join(dir, "review-shared.jsonl"), [
		{ type: "tool_execution_start", toolName: "write_run_artifact", args: { path: "shared-review.md" } },
		{ type: "tool_execution_end", toolName: "write_run_artifact", result: { path: "shared-review.md" } },
	]);
	const parentTranscript = writeJsonl(path.join(dir, "parent-run-reviewers.jsonl"), [
		{ type: "tool_execution_start", toolName: "run_reviewers", args: { round: 1 } },
		{
			type: "tool_execution_end",
			toolName: "run_reviewers",
			result: {
				scout: { transcriptPath: scoutTranscript },
				reviews: [{ transcriptPath: reviewTranscript }, { transcriptPath: reviewTranscript }],
			},
		},
	]);

	const rendered = renderExpandedToolCallTree({ runDir: dir, result: { transcriptPath: parentTranscript } }).join("\n");
	assert.match(rendered, /- run_reviewers \{"round":1\}\n  ├─ read \{"path":"scout\.md"\}\n  └─ write_run_artifact \{"path":"shared-review\.md"\}/);
	assert.equal((rendered.match(/shared-review\.md/g) ?? []).length, 1);
});

test("missing and malformed transcripts do not crash expanded rendering", () => {
	const dir = tempDir();
	const missing = path.join(dir, "missing.jsonl");
	const missingRendered = renderText(renderWorkerResult({
		content: [{ type: "text", text: "content survives" }],
		details: { runDir: dir, result: { exitCode: 0, transcriptPath: missing } },
	}, { expanded: true }, theme));
	assert.match(missingRendered, /Tool calls:/);
	assert.match(missingRendered, /tool tree: unavailable/);
	assert.match(missingRendered, /content survives/);

	const malformed = path.join(dir, "malformed.jsonl");
	fs.writeFileSync(malformed, "not json\n" + JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }) + "\n", "utf8");
	const malformedRendered = renderText(renderWorkerResult({
		content: [{ type: "text", text: "content survives" }],
		details: { runDir: dir, result: { exitCode: 0, transcriptPath: malformed } },
	}, { expanded: true }, theme));
	assert.match(malformedRendered, /- bash \{"command":"npm test"\}/);
	assert.match(malformedRendered, /tool tree: 1 malformed line skipped/);
});

test("tool tree keeps overlapping tool executions as siblings by toolCallId", () => {
	const dir = tempDir();
	const transcript = writeJsonl(path.join(dir, "overlap.jsonl"), [
		{ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.md" } },
		{ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "npm test" } },
		{ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { ok: true } },
		{ type: "tool_execution_end", toolCallId: "b", toolName: "bash", result: { ok: true } },
	]);

	const rendered = renderExpandedToolCallTree({ result: { transcriptPath: transcript } }).join("\n");
	assert.match(rendered, /- read \{"path":"a\.md"\}\n- bash \{"command":"npm test"\}/);
	assert.doesNotMatch(rendered, /  └─ bash/);
});

test("tool tree matches overlapping id-less same-name ends in FIFO order", () => {
	const dir = tempDir();
	const firstChild = writeJsonl(path.join(dir, "first-child.jsonl"), [
		{ type: "tool_execution_start", toolName: "write_run_artifact", args: { path: "first.md" } },
		{ type: "tool_execution_end", toolName: "write_run_artifact", result: { path: "first.md" } },
	]);
	const secondChild = writeJsonl(path.join(dir, "second-child.jsonl"), [
		{ type: "tool_execution_start", toolName: "write_run_artifact", args: { path: "second.md" } },
		{ type: "tool_execution_end", toolName: "write_run_artifact", result: { path: "second.md" } },
	]);
	const transcript = writeJsonl(path.join(dir, "same-name-overlap.jsonl"), [
		{ type: "tool_execution_start", toolName: "run_role_agent", args: { role: "first" } },
		{ type: "tool_execution_start", toolName: "run_role_agent", args: { role: "second" } },
		{ type: "tool_execution_end", toolName: "run_role_agent", result: { transcriptPath: firstChild } },
		{ type: "tool_execution_end", toolName: "run_role_agent", result: { transcriptPath: secondChild } },
	]);

	const rendered = renderExpandedToolCallTree({ runDir: dir, result: { transcriptPath: transcript } }).join("\n");
	assert.match(rendered, /- run_role_agent \{"role":"first"\}\n  └─ write_run_artifact \{"path":"first\.md"\}/);
	assert.match(rendered, /- run_role_agent \{"role":"second"\}\n  └─ write_run_artifact \{"path":"second\.md"\}/);
	assert.doesNotMatch(rendered, /\{"role":"first"\}\n  └─ write_run_artifact \{"path":"second\.md"\}/);
	assert.doesNotMatch(rendered, /\{"role":"second"\}\n  └─ write_run_artifact \{"path":"first\.md"\}/);
});

test("tool tree ignores ambiguous id-less same-name updates", () => {
	const dir = tempDir();
	const firstChild = writeJsonl(path.join(dir, "first-update-child.jsonl"), [
		{ type: "tool_execution_start", toolName: "write_run_artifact", args: { path: "first-after-update.md" } },
		{ type: "tool_execution_end", toolName: "write_run_artifact", result: { path: "first-after-update.md" } },
	]);
	const secondChild = writeJsonl(path.join(dir, "second-update-child.jsonl"), [
		{ type: "tool_execution_start", toolName: "write_run_artifact", args: { path: "second-after-update.md" } },
		{ type: "tool_execution_end", toolName: "write_run_artifact", result: { path: "second-after-update.md" } },
	]);
	const ambiguousChild = writeJsonl(path.join(dir, "ambiguous-update-child.jsonl"), [
		{ type: "tool_execution_start", toolName: "write_run_artifact", args: { path: "ambiguous-update.md" } },
		{ type: "tool_execution_end", toolName: "write_run_artifact", result: { path: "ambiguous-update.md" } },
	]);
	const transcript = writeJsonl(path.join(dir, "ambiguous-update.jsonl"), [
		{ type: "tool_execution_start", toolName: "run_role_agent" },
		{ type: "tool_execution_start", toolName: "run_role_agent" },
		{ type: "tool_execution_update", toolName: "run_role_agent", args: { role: "wrong-update" }, partialResult: { transcriptPath: ambiguousChild } },
		{ type: "tool_execution_end", toolName: "run_role_agent", args: { role: "first-end" }, result: { transcriptPath: firstChild } },
		{ type: "tool_execution_end", toolName: "run_role_agent", args: { role: "second-end" }, result: { transcriptPath: secondChild } },
	]);

	const rendered = renderExpandedToolCallTree({ runDir: dir, result: { transcriptPath: transcript } }).join("\n");
	assert.match(rendered, /- run_role_agent \{"role":"first-end"\}\n  └─ write_run_artifact \{"path":"first-after-update\.md"\}/);
	assert.match(rendered, /- run_role_agent \{"role":"second-end"\}\n  └─ write_run_artifact \{"path":"second-after-update\.md"\}/);
	assert.doesNotMatch(rendered, /wrong-update/);
	assert.doesNotMatch(rendered, /ambiguous-update\.md/);
});

test("tool tree rendering only marks truncated when node cap omits nodes", () => {
	const dir = tempDir();
	const transcript = writeJsonl(path.join(dir, "many-tools.jsonl"), [
		{ type: "tool_execution_start", toolName: "read", args: { path: "one.md" } },
		{ type: "tool_execution_end", toolName: "read", result: { ok: true } },
		{ type: "tool_execution_start", toolName: "bash", args: { command: "two" } },
		{ type: "tool_execution_end", toolName: "bash", result: { ok: true } },
		{ type: "tool_execution_start", toolName: "write", args: { path: "three.md" } },
		{ type: "tool_execution_end", toolName: "write", result: { ok: true } },
	]);

	const exact = renderExpandedToolCallTree({ result: { transcriptPath: transcript } }, { maxNodes: 3 }).join("\n");
	assert.match(exact, /- read \{"path":"one\.md"\}/);
	assert.match(exact, /- bash \{"command":"two"\}/);
	assert.match(exact, /- write \{"path":"three\.md"\}/);
	assert.doesNotMatch(exact, /… tool call tree truncated/);

	const rendered = renderExpandedToolCallTree({ result: { transcriptPath: transcript } }, { maxNodes: 2 }).join("\n");
	assert.match(rendered, /- read \{"path":"one\.md"\}/);
	assert.match(rendered, /- bash \{"command":"two"\}/);
	assert.doesNotMatch(rendered, /three\.md/);
	assert.match(rendered, /… tool call tree truncated/);
});

test("tool tree rejects transcript paths outside runDir without throwing", () => {
	const dir = tempDir();
	const outsideDir = tempDir();
	const outsideTranscript = writeJsonl(path.join(outsideDir, "outside.jsonl"), [
		{ type: "tool_execution_start", toolName: "outside_secret_tool", args: { token: "do-not-leak" } },
		{ type: "tool_execution_end", toolName: "outside_secret_tool", result: { ok: true } },
	]);

	assert.doesNotThrow(() => renderExpandedToolCallTree({ runDir: dir, result: { transcriptPath: outsideTranscript } }));
	const topLevelRendered = renderExpandedToolCallTree({ runDir: dir, result: { transcriptPath: outsideTranscript } }).join("\n");
	assert.doesNotMatch(topLevelRendered, /outside_secret_tool/);
	assert.doesNotMatch(topLevelRendered, /do-not-leak/);
	assert.match(topLevelRendered, /tool tree: transcript outside run dir/);

	const parentTranscript = writeJsonl(path.join(dir, "parent.jsonl"), [
		{ type: "tool_execution_start", toolName: "run_role_agent", args: { role: "worker" } },
		{ type: "tool_execution_end", toolName: "run_role_agent", result: { transcriptPath: outsideTranscript } },
	]);
	const nestedRendered = renderExpandedToolCallTree({ runDir: dir, result: { transcriptPath: parentTranscript } }).join("\n");
	assert.match(nestedRendered, /- run_role_agent \{"role":"worker"\}/);
	assert.doesNotMatch(nestedRendered, /outside_secret_tool/);
	assert.doesNotMatch(nestedRendered, /do-not-leak/);
	assert.match(nestedRendered, /tool tree: transcript outside run dir/);
});

test("role-agent expanded renderer rejects transcript paths outside trusted runDir", () => {
	const dir = tempDir();
	const outsideDir = tempDir();
	const outsideTranscript = writeJsonl(path.join(outsideDir, "outside-role-agent.jsonl"), [
		{ type: "tool_execution_start", toolName: "outside_fake_tool", args: { token: "outside-secret" } },
		{ type: "tool_execution_end", toolName: "outside_fake_tool", result: { ok: true } },
	]);

	const rendered = renderText(renderRoleAgentResult({
		content: [{ type: "text", text: "role agent output" }],
		details: { runDir: dir, exitCode: 0, transcriptPath: outsideTranscript, purpose: "implementation" },
	}, { expanded: true }, theme));

	assert.doesNotMatch(rendered, /outside_fake_tool/);
	assert.doesNotMatch(rendered, /outside-secret/);
	assert.match(rendered, /tool tree: transcript outside run dir/);
});

test("tool tree rejects in-run symlink escape transcript paths without throwing", () => {
	const dir = tempDir();
	const outsideDir = tempDir();
	const outsideTranscript = writeJsonl(path.join(outsideDir, "outside-via-link.jsonl"), [
		{ type: "tool_execution_start", toolName: "outside_symlink_tool", args: { token: "symlink-secret" } },
		{ type: "tool_execution_end", toolName: "outside_symlink_tool", result: { ok: true } },
	]);
	const symlinkTranscript = path.join(dir, "linked-transcript.jsonl");
	try {
		fs.symlinkSync(outsideTranscript, symlinkTranscript, "file");
	} catch {
		return;
	}

	assert.doesNotThrow(() => renderExpandedToolCallTree({ runDir: dir, result: { transcriptPath: symlinkTranscript } }));
	const rendered = renderExpandedToolCallTree({ runDir: dir, result: { transcriptPath: symlinkTranscript } }).join("\n");
	assert.doesNotMatch(rendered, /outside_symlink_tool/);
	assert.doesNotMatch(rendered, /symlink-secret/);
	assert.match(rendered, /tool tree: transcript outside run dir/);

	const roleAgentRendered = renderText(renderRoleAgentResult({
		content: [{ type: "text", text: "role agent output" }],
		details: { runDir: dir, exitCode: 0, transcriptPath: symlinkTranscript, purpose: "implementation" },
	}, { expanded: true }, theme));
	assert.doesNotMatch(roleAgentRendered, /outside_symlink_tool/);
	assert.doesNotMatch(roleAgentRendered, /symlink-secret/);
	assert.match(roleAgentRendered, /tool tree: transcript outside run dir/);
});

test("tool tree parser caps transcript lines and marks truncated output", () => {
	const dir = tempDir();
	const transcript = writeJsonl(path.join(dir, "many-lines.jsonl"), [
		{ type: "tool_execution_start", toolName: "read", args: { path: "first.md" } },
		{ type: "tool_execution_end", toolName: "read", result: { ok: true } },
		{ type: "tool_execution_start", toolName: "bash", args: { command: "should-not-render" } },
		{ type: "tool_execution_end", toolName: "bash", result: { ok: true } },
	]);

	const rendered = renderExpandedToolCallTree({ result: { transcriptPath: transcript } }, { maxLines: 1 }).join("\n");
	assert.match(rendered, /- read \{"path":"first\.md"\}/);
	assert.doesNotMatch(rendered, /should-not-render/);
	assert.match(rendered, /… tool call tree truncated/);
});

test("nested run_role_agent transcript expansion observes depth guard", () => {
	const dir = tempDir();
	const transcripts = Array.from({ length: 5 }, (_unused, index) => path.join(dir, `chain-${index}.jsonl`));
	for (let index = 0; index < transcripts.length; index += 1) {
		const next = transcripts[index + 1];
		writeJsonl(transcripts[index]!, next ? [
			{ type: "tool_execution_start", toolName: "run_role_agent", args: { workerId: `worker-${index}` } },
			{ type: "tool_execution_end", toolName: "run_role_agent", result: { transcriptPath: next } },
		] : [
			{ type: "tool_execution_start", toolName: "write_run_artifact", args: { path: "too-deep.md" } },
			{ type: "tool_execution_end", toolName: "write_run_artifact", result: { path: "too-deep.md" } },
		]);
	}

	const lines = renderExpandedToolCallTree({ result: { transcriptPath: transcripts[0] } });
	const rendered = lines.join("\n");
	assert.match(rendered, /worker-0/);
	assert.match(rendered, /worker-1/);
	assert.match(rendered, /worker-2/);
	assert.match(rendered, /worker-3/);
	assert.doesNotMatch(rendered, /too-deep\.md/);
});
