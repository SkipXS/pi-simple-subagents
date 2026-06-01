import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.ts";
import type { RoleName } from "./roles.ts";

export function runId(): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
	return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveRunBaseDir(cwd: string, config: Config): string {
	const base = config.artifacts.baseDir || ".pi/agent-runs";
	const resolved = path.isAbsolute(base) ? path.resolve(base) : path.resolve(cwd, base);
	fs.mkdirSync(resolved, { recursive: true });
	return resolved;
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function resolveArtifactPath(runDir: string, name: string): string {
	const safeName = name.replace(/^[/\\]+/, "");
	const target = path.resolve(runDir, safeName);
	const relative = path.relative(runDir, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Artifact path escapes run dir: ${name}`);
	return target;
}

function ensureArtifactTarget(runDir: string, target: string): void {
	const absoluteRunDir = path.resolve(runDir);
	const absoluteTarget = path.resolve(target);
	const relative = path.relative(absoluteRunDir, absoluteTarget);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Artifact path escapes run dir: ${target}`);
	fs.mkdirSync(path.dirname(absoluteTarget), { recursive: true });
}

export function writeArtifact(runDir: string, name: string, content: string): string {
	const target = resolveArtifactPath(runDir, name);
	ensureArtifactTarget(runDir, target);
	fs.writeFileSync(target, content, "utf8");
	return target;
}

export function appendArtifactFile(runDir: string, target: string, content: string): void {
	ensureArtifactTarget(runDir, target);
	fs.appendFileSync(target, content, "utf8");
}

export function copyArtifactFile(runDir: string, source: string, target: string): void {
	ensureArtifactTarget(runDir, target);
	fs.copyFileSync(source, target);
}

export function uniqueSuffix(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveRoleSessionFile(runDir: string, role: RoleName): string {
	const fileName = role === "worker" || role === "orchestrator" ? `sessions/${role}.jsonl` : `sessions/${role}-${uniqueSuffix()}.jsonl`;
	const sessionFile = resolveArtifactPath(runDir, fileName);
	ensureArtifactTarget(runDir, sessionFile);
	return sessionFile;
}
