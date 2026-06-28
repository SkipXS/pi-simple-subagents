import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { resolveRoleSessionFile } from "../extensions/pi-simple-subagents/artifacts.ts";
import { applyThinking, DEFAULT_CONFIG, nextHigherThinkingLevel, roleAutoThinking, resolveModelThinking, type RoleConfig } from "../extensions/pi-simple-subagents/config.ts";
import { reviewTargetSystemPrompt, roleSystemPrompt } from "../extensions/pi-simple-subagents/prompts.ts";
import { ROLE_METADATA, DELEGABLE_ROLE_NAMES, ROLE_PURPOSE_VALUES, type RoleName } from "../extensions/pi-simple-subagents/role-registry.ts";
import { RoleRunParams } from "../extensions/pi-simple-subagents/schemas.ts";
import { validateRolePurpose, type Purpose } from "../extensions/pi-simple-subagents/roles.ts";

function tempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-registry-test-"));
}

test("role registry is the source for config, prompts, and session policy", () => {
	const registryRoles = ROLE_METADATA.map((role) => role.id).sort();
	assert.deepEqual(Object.keys(DEFAULT_CONFIG.roles).sort(), registryRoles);
	assert.deepEqual(
		Object.fromEntries(ROLE_METADATA.map((role) => [role.id, DEFAULT_CONFIG.roles[role.id].thinking])),
		{
			orchestrator: "auto",
			scout: "auto",
			worker: "auto",
			verifier: "auto",
			reviewer: "auto",
			synthesis: "auto",
		},
	);

	const runDir = tempProject();
	for (const role of ROLE_METADATA) {
		assert.ok(DEFAULT_CONFIG.roles[role.id], `${role.id} is missing default config`);
		assert.match(roleSystemPrompt(role.id, runDir, DEFAULT_CONFIG), /You are|You synthesize/);

		const sessionFile = resolveRoleSessionFile(runDir, role.id);
		if (role.sessionStrategy === "persistent") assert.equal(sessionFile, path.join(runDir, "sessions", `${role.id}.jsonl`));
		else assert.match(sessionFile, new RegExp(`${role.id}-\\d+-[a-z0-9]+\\.jsonl$`));
	}
});

