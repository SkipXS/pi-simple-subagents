import * as path from "node:path";
import { clearRunActive, ensureDir, markRunActive, resolveRunBaseDir, runId, writeArtifact } from "./artifacts.ts";
import type { ChildRunResult } from "./child-runner.ts";
import type { Model, Api } from "@earendil-works/pi-ai";
import { CONFIG_EFFECTIVE_FILE } from "./constants.ts";
import { formatReferenceWarnings } from "./references.ts";
import {
	compactStatusDescription,
	formatRunTask,
	forwardChildStatus,
	requireNonEmpty,
	runConfiguredArtifactCleanup,
	workflowDeps,
	type CleanupRecord,
	type WorkflowDeps,
	type WorkflowUpdate,
} from "./workflow-common.ts";

export async function runOrchestrator(cwd: string, rawPlan: string, signal?: AbortSignal, onUpdate?: WorkflowUpdate, deps?: WorkflowDeps, parentModel?: Model<Api>): Promise<{ result: ChildRunResult; runDir: string; planSource: string } & CleanupRecord> {
	const dep = workflowDeps(deps);
	const planInput = requireNonEmpty(rawPlan, "orchestration plan");
	const config = dep.loadConfig(cwd);
	const baseDir = resolveRunBaseDir(cwd, config);
	const dir = path.join(baseDir, runId());
	ensureDir(dir);
	markRunActive(dir);
	try {
		const cleanupRecord = runConfiguredArtifactCleanup(baseDir, config, dir);
		const { planText, planSource, warnings } = dep.readPlanReference(cwd, planInput, config);
		writeArtifact(dir, "input-plan.md", `Source: ${planSource}${formatReferenceWarnings(warnings)}

${planText}
`);
		writeArtifact(dir, CONFIG_EFFECTIVE_FILE, JSON.stringify(config, null, 2));
		const task = formatRunTask(planText, planSource, dir, warnings);
		const result = await dep.spawnPiRole({ cwd, role: "orchestrator", task, runDir: dir, config, signal, onUpdate, onStatus: forwardChildStatus(onUpdate), statusKey: "subagent:orchestrator", statusLabel: "orchestrator", statusDescription: compactStatusDescription(`coordinate plan: ${planSource}`), parentModel });
		return { result, runDir: dir, planSource, ...cleanupRecord };
	} finally {
		clearRunActive(dir);
	}
}
