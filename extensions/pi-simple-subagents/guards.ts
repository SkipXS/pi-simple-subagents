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

export function blocksNonWorkerProjectMutation(event: { toolName: string; input: unknown }, cwd: string, runDir: string | undefined): string | undefined {
	if (event.toolName === "write" || event.toolName === "edit") {
		const target = resolveToolPath(event.input, cwd);
		if (!runDir) return `${event.toolName} is blocked for non-worker roles without an artifact directory`;
		if (!target) return `${event.toolName} target could not be resolved; use write_run_artifact for handoff files`;
		if (!isInside(path.resolve(runDir), target)) return `${event.toolName} may only write inside artifact directory: ${runDir}`;
	}
	if (event.toolName === "ast_grep_scan" && isObject(event.input) && event.input.applyFixes === true) {
		return "ast_grep_scan applyFixes writes files and is reserved for worker roles";
	}
	if (event.toolName === "ast_grep_rewrite" && isObject(event.input) && event.input.apply === true) {
		return "ast_grep_rewrite apply=true writes files and is reserved for worker roles";
	}
	return undefined;
}
