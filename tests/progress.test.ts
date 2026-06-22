import test from "node:test";
import assert from "node:assert/strict";
import { createSubagentProgress, formatSubagentProgress } from "../extensions/pi-simple-subagents/progress.ts";
import type { ToolProgressOnUpdate } from "../extensions/pi-simple-subagents/progress.ts";

interface FakeTimer {
	callback: () => void;
	delayMs: number;
	active: boolean;
}

function createFakeScheduler() {
	let currentTime = 0;
	const timers: FakeTimer[] = [];
	return {
		now: () => currentTime,
		advance: (ms: number) => { currentTime += ms; },
		setTimeout(callback: () => void, delayMs: number) {
			const timer = { callback, delayMs, active: true };
			timers.push(timer);
			return timer;
		},
		clearTimeout(timer: unknown) {
			(timer as FakeTimer).active = false;
		},
		fireActiveTimers() {
			for (const timer of [...timers]) {
				if (!timer.active) continue;
				timer.active = false;
				timer.callback();
			}
		},
		activeTimerCount: () => timers.filter((timer) => timer.active).length,
		activeDelays: () => timers.filter((timer) => timer.active).map((timer) => timer.delayMs),
	};
}

test("formatSubagentProgress renders variant-1 tree rows and legacy current fallback", () => {
	const rendered = formatSubagentProgress({
		current: "worker: ↑1 - running",
		statuses: [
			{ key: "a", text: "worker: ↑1 - running", description: "first duplicate" },
			{ key: "b", text: "worker: ↑1 - running", description: "second duplicate" },
			{ key: "scout", text: "scout: ↑10 - claude - finished", description: "research" },
		],
	});

	assert.equal(rendered, [
		"Subagents: ⠋ working",
		"• worker │ first duplicate ",
		"         ├─ usage │ ↑1",
		"         └─ now   │ running",
		"· worker │ second duplicate",
		"         ├─ usage │ ↑1",
		"         └─ now   │ running",
		"✓ scout  │ research        ",
		"         ├─ usage │ ↑10",
		"         ├─ model │ claude",
		"         └─ state │ finished",
	].join("\n"));
	assert.doesNotMatch(rendered, /usage pending|model pending/);
	assert.doesNotMatch(rendered, /^.*worker.*│ running$/m, "action must not render on the main row");
});

test("subagent progress uses currentKey to disambiguate duplicate active status text", () => {
	const updates: Array<Parameters<NonNullable<ToolProgressOnUpdate>>[0]> = [];
	const progress = createSubagentProgress({
		throttleMs: 0,
		onToolUpdate: (update) => updates.push(update),
	});

	progress.status({ key: "worker-1", text: "worker: ↑1 - running", description: "first duplicate" });
	progress.status({ key: "worker-2", text: "worker: ↑1 - running", description: "second duplicate" });

	assert.deepEqual(updates.at(-1)?.details.subagentProgress, {
		statuses: [
			{ key: "worker-1", text: "worker: ↑1 - running", description: "first duplicate" },
			{ key: "worker-2", text: "worker: ↑1 - running", description: "second duplicate" },
		],
		current: "worker: ↑1 - running",
		currentKey: "worker-2",
	});
	assert.equal(updates.at(-1)?.content[0]?.text, [
		"Subagents: ⠋ working",
		"· worker │ first duplicate ",
		"         ├─ usage │ ↑1",
		"         └─ now   │ running",
		"• worker │ second duplicate",
		"         ├─ usage │ ↑1",
		"         └─ now   │ running",
	].join("\n"));
});

test("subagent progress refreshes active marker for interleaved identical keyed statuses", () => {
	const updates: Array<Parameters<NonNullable<ToolProgressOnUpdate>>[0]> = [];
	const progress = createSubagentProgress({
		throttleMs: 0,
		onToolUpdate: (update) => updates.push(update),
	});

	const text = "worker: ↑1 - running";
	progress.status({ key: "worker-a", text, description: "duplicate work" });
	progress.status({ key: "worker-b", text, description: "duplicate work" });
	progress.status({ key: "worker-a", text, description: "duplicate work" });

	assert.equal(updates.length, 3);
	assert.deepEqual(updates.at(-1)?.details.subagentProgress, {
		statuses: [
			{ key: "worker-a", text, description: "duplicate work" },
			{ key: "worker-b", text, description: "duplicate work" },
		],
		current: text,
		currentKey: "worker-a",
	});
	assert.equal(updates.at(-1)?.content[0]?.text, [
		"Subagents: ⠋ working",
		"• worker │ duplicate work",
		"         ├─ usage │ ↑1",
		"         └─ now   │ running",
		"· worker │ duplicate work",
		"         ├─ usage │ ↑1",
		"         └─ now   │ running",
	].join("\n"));

	progress.status({ key: "worker-a", text, description: "duplicate work" });
	assert.equal(updates.length, 3, "unchanged active key does not republish identical rendering");
});

