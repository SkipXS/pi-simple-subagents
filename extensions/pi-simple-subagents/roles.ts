export const ROLE_ENV = "PI_ORCHESTRATOR_AGENT_ROLE";
export const RUN_DIR_ENV = "PI_ORCHESTRATOR_AGENT_RUN_DIR";
export const WORKER_RUNS_ENV = "PI_ORCHESTRATOR_AGENT_WORKER_RUNS";
export const REVIEW_RUNS_ENV = "PI_ORCHESTRATOR_AGENT_REVIEW_RUNS";

export const ROLE_NAMES = ["orchestrator", "scout", "worker", "reviewer"] as const;

export type RoleName = typeof ROLE_NAMES[number];
export type Purpose = "context" | "implementation" | "review" | "fix" | "validation";

export const MAX_TOOL_OUTPUT_BYTES = 24 * 1024;
export const MAX_STDERR_BYTES = 16 * 1024;
export const MAX_PROGRESS_LINE_BYTES = 500;
export const MAX_REVIEW_ANGLES = 4;
export const DEFAULT_REFERENCE_FILE_BYTES = 512 * 1024;
export const DEFAULT_CHILD_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const TEXT_PROBE_BYTES = 8192;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const DEFAULT_REVIEW_ANGLES = [
	"correctness, regressions, and runtime failures",
	"security, role boundaries, and tool-policy bypasses",
	"API design, UX, packaging, and maintainability",
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

export const ROLE_PURPOSES: Record<Exclude<RoleName, "orchestrator">, Set<Purpose>> = {
	scout: new Set(["context"]),
	worker: new Set(["implementation", "fix", "validation"]),
	reviewer: new Set(["review"]),
};

export function validateRolePurpose(role: Exclude<RoleName, "orchestrator">, purpose: Purpose): void {
	if (!ROLE_PURPOSES[role].has(purpose)) {
		throw new Error(`Invalid role/purpose combination: ${role} cannot be used for ${purpose}.`);
	}
}
