import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRoleSessionFile } from "../extensions/pi-simple-subagents/artifacts.ts";
import { DEFAULT_CONFIG } from "../extensions/pi-simple-subagents/config.ts";
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
			orchestrator: "high",
			scout: "minimal",
			worker: "medium",
			verifier: "medium",
			reviewer: "medium",
			synthesis: "medium",
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
	assert.match(reviewerPrompt, /Finding threshold: report only evidence-backed issues/i);
	assert.match(reviewerPrompt, /measurably improve correctness/i);
	assert.match(reviewerPrompt, /verification\/measurement/i);
	assert.match(reviewerPrompt, /Omit speculative, cosmetic\/style-only/i);
	assert.match(synthesisPrompt, /Do not invent findings/i);
	assert.match(synthesisPrompt, /Deduplicate and prioritize reviewer evidence/i);
	assert.match(reviewTargetPrompt, /Review-only: do not modify target\/project\/source files/i);
	assert.match(reviewTargetPrompt, /verify supplemental context against current files/i);
});

test("delegable registry roles match run_role_agent schema and keep synthesis private", () => {
	assert.deepEqual((RoleRunParams.properties.role as unknown as { enum: string[] }).enum, [...DELEGABLE_ROLE_NAMES]);
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
