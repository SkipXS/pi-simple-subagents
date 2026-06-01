import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.ts";

export function readReference(cwd: string, input: string, label: string, _config: Config, options?: { allowDirectory?: boolean; leadingOnly?: boolean }): { text: string; source: string } {
	const trimmed = input.trim();
	const atMatch = (options?.leadingOnly ? /^@(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed) : /(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed));
	const pathLike = atMatch?.[1] ?? atMatch?.[2] ?? atMatch?.[3];
	if (!atMatch || !pathLike) return { text: input, source: `inline ${label}` };

	const absolutePath = path.resolve(cwd, pathLike);
	if (!fs.existsSync(absolutePath)) throw new Error(`${label} reference not found: ${pathLike}`);
	const stat = fs.statSync(absolutePath);
	if (stat.isDirectory()) {
		if (!options?.allowDirectory) throw new Error(`${label} reference must be a file, got directory: ${pathLike}`);
		const rest = `${trimmed.slice(0, atMatch.index)} ${trimmed.slice(atMatch.index + atMatch[0].length)}`.trim();
		return { text: rest ? `Target directory: ${absolutePath}

Additional user instruction:
${rest}` : `Target directory: ${absolutePath}`, source: absolutePath };
	}
	if (!stat.isFile()) throw new Error(`${label} reference is not a regular file: ${pathLike}`);
	const body = fs.readFileSync(absolutePath, "utf8");
	const rest = `${trimmed.slice(0, atMatch.index)} ${trimmed.slice(atMatch.index + atMatch[0].length)}`.trim();
	return { text: rest ? `${body}

Additional user instruction:
${rest}` : body, source: absolutePath };
}

export function readPlanReference(cwd: string, input: string, config: Config): { planText: string; planSource: string } {
	const reference = readReference(cwd, input, "plan", config, { leadingOnly: true });
	return { planText: reference.text, planSource: reference.source };
}
