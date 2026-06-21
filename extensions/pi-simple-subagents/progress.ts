import type { ChildStatusUpdate } from "./child-runner.ts";

export type ToolProgressOnUpdate = ((update: { content: Array<{ type: "text"; text: string }>; details: { subagentProgress: SubagentProgressSnapshot } }) => void) | undefined;
export type WidgetSetter = (content: string[] | undefined) => void;

export interface SubagentProgressSnapshot {
	statuses: Array<{ key: string; text: string; description?: string }>;
	current?: string;
	currentKey?: string;
}

const STATUS_SPINNER_PATTERN = /^([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+(.+)$/u;

interface ParsedStatusLine {
	spinner?: string;
	label: string;
	status: string;
	action: string;
}

function parseStatusLine(text: string, fallback: string): ParsedStatusLine {
	const trimmed = text.trim();
	const spinnerMatch = STATUS_SPINNER_PATTERN.exec(trimmed);
	const spinner = spinnerMatch?.[1];
	const body = spinnerMatch?.[2] ?? trimmed;
	const separatorIndex = body.indexOf(":");
	if (separatorIndex < 0) return { spinner, label: fallback, status: "", action: body };
	const label = body.slice(0, separatorIndex).trim() || fallback;
	const rest = body.slice(separatorIndex + 1).trim();
	const actionSeparator = rest.lastIndexOf(" - ");
	if (actionSeparator < 0) return { spinner, label, status: "", action: rest };
	return {
		spinner,
		label,
		status: rest.slice(0, actionSeparator).trim(),
		action: rest.slice(actionSeparator + " - ".length).trim(),
	};
}

function isTerminalStatusAction(action: string): boolean {
	return action === "finished" || action === "failed" || action === "timed out" || action === "aborted";
}

function finishStatusText(existing: string | undefined, fallback: string): string {
	if (!existing) return `${fallback}: finished`;
	const parsed = parseStatusLine(existing, fallback);
	const prefix = parsed.spinner ? `${parsed.spinner} ` : "";
	return `${prefix}${parsed.label}: ${parsed.status ? `${parsed.status} - finished` : "finished"}`;
}

export function trimStatusField(value: string, maxLength: number): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function splitStatusDetails(status: string): { usage: string; model: string } {
	const trimmed = status.trim();
	if (!trimmed) return { usage: "usage pending", model: "model pending" };
	const separator = trimmed.lastIndexOf(" - ");
	if (separator >= 0) {
		return {
			usage: trimmed.slice(0, separator).trim() || "usage pending",
			model: trimmed.slice(separator + " - ".length).trim() || "model pending",
		};
	}
	if (trimmed.startsWith("- ")) return { usage: "usage pending", model: trimmed.slice(2).trim() || "model pending" };
	return { usage: trimmed, model: "model pending" };
}

function progressMarker(status: ParsedStatusLine & { key: string }, activeKey: string | undefined): string {
	if (status.action === "finished") return "✓";
	if (isTerminalStatusAction(status.action)) return "!";
	return status.key === activeKey ? "•" : "·";
}

export function formatSubagentProgress(snapshot: SubagentProgressSnapshot): string {
	if (snapshot.statuses.length === 0) return ["Subagents: ⠋ working", "- starting"].join("\n");
	const parsed = snapshot.statuses.map((status) => ({ key: status.key, text: status.text, description: status.description, ...parseStatusLine(status.text, status.key) }));
	const currentKeyActive = snapshot.currentKey ? parsed.find((status) => status.key === snapshot.currentKey && !isTerminalStatusAction(status.action)) : undefined;
	const currentActive = snapshot.current ? parsed.find((status) => status.text === snapshot.current && !isTerminalStatusAction(status.action)) : undefined;
	const active = currentKeyActive ?? currentActive ?? parsed.find((status) => !isTerminalStatusAction(status.action));
	const workingIndicator = active?.spinner ?? (parsed.length > 0 && parsed.every((status) => isTerminalStatusAction(status.action)) ? "✓" : "⠋");
	const header = `Subagents: ${workingIndicator} ${active ? "working" : "done"}`;
	const roleWidth = Math.max(...parsed.map((status) => status.label.length));
	const parsedDetails = parsed.map((status) => splitStatusDetails(status.status));
	const detailColumnWidth = Math.max(
		...parsed.map((status) => trimStatusField(status.description ?? "—", 56).length),
		...parsedDetails.map((details, index) => parsed[index].status ? details.usage.length : 0),
	);
	const lines = parsed.flatMap((status, index) => {
		const marker = progressMarker(status, active?.key);
		const role = status.label.padEnd(roleWidth);
		const description = trimStatusField(status.description ?? "—", 56).padEnd(detailColumnWidth);
		const details = parsedDetails[index];
		const detailIndent = " ".repeat(roleWidth + 3);
		return status.status
			? [
				`${marker} ${role} │ ${description} │ ${status.action}`,
				`${detailIndent}│ ${details.usage.padEnd(detailColumnWidth)} │ ${details.model}`,
			]
			: [`${marker} ${role} │ ${description} │ ${status.action}`];
	});
	return [header, ...lines].join("\n");
}

export interface SubagentProgressOptions {
	onToolUpdate?: ToolProgressOnUpdate;
	setWidget?: WidgetSetter;
	throttleMs?: number;
	now?: () => number;
	setTimeout?: (callback: () => void, delayMs: number) => unknown;
	clearTimeout?: (timer: unknown) => void;
}

const DEFAULT_PROGRESS_THROTTLE_MS = 300;

export function createSubagentProgress(options: SubagentProgressOptions) {
	const statuses = new Map<string, { text: string; description?: string }>();
	const throttleMs = Math.max(0, options.throttleMs ?? DEFAULT_PROGRESS_THROTTLE_MS);
	const now = options.now ?? (() => Date.now());
	const scheduleTimer = options.setTimeout ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
	const cancelTimer = options.clearTimeout ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	let current: string | undefined;
	let currentKey: string | undefined;
	let activeKey: string | undefined;
	let lastRendered = "";
	let lastPublishedAt = 0;
	let pendingTimer: unknown;

	const snapshot = (): SubagentProgressSnapshot => ({
		statuses: [...statuses.entries()].map(([key, status]) => ({ key, text: status.text, ...(status.description ? { description: status.description } : {}) })),
		...(current ? { current } : {}),
		...(currentKey ? { currentKey } : {}),
	});
	const cancelPendingPublish = () => {
		if (pendingTimer === undefined) return;
		cancelTimer(pendingTimer);
		pendingTimer = undefined;
	};
	const isNonTerminalText = (text: string, key: string): boolean => !isTerminalStatusAction(parseStatusLine(text, key).action);
	const setCurrentFromStatus = (key: string, text: string) => {
		if (isNonTerminalText(text, key)) {
			activeKey = key;
			current = text;
			currentKey = key;
			return;
		}
		const activeStatus = activeKey ? statuses.get(activeKey) : undefined;
		if (activeStatus && isNonTerminalText(activeStatus.text, activeKey as string)) {
			current = activeStatus.text;
			currentKey = activeKey;
			return;
		}
		const fallbackActive = [...statuses.entries()].reverse().find(([statusKey, statusValue]) => isNonTerminalText(statusValue.text, statusKey));
		if (fallbackActive) {
			const [statusKey, statusValue] = fallbackActive;
			activeKey = statusKey;
			current = statusValue.text;
			currentKey = statusKey;
			return;
		}
		activeKey = undefined;
		current = text;
		currentKey = key;
	};
	const publishNow = () => {
		const state = snapshot();
		const rendered = formatSubagentProgress(state);
		if (rendered === lastRendered) return;
		lastRendered = rendered;
		lastPublishedAt = now();
		options.onToolUpdate?.({ content: [{ type: "text", text: rendered }], details: { subagentProgress: state } });
		options.setWidget?.(rendered.split("\n"));
	};
	const publish = (terminal = false) => {
		if (terminal || throttleMs === 0 || lastRendered === "") {
			cancelPendingPublish();
			publishNow();
			return;
		}
		const delayMs = Math.max(0, throttleMs - (now() - lastPublishedAt));
		if (delayMs === 0) {
			cancelPendingPublish();
			publishNow();
			return;
		}
		if (pendingTimer !== undefined) return;
		pendingTimer = scheduleTimer(() => {
			pendingTimer = undefined;
			publishNow();
		}, delayMs);
	};

	return {
		text(text: string) {
			const normalized = text.trim();
			if (!normalized) return;
			activeKey = undefined;
			current = normalized;
			currentKey = undefined;
			publish();
		},
		status(status: ChildStatusUpdate) {
			const existing = statuses.get(status.key);
			const description = status.description?.trim() || existing?.description;
			const shouldActivate = status.active !== false;
			if (status.text === undefined) {
				if (!existing) return;
				const finished = finishStatusText(existing.text, status.key);
				if (finished === existing.text && description === existing.description) return;
				statuses.set(status.key, { text: finished, ...(description ? { description } : {}) });
				if (shouldActivate) setCurrentFromStatus(status.key, finished);
				publish(true);
				return;
			}
			const text = status.text.trim();
			if (!text) return;
			if (text === existing?.text && description === existing.description) {
				if (!shouldActivate) return;
				if (current === text && currentKey === status.key) return;
				const before = formatSubagentProgress(snapshot());
				setCurrentFromStatus(status.key, text);
				if (formatSubagentProgress(snapshot()) !== before) publish(isTerminalStatusAction(parseStatusLine(text, status.key).action));
				return;
			}
			statuses.set(status.key, { text, ...(description ? { description } : {}) });
			if (shouldActivate) setCurrentFromStatus(status.key, text);
			publish(isTerminalStatusAction(parseStatusLine(text, status.key).action));
		},
		snapshot,
		clear() {
			cancelPendingPublish();
			lastRendered = "";
			options.setWidget?.(undefined);
		},
	};
}

export function withSubagentProgress<T extends Record<string, unknown>>(details: T, progress: ReturnType<typeof createSubagentProgress>): T & { subagentProgress?: SubagentProgressSnapshot } {
	const subagentProgress = progress.snapshot();
	return subagentProgress.statuses.length > 0 ? { ...details, subagentProgress } : details;
}
