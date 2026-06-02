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

function assertNoExistingLink(target: string, mode: "replace" | "append"): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (stat.isSymbolicLink()) throw new Error(`Artifact target is a symbolic link: ${target}`);
	if (!stat.isFile()) throw new Error(`Artifact target is not a regular file: ${target}`);
	if (mode === "append" && stat.nlink > 1) throw new Error(`Artifact target has multiple hard links and cannot be appended safely: ${target}`);
}

function assertExistingParentsAreNotSymlinks(runDir: string, target: string): void {
	const absoluteRunDir = path.resolve(runDir);
	let current = absoluteRunDir;
	const relativeParts = path.relative(absoluteRunDir, path.dirname(path.resolve(target))).split(path.sep).filter(Boolean);
	for (const part of relativeParts) {
		current = path.join(current, part);
		if (!fs.existsSync(current)) return;
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error(`Artifact parent path is a symbolic link: ${current}`);
		if (!stat.isDirectory()) throw new Error(`Artifact parent path is not a directory: ${current}`);
	}
}

function ensureArtifactTarget(runDir: string, target: string): void {
	const absoluteRunDir = path.resolve(runDir);
	const absoluteTarget = path.resolve(target);
	const relative = path.relative(absoluteRunDir, absoluteTarget);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Artifact path escapes run dir: ${target}`);
	assertExistingParentsAreNotSymlinks(absoluteRunDir, absoluteTarget);
	fs.mkdirSync(path.dirname(absoluteTarget), { recursive: true });
}

function atomicReplaceFile(target: string, contentOrSource: string, mode: "content" | "copy"): void {
	const dir = path.dirname(target);
	const temp = path.join(dir, `.tmp-${path.basename(target)}-${uniqueSuffix()}`);
	try {
		if (mode === "content") fs.writeFileSync(temp, contentOrSource, { encoding: "utf8", flag: "wx" });
		else fs.copyFileSync(contentOrSource, temp, fs.constants.COPYFILE_EXCL);
		fs.renameSync(temp, target);
	} catch (error) {
		try { fs.rmSync(temp, { force: true }); } catch { /* ignore cleanup */ }
		throw error;
	}
}

export function writeArtifact(runDir: string, name: string, content: string): string {
	const target = resolveArtifactPath(runDir, name);
	ensureArtifactTarget(runDir, target);
	assertNoExistingLink(target, "replace");
	atomicReplaceFile(target, content, "content");
	return target;
}

export function appendArtifactFile(runDir: string, target: string, content: string): void {
	ensureArtifactTarget(runDir, target);
	assertNoExistingLink(target, "append");
	fs.appendFileSync(target, content, { encoding: "utf8", flag: "a" });
}

export function copyArtifactFile(runDir: string, source: string, target: string): void {
	ensureArtifactTarget(runDir, target);
	assertNoExistingLink(target, "replace");
	atomicReplaceFile(target, source, "copy");
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
