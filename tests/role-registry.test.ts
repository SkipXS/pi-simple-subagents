import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRoleSessionFile } from "../extensions/pi-simple-subagents/artifacts.ts";
import { DEFAULT_CONFIG } from "../extensions/pi-simple-subagents/config.ts";
import { roleSystemPrompt } from "../extensions/pi-simple-subagents/prompts.ts";
import { ROLE_METADATA, DELEGABLE_ROLE_NAMES, ROLE_PURPOSE_VALUES, type RoleName } from "../extensions/pi-simple-subagents/role-registry.ts";
import { RoleRunParams } from "../extensions/pi-simple-subagents/schemas.ts";
import { validateRolePurpose, type Purpose } from "../extensions/pi-simple-subagents/roles.ts";

function tempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-registry-test-"));
}

test("role registry is the source for config, prompts, and session policy", () => {
	const registryRoles = ROLE_METADATA.map((role) => role.id).sort();
	assert.deepEqual(Object.keys(DEFAULT_CONFIG.roles).sort(), registryRoles);

	const runDir = tempProject();
	for (const role of ROLE_METADATA) {
		assert.ok(DEFAULT_CONFIG.roles[role.id], `${role.id} is missing default config`);
		assert.match(roleSystemPrompt(role.id, runDir, DEFAULT_CONFIG), /You are|You synthesize/);

		const sessionFile = resolveRoleSessionFile(runDir, role.id);
		if (role.sessionStrategy === "persistent") assert.equal(sessionFile, path.join(runDir, "sessions", `${role.id}.jsonl`));
		else assert.match(sessionFile, new RegExp(`${role.id}-\\d+-[a-z0-9]+\\.jsonl$`));
	}
});

test("review prompts gate low-value findings", () => {
	const runDir = tempProject();
	const reviewerPrompt = roleSystemPrompt("reviewer", runDir, DEFAULT_CONFIG);
	const synthesisPrompt = roleSystemPrompt("synthesis", runDir, DEFAULT_CONFIG);

	assert.match(reviewerPrompt, /Finding threshold: report a finding only when/);
	assert.match(reviewerPrompt, /Do not include speculative nice-to-haves/);
	assert.match(synthesisPrompt, /omit optional polish, cosmetic cleanup, or micro-optimizations/);
	assert.match(synthesisPrompt, /practical verification\/measurement/);
});

test("delegable registry roles match run_role_agent schema and keep synthesis private", () => {
	assert.deepEqual((RoleRunParams.properties.role as unknown as { enum: string[] }).enum, [...DELEGABLE_ROLE_NAMES]);
	assert.deepEqual(DELEGABLE_ROLE_NAMES, ["scout", "worker", "reviewer"]);
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
