import test from "node:test";
import assert from "node:assert/strict";
import { createSubagentProgress } from "../extensions/pi-simple-subagents/progress.ts";

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
