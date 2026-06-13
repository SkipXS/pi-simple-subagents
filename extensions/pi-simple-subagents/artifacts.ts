import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.ts";
import { CONFIG_EFFECTIVE_FILE, EXTRA_REVIEW_CONTEXT_FILE, INPUT_SCOUT_TASK_FILE, INPUT_TARGET_FILE, INPUT_WORKER_TASK_FILE } from "./constants.ts";
import { roleById, type RoleName } from "./role-registry.ts";

export const ACTIVE_RUN_MARKER_FILE = ".pi-simple-subagents-active-run";
export const OWNED_RUN_MARKER_FILE = ".pi-simple-subagents-run.json";

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
const RESERVED_OUTPUT_ARTIFACT_FILES = new Set([
	ACTIVE_RUN_MARKER_FILE,
	OWNED_RUN_MARKER_FILE,
	CONFIG_EFFECTIVE_FILE,
	EXTRA_REVIEW_CONTEXT_FILE,
	"input-plan.md",
	INPUT_SCOUT_TASK_FILE,
	INPUT_TARGET_FILE,
	INPUT_WORKER_TASK_FILE,
].map((name) => name.toLowerCase()));

export function validateOutputArtifactPath(runDir: string, name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Output artifact path must be a non-empty file path");
	if (path.isAbsolute(trimmed) || /^[/\\]/.test(trimmed)) throw new Error(`Output artifact path must be relative to the run dir: ${name}`);
	const rawParts = trimmed.split(/[\\/]+/).filter(Boolean);
	if (rawParts.some((part) => part.includes(":"))) throw new Error(`Output artifact path components must not contain ':' characters: ${name}`);
	const target = resolveArtifactPath(runDir, trimmed);
	const relative = path.relative(path.resolve(runDir), target);
	if (relative === "") throw new Error("Output artifact path must be a file path inside the run dir, not the run dir itself");
	const parts = relative.split(path.sep).filter(Boolean);
	const firstPart = parts[0]?.toLowerCase();
	if (firstPart && RESERVED_OUTPUT_ARTIFACT_DIRS.has(firstPart)) throw new Error(`Output artifact path uses reserved run directory: ${firstPart}`);
	if (parts.length === 1 && firstPart && RESERVED_OUTPUT_ARTIFACT_FILES.has(firstPart)) throw new Error(`Output artifact path uses protected run file: ${firstPart}`);
	assertExistingParentsAreNotSymlinks(runDir, target);
	assertNoExistingLink(target, "append");
	return target;
}

export function requireExpectedOutputArtifact(runDir: string, name: string): string {
	const target = validateOutputArtifactPath(runDir, name);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Expected output artifact does not exist: ${target}`);
		throw error;
	}
	if (stat.isSymbolicLink()) throw new Error(`Expected output artifact is a symbolic link: ${target}`);
	if (!stat.isFile()) throw new Error(`Expected output artifact is not a regular file: ${target}`);
	if (stat.nlink > 1) throw new Error(`Expected output artifact has multiple hard links and cannot be accepted safely: ${target}`);
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

function validateSessionLabel(label: string): string {
	const trimmed = label.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) throw new Error(`Invalid role session label: ${label}`);
	return trimmed;
}

export function roleSessionArtifactName(role: RoleName, sessionLabel?: string): string {
	if (sessionLabel !== undefined) return `sessions/${validateSessionLabel(sessionLabel)}.jsonl`;
	return roleById(role).sessionStrategy === "persistent" ? `sessions/${role}.jsonl` : `sessions/${role}-${uniqueSuffix()}.jsonl`;
}

export function resolveRoleSessionFile(runDir: string, role: RoleName, sessionLabel?: string): string {
	const sessionFile = resolveArtifactPath(runDir, roleSessionArtifactName(role, sessionLabel));
	ensureArtifactFileForAppend(runDir, sessionFile);
	return sessionFile;
}

export interface ArtifactCleanupResult {
	configured: boolean;
	baseDir: string;
	deletedRuns: number;
	deletedBytes: number;
	skippedRuns: number;
	errors: string[];
}

interface CleanupCandidate {
	path: string;
	mtimeMs: number;
	sizeBytes?: number;
}

function artifactCleanupConfigured(config: Config): boolean {
	return config.artifacts.cleanup.maxAgeMs > 0 || config.artifacts.cleanup.maxTotalBytes > 0;
}

function directorySizeBytes(dir: string): number {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const target = path.join(dir, entry.name);
		const stat = fs.lstatSync(target);
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) total += directorySizeBytes(target);
		else if (stat.isFile()) total += stat.size;
	}
	return total;
}

function isExtensionRunDir(dir: string): boolean {
	try {
		const stat = fs.lstatSync(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
		const marker = path.join(dir, OWNED_RUN_MARKER_FILE);
		const markerStat = fs.lstatSync(marker);
		if (!markerStat.isFile() || markerStat.isSymbolicLink()) return false;
		const parsed = JSON.parse(fs.readFileSync(marker, "utf8")) as { extension?: unknown; marker?: unknown };
		return parsed.extension === "pi-simple-subagents" && parsed.marker === "owned-run";
	} catch {
		return false;
	}
}

export function markRunOwned(runDir: string): string {
	ensureDir(runDir);
	return writeArtifact(runDir, OWNED_RUN_MARKER_FILE, JSON.stringify({ extension: "pi-simple-subagents", marker: "owned-run", version: 1, createdAt: new Date().toISOString() }, null, 2));
}

export function markRunActive(runDir: string): string {
	markRunOwned(runDir);
	return writeArtifact(runDir, ACTIVE_RUN_MARKER_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
}

export function clearRunActive(runDir: string): void {
	try {
		fs.rmSync(resolveArtifactPath(runDir, ACTIVE_RUN_MARKER_FILE), { force: true });
	} catch {
		// Best-effort lifecycle marker cleanup; stale markers fail safe by preserving runs.
	}
}

function isRunActive(dir: string): boolean {
	try {
		const marker = path.join(dir, ACTIVE_RUN_MARKER_FILE);
		return fs.lstatSync(marker).isFile();
	} catch {
		return false;
	}
}

function cleanupCandidates(baseDir: string, activeRunDir: string | undefined, errors: string[]): CleanupCandidate[] {
	const active = activeRunDir ? path.resolve(activeRunDir) : undefined;
	const candidates: CleanupCandidate[] = [];
	for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
		const target = path.join(baseDir, entry.name);
		if (active && path.resolve(target) === active) continue;
		if (!entry.isDirectory() || !isExtensionRunDir(target) || isRunActive(target)) continue;
		try {
			const stat = fs.statSync(target);
			candidates.push({ path: target, mtimeMs: stat.mtimeMs });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${target}: ${message}`);
		}
	}
	return candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
}

