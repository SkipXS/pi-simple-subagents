export const ROLE_PURPOSE_VALUES = ["context", "implementation", "review", "fix", "validation"] as const;
export type Purpose = typeof ROLE_PURPOSE_VALUES[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export type RoleSessionStrategy = "persistent" | "ephemeral";
export type RolePromptKind = "orchestrator" | "scout" | "worker" | "verifier" | "reviewer" | "synthesis";

export const ROLE_METADATA = [
	{
		id: "orchestrator",
		delegable: false,
		allowedPurposes: [] as const,
		sessionStrategy: "persistent",
		promptKind: "orchestrator",
		defaultConfig: { model: "openai-codex/gpt-5.5", thinking: "high" },
	},
	{
		id: "scout",
		delegable: true,
		allowedPurposes: ["context"] as const,
		sessionStrategy: "ephemeral",
		promptKind: "scout",
		defaultConfig: { model: "openai-codex/gpt-5.5", thinking: "minimal" },
	},
	{
		id: "worker",
		delegable: true,
		allowedPurposes: ["implementation", "fix", "validation"] as const,
		sessionStrategy: "persistent",
		promptKind: "worker",
		defaultConfig: { model: "openai-codex/gpt-5.5", thinking: "medium" },
	},
	{
		id: "verifier",
		delegable: true,
		allowedPurposes: ["validation"] as const,
		sessionStrategy: "ephemeral",
		promptKind: "verifier",
		defaultConfig: { model: "openai-codex/gpt-5.5", thinking: "low" },
	},
	{
		id: "reviewer",
		delegable: true,
		allowedPurposes: ["review"] as const,
		sessionStrategy: "ephemeral",
		promptKind: "reviewer",
		defaultConfig: { model: "openai-codex/gpt-5.5", thinking: "low" },
	},
	{
		id: "synthesis",
		delegable: false,
		allowedPurposes: ["review"] as const,
		sessionStrategy: "ephemeral",
		promptKind: "synthesis",
		defaultConfig: { model: "openai-codex/gpt-5.5", thinking: "medium" },
	},
] as const satisfies ReadonlyArray<{
	id: string;
	delegable: boolean;
	allowedPurposes: readonly Purpose[];
	sessionStrategy: RoleSessionStrategy;
	promptKind: RolePromptKind;
	defaultConfig: { model: string; thinking: ThinkingLevel };
}>;

export type RoleMetadata = typeof ROLE_METADATA[number];
export type RoleName = RoleMetadata["id"];
export type DelegableRoleName = Extract<RoleMetadata, { delegable: true }>["id"];

export const ROLE_NAMES = ROLE_METADATA.map((role) => role.id) as RoleName[];
export const DELEGABLE_ROLE_NAMES = ROLE_METADATA.filter((role) => role.delegable).map((role) => role.id) as DelegableRoleName[];
export const WORKER_ROLE_PURPOSES = roleById("worker").allowedPurposes;

export const ROLE_REGISTRY = Object.fromEntries(ROLE_METADATA.map((role) => [role.id, role])) as { [Role in RoleName]: Extract<RoleMetadata, { id: Role }> };

export function roleById<Role extends RoleName>(role: Role): Extract<RoleMetadata, { id: Role }> {
	return ROLE_METADATA.find((metadata) => metadata.id === role) as Extract<RoleMetadata, { id: Role }>;
}

export function isDelegableRole(role: RoleName): role is DelegableRoleName {
	return roleById(role).delegable;
}