test("orchestrator prompt preserves worker package and review policy semantics", () => {
	const prompt = roleSystemPrompt("orchestrator", tempProject(), DEFAULT_CONFIG);

	assert.match(prompt, /one new worker session per implementation package/i);
	assert.match(prompt, /without workerId/i);
	assert.match(prompt, /worker-1, worker-2/i);
	assert.match(prompt, /reuse the same workerId/i);
	assert.match(prompt, /Default: verify each completed implementation package before review/i);
	assert.match(prompt, /Batch only when/i);
	assert.match(prompt, /record the rationale in orchestration\.md/i);
	assert.match(prompt, /does not verify, review, or invent findings/i);
	assert.match(prompt, /worker -> verifier -> gap-fix worker/i);
	assert.match(prompt, /evidence-backed findings with concrete impact or a practical failing scenario/i);
	assert.match(prompt, /assigned acceptance criteria/i);
	assert.match(prompt, /route those to worker/i);
	assert.match(prompt, /explicitly defer optional, speculative, cosmetic\/style-only, duplicate, low-confidence, no-testable-impact/i);
	assert.match(prompt, /final whole-change multi-angle review/i);
	assert.match(prompt, /routine separate \/review after \/orchestrate unnecessary/i);
	assert.match(prompt, /orchestrator chooses the final review angles/i);
	assert.match(prompt, /do not ask the root caller to choose them/i);
	assert.match(prompt, /final-review-\*\.md/i);
	assert.match(prompt, /final whole-change review finds accepted fixes/i);
	assert.match(prompt, /reuse the affected package's workerId/i);
	assert.match(prompt, /new narrow final-fix worker package/i);
	assert.match(prompt, /inspect provided\/current artifacts/i);
	assert.match(prompt, /no light worker profile is configured/i);
	assert.match(roleSystemPrompt("orchestrator", tempProject(), { ...DEFAULT_CONFIG, workerProfiles: { light: { model: "light-model", thinking: "auto" } } }), /workerProfile=light is available/i);
	assert.match(prompt, /Run scout only when it will materially reduce uncertainty, total cost, or implementation\/review risk/i);
	assert.match(prompt, /When scout is needed, run it in a fresh session; otherwise reuse adequate current scout\/context artifacts/i);
	assert.doesNotMatch(prompt, /Scout is fresh; orchestrator persists/i);
	assert.match(prompt, /Cite scout use, skip, and reuse decisions in orchestration\.md/i);
	assert.match(prompt, /final-summary\.md at end, including whether final review was run or skipped and why/i);
});

test("prompts preserve artifact, reviewer safety, and finding-threshold semantics", () => {
	const runDir = tempProject();
	const scoutPrompt = roleSystemPrompt("scout", runDir, DEFAULT_CONFIG);
	const verifierPrompt = roleSystemPrompt("verifier", runDir, DEFAULT_CONFIG);
	const reviewerPrompt = roleSystemPrompt("reviewer", runDir, DEFAULT_CONFIG);
	const synthesisPrompt = roleSystemPrompt("synthesis", runDir, DEFAULT_CONFIG);
	const reviewTargetPrompt = reviewTargetSystemPrompt("reviewer", runDir, DEFAULT_CONFIG);

	for (const prompt of [scoutPrompt, verifierPrompt, reviewerPrompt, synthesisPrompt, reviewTargetPrompt]) {
		assert.match(prompt, /write_run_artifact/);
		assert.match(prompt, /exact relative filename/i);
		assert.match(prompt, /Expected output artifact/);
		assert.match(prompt, /Never use absolute paths or the generic write tool/i);
	}
	assert.match(scoutPrompt, /do not intentionally modify project\/source files/i);
	assert.match(scoutPrompt, /prefer read-only alternatives or explain the risk/i);
	assert.match(verifierPrompt, /Verify the assigned worker package before reviewer review/i);
	assert.match(verifierPrompt, /Implementation gaps to send back to worker/i);
	assert.match(verifierPrompt, /Do not perform broad code review/i);
	assert.match(reviewerPrompt, /Review-only: do not modify project\/source files/i);
	assert.match(reviewerPrompt, /Finding threshold: report every evidence-backed issue/i);
	assert.match(reviewerPrompt, /Do not cap findings to a top-N list/i);
	assert.match(reviewerPrompt, /measurably improve correctness/i);
	assert.match(reviewerPrompt, /verification\/measurement/i);
	assert.match(reviewerPrompt, /Omit speculative, cosmetic\/style-only/i);
	assert.match(synthesisPrompt, /Do not invent findings/i);
	assert.match(synthesisPrompt, /Deduplicate and prioritize reviewer evidence/i);
	assert.match(synthesisPrompt, /do not reduce actionable items to a top-N shortlist/i);
	assert.match(reviewTargetPrompt, /Review-only: do not modify target\/project\/source files/i);
	assert.match(reviewTargetPrompt, /verify supplemental context against current files/i);
});

test("delegable registry roles match run_role_agent schema and keep synthesis private", () => {
	assert.deepEqual((RoleRunParams.properties.role as unknown as { enum: string[] }).enum, [...DELEGABLE_ROLE_NAMES]);
	assert.deepEqual((RoleRunParams.properties.workerProfile as unknown as { enum: string[] }).enum, ["light"]);
	assert.deepEqual(DELEGABLE_ROLE_NAMES, ["scout", "worker", "verifier", "reviewer"]);
	assert.equal(DELEGABLE_ROLE_NAMES.includes("synthesis" as never), false);
	assert.equal(DELEGABLE_ROLE_NAMES.includes("orchestrator" as never), false);
});

test("role purpose validation matches registry policy", () => {
	for (const role of ROLE_METADATA) {
		for (const purpose of ROLE_PURPOSE_VALUES) {
			const isAllowed = (role.allowedPurposes as readonly Purpose[]).includes(purpose);
			if (role.id === "orchestrator") continue;
			const check = () => validateRolePurpose(role.id as Exclude<RoleName, "orchestrator">, purpose as Purpose);
			if (isAllowed) assert.doesNotThrow(check, `${role.id}/${purpose} should be allowed`);
			else assert.throws(check, /Invalid role\/purpose/, `${role.id}/${purpose} should be rejected`);
		}
	}
});

test("roleAutoThinking resolves the correct level per role and available levels", () => {
	const allLevels: ModelThinkingLevel[] = ["xhigh", "high", "medium", "low", "minimal", "off"];

	// orchestrator with all levels available → "high" (prefer high over max/xhigh)
	assert.equal(roleAutoThinking("orchestrator", allLevels), "high");

	// orchestrator with only ["off","minimal","medium"] → "medium"
	assert.equal(roleAutoThinking("orchestrator", ["off", "minimal", "medium"]), "medium");

	// orchestrator with only ["off"] → "off"
	assert.equal(roleAutoThinking("orchestrator", ["off"]), "off");

	// scout → always "off" regardless of available levels
	assert.equal(roleAutoThinking("scout", allLevels), "off");
	assert.equal(roleAutoThinking("scout", ["off", "minimal"]), "off");
	assert.equal(roleAutoThinking("scout", ["off"]), "off");

	// worker with all levels → "medium"
	assert.equal(roleAutoThinking("worker", allLevels), "medium");

	// verifier with all levels → "low" (focused acceptance check)
	assert.equal(roleAutoThinking("verifier", allLevels), "low");
	assert.equal(roleAutoThinking("verifier", ["off", "high", "xhigh"]), "high");

	// reviewer with all levels → "medium"
	assert.equal(roleAutoThinking("reviewer", allLevels), "medium");

	// worker with only ["off","low","xhigh"] → "xhigh" (next higher than medium)
	assert.equal(roleAutoThinking("worker", ["off", "low", "xhigh"]), "xhigh");

	// worker with only ["off","minimal"] → "minimal" (fallback to highest available)
	assert.equal(roleAutoThinking("worker", ["off", "minimal"]), "minimal");

	// worker with only ["off"] → "off"
	assert.equal(roleAutoThinking("worker", ["off"]), "off");

	// worker with ["off","minimal","medium"] → "medium" (exact match)
	assert.equal(roleAutoThinking("worker", ["off", "minimal", "medium"]), "medium");

	// worker with ["off","minimal","high"] → "high" (prefer higher over medium)
	assert.equal(roleAutoThinking("worker", ["off", "minimal", "high"]), "high");

	assert.equal(nextHigherThinkingLevel("medium", allLevels), "high");
	assert.equal(nextHigherThinkingLevel("high", allLevels), "xhigh");
	assert.equal(nextHigherThinkingLevel("xhigh", allLevels), "xhigh");
	assert.equal(nextHigherThinkingLevel("medium", ["off", "xhigh"]), "xhigh");
	assert.equal(nextHigherThinkingLevel("high", ["off", "medium", "high"]), "high");
	assert.equal(nextHigherThinkingLevel("medium"), "high");

	// synthesis uses the smallest supported non-off level
	assert.equal(roleAutoThinking("synthesis", allLevels), "minimal");
	assert.equal(roleAutoThinking("synthesis", ["minimal", "low", "medium", "high", "xhigh"]), "minimal");
	assert.equal(roleAutoThinking("synthesis", ["medium", "high", "xhigh"]), "medium");
	assert.equal(roleAutoThinking("synthesis", ["xhigh"]), "xhigh");
	assert.equal(roleAutoThinking("synthesis", ["off"]), "off");
});

test("resolveModelThinking handles auto model/thinking with and without parentModel", () => {
	const DEFAULT_MODEL = "openai-codex/gpt-5.5";

	// model: "auto" with parentModel → uses provider-qualified parent model id
	const parentModel = { provider: "custom-provider", id: "custom/model", reasoning: false } as unknown as Model<Api>;
	assert.deepEqual(
		resolveModelThinking(parentModel, { model: "auto", thinking: "off" }, "worker"),
		{ model: "custom-provider/custom/model", thinking: "off" },
	);

	// model: "auto" without parentModel → falls back to default
	assert.deepEqual(
		resolveModelThinking(undefined, { model: "auto", thinking: "off" }, "worker"),
		{ model: DEFAULT_MODEL, thinking: "off" },
	);

	// thinking: "auto" with parentModel (reasoning model) → uses roleAutoThinking()
	const reasoningParent = { provider: "reasoning-provider", id: "reasoning/model", reasoning: true } as unknown as Model<Api>;
	const resolvedWorker = resolveModelThinking(reasoningParent, { model: "auto", thinking: "auto" }, "worker");
	assert.equal(resolvedWorker.model, "reasoning-provider/reasoning/model");
	assert.equal(resolvedWorker.thinking, "medium"); // worker default with full levels

	const resolvedScout = resolveModelThinking(reasoningParent, { model: "auto", thinking: "auto" }, "scout");
	assert.equal(resolvedScout.model, "reasoning-provider/reasoning/model");
	assert.equal(resolvedScout.thinking, "off"); // scout always off

	const resolvedOrch = resolveModelThinking(reasoningParent, { model: "auto", thinking: "auto" }, "orchestrator");
	assert.equal(resolvedOrch.model, "reasoning-provider/reasoning/model");
	assert.equal(resolvedOrch.thinking, "high"); // orchestrator prefers high

	const resolvedSynth = resolveModelThinking(reasoningParent, { model: "auto", thinking: "auto" }, "synthesis");
	assert.equal(resolvedSynth.model, "reasoning-provider/reasoning/model");
	assert.equal(resolvedSynth.thinking, "minimal"); // synthesis uses minimal when available

	// thinking: "auto" without parentModel → pre-auto role fallback
	assert.deepEqual(
		resolveModelThinking(undefined, { model: "custom-model", thinking: "auto" }, "worker"),
		{ model: "custom-model", thinking: "medium" },
	);

	// thinking: "auto" with non-reasoning parentModel → scout is off, worker falls back
	const nonReasoningParent = { provider: "fast-provider", id: "fast/model", reasoning: false } as unknown as Model<Api>;
	assert.deepEqual(
		resolveModelThinking(nonReasoningParent, { model: "auto", thinking: "auto" }, "scout"),
		{ model: "fast-provider/fast/model", thinking: "off" },
	);
	assert.deepEqual(
		resolveModelThinking(nonReasoningParent, { model: "auto", thinking: "auto" }, "worker"),
		{ model: "fast-provider/fast/model", thinking: "off" },
	);

	// explicit model/thinking → passed through unchanged
	assert.deepEqual(
		resolveModelThinking(parentModel, { model: "explicit-model", thinking: "high" }, "worker"),
		{ model: "explicit-model", thinking: "high" },
	);

	// explicit model with auto thinking + parentModel
	assert.deepEqual(
		resolveModelThinking(reasoningParent, { model: "explicit-model", thinking: "auto" }, "worker"),
		{ model: "explicit-model", thinking: "medium" },
	);

	// auto model with explicit thinking
	assert.deepEqual(
		resolveModelThinking(parentModel, { model: "auto", thinking: "minimal" }, "worker"),
		{ model: "custom-provider/custom/model", thinking: "minimal" },
	);

	// light worker profile auto thinking → one level above default worker thinking
	assert.deepEqual(
		resolveModelThinking(reasoningParent, { model: "auto", thinking: "auto" }, "worker", { autoThinking: "worker-plus-one", baseThinking: "medium" }),
		{ model: "reasoning-provider/reasoning/model", thinking: "high" },
	);
	assert.deepEqual(
		resolveModelThinking(reasoningParent, { model: "explicit-light", thinking: "auto" }, "worker", { autoThinking: "worker-plus-one", baseThinking: "medium" }),
		{ model: "explicit-light", thinking: "high" },
	);

	// model: "auto" with fine-grained parentModel that has high and xhigh thinking → orchestrator still prefers high
	const xhighParent = { provider: "xhigh-provider", id: "xhigh/model", reasoning: true, thinkingLevelMap: { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true } } as unknown as Model<Api>;
	const resolvedXhighOrch = resolveModelThinking(xhighParent, { model: "auto", thinking: "auto" }, "orchestrator");
	assert.equal(resolvedXhighOrch.model, "xhigh-provider/xhigh/model");
	assert.equal(resolvedXhighOrch.thinking, "high");

	// sparse high/xhigh models like DeepSeek V4 Pro use xhigh for orchestration
	const sparseHighXhighParent = { provider: "deepseek-provider", id: "deepseek/model", reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } } as unknown as Model<Api>;
	assert.equal(resolveModelThinking(sparseHighXhighParent, { model: "auto", thinking: "auto" }, "orchestrator").thinking, "xhigh");

	// if high is unavailable, orchestrator can use xhigh
	const onlyXhighParent = { provider: "xhigh-provider", id: "only-xhigh/model", reasoning: true, thinkingLevelMap: { off: true, minimal: null, low: null, medium: null, high: null, xhigh: true } } as unknown as Model<Api>;
	assert.equal(resolveModelThinking(onlyXhighParent, { model: "auto", thinking: "auto" }, "orchestrator").thinking, "xhigh");
});

test("applyThinking handles auto and explicit thinking levels", () => {
	// auto → returns bare model string (no suffix)
	assert.equal(applyThinking("test/model", "auto"), "test/model");

	// off → returns bare model string (no suffix)
	assert.equal(applyThinking("test/model", "off"), "test/model");

	// undefined thinking → returns bare model string
	assert.equal(applyThinking("test/model", undefined), "test/model");

	// explicit thinking level → appends suffix
	assert.equal(applyThinking("test/model", "high"), "test/model:high");
	assert.equal(applyThinking("test/model", "medium"), "test/model:medium");
	assert.equal(applyThinking("test/model", "low"), "test/model:low");
	assert.equal(applyThinking("test/model", "minimal"), "test/model:minimal");
	assert.equal(applyThinking("test/model", "xhigh"), "test/model:xhigh");

	// model already has a thinking suffix → not doubled
	assert.equal(applyThinking("test/model:high", "medium"), "test/model:high");
	assert.equal(applyThinking("test/model:off", "xhigh"), "test/model:off");
});
