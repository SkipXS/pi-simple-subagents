import { MAX_TOOL_OUTPUT_BYTES } from "./roles.ts";

export function takeUtf8Head(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
	return text.slice(0, end);
}

export function takeUtf8Tail(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let start = Math.max(0, text.length - maxBytes);
	while (start < text.length && Buffer.byteLength(text.slice(start), "utf8") > maxBytes) start++;
	return text.slice(start);
}

export function truncateForTool(text: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): { text: string; truncated: boolean; totalBytes: number } {
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= maxBytes) return { text, truncated: false, totalBytes };
	const kept = takeUtf8Head(text, maxBytes);
	return {
		text: `${kept}\n\n[Output truncated: ${totalBytes - Buffer.byteLength(kept, "utf8")} bytes omitted. See artifact/log paths for full output.]`,
		truncated: true,
		totalBytes,
	};
}

export function appendBoundedTail(current: string, chunk: string, maxBytes: number): string {
	const combined = current + chunk;
	if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
	const tail = takeUtf8Tail(combined, maxBytes);
	return `[stderr truncated: kept last ${Buffer.byteLength(tail, "utf8")} bytes]\n${tail}`;
}
