import * as path from "node:path";
import { isPathInside } from "./artifacts.ts";
import { isObject } from "./roles.ts";

export function resolveToolPath(input: unknown, cwd: string): string | undefined {
	if (!isObject(input)) return undefined;
	const raw = input.path ?? input.file_path;
	return typeof raw === "string" ? path.resolve(cwd, raw.replace(/^@/, "")) : undefined;
}

export function isInside(parent: string, child: string): boolean {
	return isPathInside(parent, child);
}

export function blocksReadOnlyToolMutation(event: { toolName: string; input: unknown }): string | undefined {
	if (["bash", "ctx_execute", "ctx_execute_file", "ctx_batch_execute"].includes(event.toolName)) {
		return `${event.toolName} is blocked for read-only roles because it can execute arbitrary commands or code`;
	}
	if (event.toolName === "ast_grep_scan" && isObject(event.input) && event.input.applyFixes === true) {
		return "ast_grep_scan applyFixes is blocked for read-only roles";
	}
	if (event.toolName === "ast_grep_rewrite" && isObject(event.input) && event.input.apply === true) {
		return "ast_grep_rewrite apply=true is blocked for read-only roles";
	}
	return undefined;
}