test("subagent progress keeps latest active duplicate when a different duplicate finishes", () => {
	const updates: Array<Parameters<NonNullable<ToolProgressOnUpdate>>[0]> = [];
	const progress = createSubagentProgress({
		throttleMs: 0,
		onToolUpdate: (update) => updates.push(update),
	});

	const running = "worker: ↑1 - running";
	progress.status({ key: "a", text: running, description: "first duplicate" });
	progress.status({ key: "c", text: running, description: "middle duplicate" });
	progress.status({ key: "b", text: running, description: "latest duplicate" });

	progress.status({ key: "a", text: "worker: ↑1 - finished", description: "first duplicate" });

	assert.equal(updates.at(-1)?.details.subagentProgress.currentKey, "b");
	assert.equal(updates.at(-1)?.content[0]?.text, [
		"Subagents: ⠋ working",
		"✓ worker │ first duplicate ",
		"         ├─ usage │ ↑1",
		"         └─ state │ finished",
		"· worker │ middle duplicate",
		"         ├─ usage │ ↑1",
		"         └─ now   │ running",
		"• worker │ latest duplicate",
		"         ├─ usage │ ↑1",
		"         └─ now   │ running",
	].join("\n"));

	progress.status({ key: "c", text: "worker: ↑1 - finished", description: "middle duplicate" });
	progress.status({ key: "b", text: "worker: ↑1 - finished", description: "latest duplicate" });

	assert.equal(updates.at(-1)?.content[0]?.text, [
		"Subagents: ✓ done",
		"✓ worker │ first duplicate ",
		"         ├─ usage │ ↑1",
		"         └─ state │ finished",
		"✓ worker │ middle duplicate",
		"         ├─ usage │ ↑1",
		"         └─ state │ finished",
		"✓ worker │ latest duplicate",
		"         ├─ usage │ ↑1",
		"         └─ state │ finished",
	].join("\n"));
});

test("subagent progress publishes variant-1 rows and structured snapshots to tool updates and widgets", () => {
	const updates: Array<Parameters<NonNullable<ToolProgressOnUpdate>>[0]> = [];
	const widgets: string[][] = [];
	const progress = createSubagentProgress({
		throttleMs: 0,
		onToolUpdate: (update) => updates.push(update),
		setWidget: (content) => { if (content) widgets.push(content); },
	});

	progress.status({ key: "worker", text: "⠋ worker: ↑1.2k ↓3 - gpt-5 (thinking high) - running", description: "implementation" });
	const running = [
		"Subagents: ⠋ working",
		"• worker │ implementation",
		"         ├─ usage │ ↑1.2k ↓3",
		"         ├─ model │ gpt-5 (thinking high)",
		"         └─ now   │ running",
	].join("\n");
	assert.equal(updates.at(-1)?.content[0]?.text, running);
	assert.deepEqual(updates.at(-1)?.details.subagentProgress, {
		statuses: [{
			key: "worker",
			text: "⠋ worker: ↑1.2k ↓3 - gpt-5 (thinking high) - running",
			description: "implementation",
		}],
		current: "⠋ worker: ↑1.2k ↓3 - gpt-5 (thinking high) - running",
		currentKey: "worker",
	});
	assert.deepEqual(widgets.at(-1), running.split("\n"));

	progress.status({ key: "worker", text: "worker: ↑1.2k ↓3 - gpt-5 (thinking high) - finished", description: "implementation" });
	const finished = [
		"Subagents: ✓ done",
		"✓ worker │ implementation",
		"         ├─ usage │ ↑1.2k ↓3",
		"         ├─ model │ gpt-5 (thinking high)",
		"         └─ state │ finished",
	].join("\n");
	assert.equal(updates.at(-1)?.content[0]?.text, finished);
	assert.deepEqual(updates.at(-1)?.details.subagentProgress, {
		statuses: [{
			key: "worker",
			text: "worker: ↑1.2k ↓3 - gpt-5 (thinking high) - finished",
			description: "implementation",
		}],
		current: "worker: ↑1.2k ↓3 - gpt-5 (thinking high) - finished",
		currentKey: "worker",
	});
	assert.deepEqual(widgets.at(-1), finished.split("\n"));
});

