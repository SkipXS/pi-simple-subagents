import { ROLE_NAMES, ROLE_REGISTRY, type Purpose, type RoleName } from "./role-registry.ts";

export const ROLE_ENV = "PI_ORCHESTRATOR_AGENT_ROLE";
export const RUN_DIR_ENV = "PI_ORCHESTRATOR_AGENT_RUN_DIR";
export const WORKER_RUNS_ENV = "PI_ORCHESTRATOR_AGENT_WORKER_RUNS";
export const REVIEW_RUNS_ENV = "PI_ORCHESTRATOR_AGENT_REVIEW_RUNS";

export { ROLE_NAMES, THINKING_LEVELS, type Purpose, type RoleName, type ThinkingLevel } from "./role-registry.ts";

export const MAX_TOOL_OUTPUT_BYTES = 24 * 1024;
export const MAX_STDERR_BYTES = 16 * 1024;
export const MAX_PROGRESS_LINE_BYTES = 500;
export const DEFAULT_REVIEW_ANGLES = [
	"adaptive general review: choose the most relevant correctness, security, reliability, performance/cost, API/UX, packaging, documentation, and maintainability concerns for the target and focus; avoid unrelated checklist coverage",
] as const;

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRoleName(value: unknown): value is RoleName {
	return typeof value === "string" && (ROLE_NAMES as readonly string[]).includes(value);
}

export function parseRoleEnv(value: string | undefined): RoleName | undefined {
	if (value === undefined || value === "") return undefined;
	if (isRoleName(value)) return value;
	throw new Error(`Invalid ${ROLE_ENV}: ${value}. Expected one of: ${ROLE_NAMES.join(", ")}`);
}

export const ROLE_PURPOSES = Object.fromEntries(
	ROLE_NAMES
		.filter((role) => role !== "orchestrator")
		.map((role) => [role, new Set(ROLE_REGISTRY[role].allowedPurposes)]),
) as Record<Exclude<RoleName, "orchestrator">, Set<Purpose>>;

export function validateRolePurpose(role: Exclude<RoleName, "orchestrator">, purpose: Purpose): void {
	if (!ROLE_PURPOSES[role].has(purpose)) {
		throw new Error(`Invalid role/purpose combination: ${role} cannot be used for ${purpose}.`);
	}
}
