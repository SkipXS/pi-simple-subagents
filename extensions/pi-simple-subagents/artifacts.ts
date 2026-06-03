import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.ts";
import { roleById, type RoleName } from "./role-registry.ts";

export function runId(): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
	return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertPathComponentsAreNotSymlinks(target: string): void {
	const absoluteTarget = path.resolve(target);
	const parsed = path.parse(absoluteTarget);
	let current = parsed.root;
	const relativeParts = path.relative(parsed.root, absoluteTarget).split(path.sep).filter(Boolean);
	for (const part of relativeParts) {
		current = path.join(current, part);
		if (!fs.existsSync(current)) return;
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error(`Artifact base path is a symbolic link or junction: ${current}`);
		if (!stat.isDirectory()) throw new Error(`Artifact base path component is not a directory: ${current}`);
	}
}

export function resolveRunBaseDir(cwd: string, config: Config): string {
	const base = config.artifacts.baseDir || ".pi/agent-runs";
	const resolved = path.isAbsolute(base) ? path.resolve(base) : path.resolve(cwd, base);
	if (path.isAbsolute(base)) assertPathComponentsAreNotSymlinks(resolved);
	else assertExistingParentsAreNotSymlinks(path.resolve(cwd), path.join(resolved, ".base-probe"));
	fs.mkdirSync(resolved, { recursive: true });
	if (path.isAbsolute(base)) assertPathComponentsAreNotSymlinks(resolved);
	else assertExistingParentsAreNotSymlinks(path.resolve(cwd), path.join(resolved, ".base-probe"));
	return resolved;
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function resolveArtifactPath(runDir: string, name: string): string {
	const absoluteRunDir = path.resolve(runDir);
	const target = path.isAbsolute(name) ? path.resolve(name) : path.resolve(absoluteRunDir, name.replace(/^[/\\]+/, ""));
	const relative = path.relative(absoluteRunDir, target);
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

function ensureArtifactTarget(runDir: string, target: string): string {
	const absoluteTarget = resolveArtifactPath(runDir, target);
	assertExistingParentsAreNotSymlinks(runDir, absoluteTarget);
	fs.mkdirSync(path.dirname(absoluteTarget), { recursive: true });
	return absoluteTarget;
}

const RESERVED_OUTPUT_ARTIFACT_DIRS = new Set(["delegations", "logs", "outputs", "prompts", "sessions", "tasks"]);

export function validateOutputArtifactPath(runDir: string, name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Output artifact path must be a non-empty file path");
	if (path.isAbsolute(trimmed) || /^[/\\]/.test(trimmed)) throw new Error(`Output artifact path must be relative to the run dir: ${name}`);
	const target = resolveArtifactPath(runDir, trimmed);
	const relative = path.relative(path.resolve(runDir), target);
	if (relative === "") throw new Error("Output artifact path must be a file path inside the run dir, not the run dir itself");
	const firstPart = relative.split(path.sep).filter(Boolean)[0]?.toLowerCase();
	if (firstPart && RESERVED_OUTPUT_ARTIFACT_DIRS.has(firstPart)) throw new Error(`Output artifact path uses reserved run directory: ${firstPart}`);
	assertExistingParentsAreNotSymlinks(runDir, target);
	assertNoExistingLink(target, "append");
	return target;
}

function ensureArtifactFileForAppend(runDir: string, target: string): void {
	const resolvedTarget = ensureArtifactTarget(runDir, target);
	assertNoExistingLink(resolvedTarget, "append");
	try {
		fs.writeFileSync(resolvedTarget, "", { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		assertNoExistingLink(resolvedTarget, "append");
	}
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
	const target = ensureArtifactTarget(runDir, name);
	assertNoExistingLink(target, "replace");
	atomicReplaceFile(target, content, "content");
	return target;
}

export function appendArtifactFile(runDir: string, target: string, content: string): void {
	const resolvedTarget = ensureArtifactTarget(runDir, target);
	assertNoExistingLink(resolvedTarget, "append");
	fs.appendFileSync(resolvedTarget, content, { encoding: "utf8", flag: "a" });
}

export function copyArtifactFile(runDir: string, source: string, target: string): void {
	const resolvedTarget = ensureArtifactTarget(runDir, target);
	assertNoExistingLink(resolvedTarget, "replace");
	atomicReplaceFile(resolvedTarget, source, "copy");
}

export function uniqueSuffix(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveRoleSessionFile(runDir: string, role: RoleName): string {
	const fileName = roleById(role).sessionStrategy === "persistent" ? `sessions/${role}.jsonl` : `sessions/${role}-${uniqueSuffix()}.jsonl`;
	const sessionFile = resolveArtifactPath(runDir, fileName);
	ensureArtifactFileForAppend(runDir, sessionFile);
	return sessionFile;
}
