import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { MAX_REVIEW_ANGLES } from "./roles.ts";

export const RoleRunParams = Type.Object({
	role: StringEnum(["scout", "worker", "reviewer"] as const, { description: "Role to run" }),
	purpose: StringEnum(["context", "implementation", "review", "fix", "validation"] as const, { description: "Why this role is being run. Use validation for final tests/end-user checks." }),
	task: Type.String({ description: "Concrete task for the role. Include artifact paths and constraints." }),
	round: Type.Optional(Type.Integer({ minimum: 1 })),
	outputFile: Type.Optional(Type.String({ description: "Expected handoff artifact filename inside the run dir, e.g. review-round-1.md" })),
});
export type RoleRunParams = Static<typeof RoleRunParams>;

export const OrchestrateParams = Type.Object({
	plan: Type.String({ description: "Inline plan text, @path, or short instruction pointing to a plan file." }),
});
export type OrchestrateParams = Static<typeof OrchestrateParams>;

export const ReviewTargetParams = Type.Object({
	target: Type.String({ description: "Inline review scope, @file, @directory, or instruction pointing to what should be reviewed." }),
	focus: Type.Optional(Type.String({ description: "Optional review focus, e.g. runtime bugs, security, packaging, UX." })),
	reviewers: Type.Optional(Type.Array(Type.String({ description: "Reviewer angle/focus." }), { maxItems: MAX_REVIEW_ANGLES })),
	includeScout: Type.Optional(Type.Boolean({ description: "Run a read-only scout before reviewers. Default: true.", default: true })),
});
export type ReviewTargetParams = Static<typeof ReviewTargetParams>;

export const ArtifactParams = Type.Object({
	path: Type.String({ description: "Artifact path relative to the current run directory, e.g. review-round-1.md" }),
	content: Type.String({ description: "Markdown/text content to write" }),
});
export type ArtifactParams = Static<typeof ArtifactParams>;

export const CompactSessionParams = Type.Object({
	instructions: Type.Optional(Type.String({ description: "Optional focus instructions for the compaction summary." })),
});
export type CompactSessionParams = Static<typeof CompactSessionParams>;

export const MarkReviewCleanParams = Type.Object({
	round: Type.Optional(Type.Integer({ minimum: 1, description: "Review round that was synthesized as clean." })),
	summary: Type.String({ description: "Concise synthesis explaining why there are no blockers or fixes worth doing now." }),
});
export type MarkReviewCleanParams = Static<typeof MarkReviewCleanParams>;
