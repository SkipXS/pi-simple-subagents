import * as fs from "node:fs";
import { resolveArtifactPath, writeArtifact } from "./artifacts.ts";

export interface OrchestrationState {
	workerRuns: number;
	reviewRuns: number;
	reviewRunsSinceLatestWorker: number;
	latestWorkerRunReviewedClean: boolean;
	updatedAt: string;
}

export function readOrchestrationState(runDir: string): OrchestrationState | undefined {
	const statePath = resolveArtifactPath(runDir, "orchestration-state.json");
	if (!fs.existsSync(statePath)) return undefined;
	const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<OrchestrationState>;
	return {
		workerRuns: Number(parsed.workerRuns ?? 0) || 0,
		reviewRuns: Number(parsed.reviewRuns ?? 0) || 0,
		reviewRunsSinceLatestWorker: Number(parsed.reviewRunsSinceLatestWorker ?? 0) || 0,
		latestWorkerRunReviewedClean: parsed.latestWorkerRunReviewedClean === true,
		updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
	};
}

export function writeOrchestrationState(runDir: string, state: Omit<OrchestrationState, "updatedAt">): string {
	return writeArtifact(runDir, "orchestration-state.json", JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}
