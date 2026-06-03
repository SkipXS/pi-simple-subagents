import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ROLE_RUN_PURPOSES, WORKER_PURPOSES } from "./constants.ts";
import { DELEGABLE_ROLE_NAMES } from "./role-registry.ts";

export const RoleRunParams = Type.Object({
	role: StringEnum(DELEGABLE_ROLE_NAMES, { description: "Role to run inside an orchestration. Allowed purpose combinations: scout=context; worker=implementation/fix/validation; reviewer=review." }),
	purpose: StringEnum(ROLE_RUN_PURPOSES, { description: "Why this role is being run. Allowed combinations: scout=context; worker=implementation/fix/validation; reviewer=review. Use validation for final tests/end-user checks." }),
	task: Type.String({ minLength: 1, description: "Concrete task for the role. For worker, pass one small work package only—not an entire milestone or full plan section. Include artifact paths, expected output file, likely files, constraints/non-goals, acceptance criteria, validation, and relevant prior artifacts/context." }),
	round: Type.Optional(Type.Integer({ minimum: 1, description: "Optional review/fix round number for artifact labels and status display." })),
	outputFile: Type.Optional(Type.String({ minLength: 1, description: "Expected handoff artifact filename inside the run dir, e.g. scout.md, worker-round-1.md, review-round-1.md, validation.md. Defaults avoid overwriting existing role artifacts; explicit names should still be unique and must not use reserved run dirs." })),
});
export type RoleRunParams = Static<typeof RoleRunParams>;

export const OrchestrateParams = Type.Object({
	plan: Type.String({ minLength: 1, description: "Inline plan text, @path, or short instruction pointing to a plan file." }),
	includeOutput: Type.Optional(Type.Boolean({ description: "Include the child assistant output inline in the final tool result. Defaults to false; artifacts always contain the full output." })),
});
export type OrchestrateParams = Static<typeof OrchestrateParams>;

export const ReviewTargetParams = Type.Object({
	target: Type.String({ minLength: 1, description: "Inline review scope, @file, @directory, or instruction pointing to what should be reviewed." }),
	focus: Type.Optional(Type.String({ description: "Optional review focus, e.g. runtime bugs, security, packaging, UX." })),
	extraContext: Type.Optional(Type.String({ description: "Optional supplemental context for reviewers, inline text or @file, especially a prior scout-report.md. Stored as extra-review-context.md; reviewers must verify it against current files." })),
	reviewers: Type.Optional(Type.Array(Type.String({ minLength: 1, description: "Reviewer angle/focus." }), { minItems: 1, maxItems: 8 })),
	includeScout: Type.Optional(Type.Boolean({ description: "Run a scout before reviewers. Default: true.", default: true })),
	includeOutput: Type.Optional(Type.Boolean({ description: "Include the synthesis output inline in the final tool result. Defaults to false; artifacts always contain the full output." })),
});
export type ReviewTargetParams = Static<typeof ReviewTargetParams>;

export const ScoutAgentParams = Type.Object({
	task: Type.String({ minLength: 1, description: "Concrete standalone scout/recon task, inline text, @file, or @directory. Use before implementation/review when context, side effects, or non-trivial scope need mapping; the scout writes a compact handoff report and should not implement changes." }),
	outputFile: Type.Optional(Type.String({ minLength: 1, description: "Expected scout report artifact filename inside the run dir. Default: scout-report.md" })),
	includeOutput: Type.Optional(Type.Boolean({ description: "Include the child assistant output inline in the final tool result. Defaults to false; artifacts always contain the full output." })),
});
export type ScoutAgentParams = Static<typeof ScoutAgentParams>;

export const WorkerAgentParams = Type.Object({
	task: Type.String({ minLength: 1, description: "Concrete standalone worker task, inline text, @file, or @directory. Keep it to one small work package rather than an entire milestone/full plan section. The worker may edit project files in YOLO mode." }),
	purpose: Type.Optional(StringEnum(WORKER_PURPOSES, { description: "Why the worker is being run. Default: implementation." })),
	outputFile: Type.Optional(Type.String({ minLength: 1, description: "Expected worker report artifact filename inside the run dir. Default: worker-report.md" })),
	includeOutput: Type.Optional(Type.Boolean({ description: "Include the child assistant output inline in the final tool result. Defaults to false; artifacts always contain the full output." })),
});
export type WorkerAgentParams = Static<typeof WorkerAgentParams>;

export const ParallelWorkerTaskParams = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1, description: "Short label for this worker, used in artifact paths." })),
	task: Type.String({ minLength: 1, description: "Concrete worker task, inline text, @file, or @directory. Keep each task independent and scoped to one small work package to avoid edit conflicts and overloaded workers." }),
	purpose: Type.Optional(StringEnum(WORKER_PURPOSES, { description: "Why this worker is being run. Default: implementation." })),
	outputFile: Type.Optional(Type.String({ minLength: 1, description: "Expected worker report artifact filename inside this worker's run dir. Default: worker-report.md" })),
});
export type ParallelWorkerTaskParams = Static<typeof ParallelWorkerTaskParams>;

export const ParallelWorkersParams = Type.Object({
	tasks: Type.Array(ParallelWorkerTaskParams, { minItems: 2, maxItems: 8, description: "Independent worker tasks to run concurrently. Do not use for overlapping refactors, shared-file edits, or tasks likely to edit the same files." }),
});
export type ParallelWorkersParams = Static<typeof ParallelWorkersParams>;

export const ArtifactParams = Type.Object({
	path: Type.String({ minLength: 1, description: "Artifact path relative to the current run directory, e.g. review-round-1.md. For expected role outputs, use the exact filename from the task's Expected output artifact line; absolute paths are rejected." }),
	content: Type.String({ description: "Markdown/text content to write" }),
});
export type ArtifactParams = Static<typeof ArtifactParams>;

export const CompactSessionParams = Type.Object({
	instructions: Type.Optional(Type.String({ description: "Optional focus instructions for the compaction summary." })),
});
export type CompactSessionParams = Static<typeof CompactSessionParams>;

export const MarkReviewCleanParams = Type.Object({
	round: Type.Optional(Type.Integer({ minimum: 1, description: "Review round that was synthesized as clean." })),
	summary: Type.String({ minLength: 1, description: "Concise synthesis explaining why there are no blockers or fixes worth doing now." }),
});
export type MarkReviewCleanParams = Static<typeof MarkReviewCleanParams>;
