import * as fs from "node:fs";
import { resolveArtifactPath, writeArtifact } from "./artifacts.ts";
import { isObject } from "./roles.ts";

export interface OrchestrationState {
	workerRuns: number;
	reviewRuns: number;
	reviewRunsSinceLatestWorker: number;
	latestWorkerRunReviewedClean: boolean;
	updatedAt: string;
}

function nonNegativeInteger(value: unknown, name: string): number {
	if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative integer`);
	return Number(value);
}

function quarantineInvalidState(runDir: string, statePath: string, message: string): void {
	try {
		const content = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : "";
		writeArtifact(runDir, `orchestration-state.invalid-${Date.now()}.json`, JSON.stringify({ reason: message, original: content }, null, 2));
	} catch {
		// State recovery must never prevent extension startup.
	}
}

export function readOrchestrationState(runDir: string): OrchestrationState | undefined {
	const statePath = resolveArtifactPath(runDir, "orchestration-state.json");
	if (!fs.existsSync(statePath)) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
		if (!isObject(parsed)) throw new Error("state root must be an object");
		if (parsed.latestWorkerRunReviewedClean !== undefined && typeof parsed.latestWorkerRunReviewedClean !== "boolean") {
			throw new Error("latestWorkerRunReviewedClean must be a boolean");
		}
		if (parsed.updatedAt !== undefined && typeof parsed.updatedAt !== "string") throw new Error("updatedAt must be a string");
		return {
			workerRuns: nonNegativeInteger(parsed.workerRuns ?? 0, "workerRuns"),
			reviewRuns: nonNegativeInteger(parsed.reviewRuns ?? 0, "reviewRuns"),
			reviewRunsSinceLatestWorker: nonNegativeInteger(parsed.reviewRunsSinceLatestWorker ?? 0, "reviewRunsSinceLatestWorker"),
			latestWorkerRunReviewedClean: parsed.latestWorkerRunReviewedClean === true,
			updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		quarantineInvalidState(runDir, statePath, message);
		return undefined;
	}
}

export function writeOrchestrationState(runDir: string, state: Omit<OrchestrationState, "updatedAt">): string {
	return writeArtifact(runDir, "orchestration-state.json", JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}
