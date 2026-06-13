import type { ReviewersParams } from "./schemas.ts";

function tokenizeCommand(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else if (char === "\\" && quote === "\"" && index + 1 < input.length) {
				const next = input[index + 1];
				if (next === "\"" || next === "\\") {
					current += next;
					index++;
				} else {
					current += char;
				}
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote) throw new Error(`/review has unmatched ${quote === "\"" ? "double" : "single"} quote`);
	if (current) tokens.push(current);
	return tokens;
}

function quoteTargetIfNeeded(target: string): string {
	if (!target.startsWith("@") || !/\s/.test(target)) return target;
	return `@"${target.slice(1).replace(/"/g, "\\\"")}"`;
}

function unknownOptionError(command: string, token: string): Error {
	return new Error(`${command} unknown option: ${token}`);
}

export function parseReviewTargetCommand(input: string): ReviewersParams {
	const trimmed = input.trim();
	const tokens = tokenizeCommand(trimmed);
	const reviewers: string[] = [];
	let includeScout: boolean | undefined;
	let continueOnReviewerFailure: boolean | undefined;
	let extraContext: string | undefined;
	let cursor = 0;
	while (cursor < tokens.length) {
		const token = tokens[cursor];
		if (token === "--") {
			cursor++;
			break;
		}
		if (token === "--no-scout") {
			includeScout = false;
			cursor++;
			continue;
		}
		if (token === "--scout") {
			includeScout = true;
			cursor++;
			continue;
		}
		if (token === "--continue-on-reviewer-failure") {
			continueOnReviewerFailure = true;
			cursor++;
			continue;
		}
		if (token === "--fail-on-reviewer-failure") {
			continueOnReviewerFailure = false;
			cursor++;
			continue;
		}
		if (token === "--reviewer") {
			const reviewer = tokens[cursor + 1];
			if (!reviewer) throw new Error("/review --reviewer requires an angle/focus value");
			reviewers.push(reviewer);
			cursor += 2;
			continue;
		}
		if (token === "--context") {
			const context = tokens[cursor + 1];
			if (!context) throw new Error("/review --context requires an inline value or @file");
			extraContext = context;
			cursor += 2;
			continue;
		}
		if (token.startsWith("--reviewer=")) {
			const reviewer = token.slice("--reviewer=".length).trim();
			if (!reviewer) throw new Error("/review --reviewer requires an angle/focus value");
			reviewers.push(reviewer);
			cursor++;
			continue;
		}
		if (token.startsWith("--context=")) {
			const context = token.slice("--context=".length).trim();
			if (!context) throw new Error("/review --context requires an inline value or @file");
			extraContext = context;
			cursor++;
			continue;
		}
		if (token.startsWith("--")) throw unknownOptionError("/review", token);
		break;
	}
	if (tokens[0]?.startsWith("--") && cursor === 0) throw unknownOptionError("/review", tokens[0]);
	if (cursor > 0) {
		const target = tokens[cursor];
		if (!target) throw new Error("/review requires a target after options");
		if (target.startsWith("--") && tokens[cursor - 1] !== "--") throw unknownOptionError("/review", target);
		const focus = tokens.slice(cursor + 1).join(" ").trim();
		return {
			target: quoteTargetIfNeeded(target),
			...(focus ? { focus } : {}),
			...(extraContext !== undefined ? { extraContext: quoteTargetIfNeeded(extraContext) } : {}),
			...(reviewers.length > 0 ? { reviewers } : {}),
			...(includeScout !== undefined ? { includeScout } : {}),
			...(continueOnReviewerFailure !== undefined ? { continueOnReviewerFailure } : {}),
		};
	}
	const match = /^(@(?:"[^"]+"|'[^']+'|\S+))(?:\s+([\s\S]+))?$/.exec(trimmed);
	if (!match) return { target: trimmed };
	const focus = match[2]?.trim();
	return focus ? { target: match[1], focus } : { target: match[1] };
}