export function cleanupRunArtifacts(baseDir: string, config: Config, activeRunDir?: string, nowMs = Date.now()): ArtifactCleanupResult | undefined {
	if (!artifactCleanupConfigured(config)) return undefined;
	const result: ArtifactCleanupResult = { configured: true, baseDir, deletedRuns: 0, deletedBytes: 0, skippedRuns: 0, errors: [] };
	if (!fs.existsSync(baseDir)) return result;
	const absoluteBase = path.resolve(baseDir);
	const active = activeRunDir ? path.resolve(activeRunDir) : undefined;
	if (active && !isPathInside(absoluteBase, active)) throw new Error(`Active run dir is outside artifact base dir: ${activeRunDir}`);
	const candidateSize = (candidate: CleanupCandidate): number => {
		if (candidate.sizeBytes !== undefined) return candidate.sizeBytes;
		candidate.sizeBytes = directorySizeBytes(candidate.path);
		return candidate.sizeBytes;
	};
	const removeCandidate = (candidate: CleanupCandidate) => {
		let sizeBytes = 0;
		try {
			sizeBytes = candidateSize(candidate);
			fs.rmSync(candidate.path, { recursive: true, force: true });
			result.deletedRuns++;
			result.deletedBytes += sizeBytes;
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.errors.push(`${candidate.path}: ${message}`);
			return false;
		}
	};
	let candidates = cleanupCandidates(absoluteBase, active, result.errors);
	if (config.artifacts.cleanup.maxAgeMs > 0) {
		const cutoff = nowMs - config.artifacts.cleanup.maxAgeMs;
		const retained: CleanupCandidate[] = [];
		for (const candidate of candidates) {
			if (candidate.mtimeMs < cutoff) {
				if (!removeCandidate(candidate)) retained.push(candidate);
			} else {
				retained.push(candidate);
			}
		}
		candidates = retained;
	}
	if (config.artifacts.cleanup.maxTotalBytes > 0) {
		let activeBytes = 0;
		if (active && fs.existsSync(active)) {
			try { activeBytes = directorySizeBytes(active); }
			catch (error) { result.errors.push(`${active}: ${error instanceof Error ? error.message : String(error)}`); }
		}
		let totalBytes = activeBytes;
		for (const candidate of candidates) {
			try { totalBytes += candidateSize(candidate); }
			catch (error) { result.errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`); }
		}
		const retained: CleanupCandidate[] = [];
		for (const candidate of candidates) {
			const sizeBytes = candidate.sizeBytes ?? 0;
			if (totalBytes > config.artifacts.cleanup.maxTotalBytes && removeCandidate(candidate)) {
				totalBytes -= sizeBytes;
			} else {
				retained.push(candidate);
			}
		}
		candidates = retained;
	}
	result.skippedRuns = candidates.length;
	return result;
}

export function formatArtifactCleanupResult(cleanup: ArtifactCleanupResult | undefined): string | undefined {
	if (!cleanup) return undefined;
	const parts = [`deleted ${cleanup.deletedRuns} run${cleanup.deletedRuns === 1 ? "" : "s"}`, `${cleanup.deletedBytes} bytes`];
	if (cleanup.skippedRuns) parts.push(`${cleanup.skippedRuns} retained`);
	if (cleanup.errors.length > 0) parts.push(`${cleanup.errors.length} error${cleanup.errors.length === 1 ? "" : "s"}`);
	return parts.join(", ");
}