test("formatSubagentProgress renders the agreed variant-1 sample", () => {
	assert.equal(formatSubagentProgress({
		currentKey: "worker",
		statuses: [{ key: "worker", text: "⠋ worker: ↑1.2k ↓3 - gpt-5 • medium - running", description: "implementation" }],
	}), [
		"Subagents: ⠋ working",
		"• worker │ implementation",
		"         ├─ usage │ ↑1.2k ↓3",
		"         ├─ model │ gpt-5 • medium",
		"         └─ now   │ running",
	].join("\n"));
});

test("formatSubagentProgress preserves literal separators inside model details", () => {
	assert.equal(formatSubagentProgress({
		currentKey: "worker",
		statuses: [{ key: "worker", text: "worker: ↑1 - gpt-5 - azure - running", description: "implementation" }],
	}), [
		"Subagents: ⠋ working",
		"• worker │ implementation",
		"         ├─ usage │ ↑1",
		"         ├─ model │ gpt-5 - azure",
		"         └─ now   │ running",
	].join("\n"));
});

test("formatSubagentProgress treats leading dash details as model-only", () => {
	const rendered = formatSubagentProgress({
		currentKey: "worker",
		statuses: [{ key: "worker", text: "worker: - gpt-5 - azure - running", description: "implementation" }],
	});

	assert.equal(rendered, [
		"Subagents: ⠋ working",
		"• worker │ implementation",
		"         ├─ model │ gpt-5 - azure",
		"         └─ now   │ running",
	].join("\n"));
	assert.doesNotMatch(rendered, /usage │/);
});

test("formatSubagentProgress hides empty leading dash model placeholders", () => {
	const rendered = formatSubagentProgress({
		currentKey: "worker",
		statuses: [{ key: "worker", text: "worker: - - running" }],
	});

	assert.equal(rendered, [
		"Subagents: ⠋ working",
		"• worker │ —",
		"         └─ now   │ running",
	].join("\n"));
	assert.doesNotMatch(rendered, /usage │|model │/);
});

test("subagent progress default throttle coalesces duplicate updates with latest active key", () => {
	const scheduler = createFakeScheduler();
	const updates: Array<Parameters<NonNullable<ToolProgressOnUpdate>>[0]> = [];
	const progress = createSubagentProgress({
		now: scheduler.now,
		setTimeout: scheduler.setTimeout,
		clearTimeout: scheduler.clearTimeout,
		onToolUpdate: (update) => updates.push(update),
	});

	const text = "worker: ↑1 - running";
	progress.status({ key: "a", text, description: "A" });
	assert.equal(updates.length, 1);

	progress.status({ key: "c", text, description: "C" });
	progress.status({ key: "b", text, description: "B" });

	assert.equal(updates.length, 1, "duplicate updates inside the default throttle window are coalesced");
	assert.equal(scheduler.activeTimerCount(), 1);
	assert.deepEqual(scheduler.activeDelays(), [300]);

	scheduler.fireActiveTimers();

	assert.equal(updates.length, 2);
	assert.equal(updates.at(-1)?.details.subagentProgress.currentKey, "b");
	assert.equal(updates.at(-1)?.content[0]?.text, [
		"Subagents: ⠋ working",
		"· worker │ A",
		"         ├─ usage │ ↑1",
		"         └─ now   │ running",
		"· worker │ C",
		"         ├─ usage │ ↑1",
		"         └─ now   │ running",
		"• worker │ B",
		"         ├─ usage │ ↑1",
		"         └─ now   │ running",
	].join("\n"));
});

test("subagent progress preserves nested active key when enclosing status coalesces before default timer", () => {
	const scheduler = createFakeScheduler();
	const updates: Array<Parameters<NonNullable<ToolProgressOnUpdate>>[0]> = [];
	const progress = createSubagentProgress({
		now: scheduler.now,
		setTimeout: scheduler.setTimeout,
		clearTimeout: scheduler.clearTimeout,
		onToolUpdate: (update) => updates.push(update),
	});

	progress.status({ key: "subagent:orchestrator", text: "orchestrator: starting" });
	assert.equal(updates.length, 1);

	progress.status({ key: "subagent:worker-a", text: "worker: ↑1 - running", description: "first duplicate", active: true });
	progress.status({ key: "subagent:worker-b", text: "worker: ↑1 - running", description: "second duplicate", active: false });
	progress.status({ key: "subagent:orchestrator", text: "orchestrator: run_role_agent worker/implementation", active: false });

	assert.equal(updates.length, 1, "nested and enclosing statuses are coalesced during the default throttle window");
	assert.equal(scheduler.activeTimerCount(), 1);

	scheduler.fireActiveTimers();

	assert.equal(updates.length, 2);
	assert.equal(updates.at(-1)?.details.subagentProgress.currentKey, "subagent:worker-a");
	assert.match(updates.at(-1)?.content[0]?.text ?? "", /• worker\s+│ first duplicate\s+\n\s+├─ usage │ ↑1\n\s+└─ now\s+│ running/);
	assert.match(updates.at(-1)?.content[0]?.text ?? "", /· worker\s+│ second duplicate\s*\n\s+├─ usage │ ↑1\n\s+└─ now\s+│ running/);
	assert.match(updates.at(-1)?.content[0]?.text ?? "", /· orchestrator\s+│ —\s+\n\s+└─ now\s+│ run_role_agent worker\/implementation/);
});

test("subagent progress coalesces high-frequency non-terminal updates and publishes terminal status immediately", () => {
	const scheduler = createFakeScheduler();
	const updates: string[] = [];
	const widgets: string[][] = [];
	const progress = createSubagentProgress({
		throttleMs: 300,
		now: scheduler.now,
		setTimeout: scheduler.setTimeout,
		clearTimeout: scheduler.clearTimeout,
		onToolUpdate: (update) => updates.push(update.content[0]?.text ?? ""),
		setWidget: (content) => { if (content) widgets.push(content); },
	});

	progress.status({ key: "worker", text: "⠋ worker: 1 tokens - running", description: "fast task" });
	assert.equal(updates.length, 1);
	assert.equal(widgets.length, 1);

	for (let index = 2; index <= 12; index += 1) {
		scheduler.advance(10);
		progress.status({ key: "worker", text: `⠋ worker: ${index} tokens - running`, description: "fast task" });
	}

	assert.equal(updates.length, 1, "non-terminal ticks inside the throttle window are coalesced");
	assert.equal(widgets.length, 1, "widget updates are coalesced with tool updates");
	assert.equal(scheduler.activeTimerCount(), 1);
	assert.deepEqual(scheduler.activeDelays(), [290]);

	progress.status({ key: "worker", text: "worker: 12 tokens - failed", description: "fast task" });
	assert.equal(updates.length, 2, "terminal state publishes immediately without waiting for the throttle timer");
	assert.match(updates.at(-1) ?? "", /failed/);
	assert.equal(scheduler.activeTimerCount(), 0, "terminal publish cancels the pending coalesced update");

	scheduler.fireActiveTimers();
	assert.equal(updates.length, 2, "canceled coalesced timer does not publish after terminal state");
});

test("clearing subagent progress cancels pending coalesced updates and clears the widget", () => {
	const scheduler = createFakeScheduler();
	const updates: string[] = [];
	const widgetUpdates: Array<string[] | undefined> = [];
	const progress = createSubagentProgress({
		throttleMs: 300,
		now: scheduler.now,
		setTimeout: scheduler.setTimeout,
		clearTimeout: scheduler.clearTimeout,
		onToolUpdate: (update) => updates.push(update.content[0]?.text ?? ""),
		setWidget: (content) => widgetUpdates.push(content),
	});

	progress.status({ key: "worker", text: "⠋ worker: 1 tokens - running" });
	scheduler.advance(25);
	progress.status({ key: "worker", text: "⠙ worker: 2 tokens - running" });
	assert.equal(scheduler.activeTimerCount(), 1);

	progress.clear();
	assert.equal(scheduler.activeTimerCount(), 0);
	assert.equal(widgetUpdates.at(-1), undefined);

	scheduler.fireActiveTimers();
	assert.equal(updates.length, 1, "pending coalesced update was canceled by clear()");
});
