import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isPathInside } from "./artifacts.ts";

export interface ProjectSnapshot {
	kind: "git" | "filesystem";
	hash: string;
	fileCount: number;
}

export interface ProjectWriteFenceResult {
	changed: boolean;
	before: ProjectSnapshot;
	after: ProjectSnapshot;
	restored: boolean;
	restoredSnapshot?: ProjectSnapshot;
	error?: string;
}

export interface ProjectWriteFence {
	before: ProjectSnapshot;
	restoreIfChanged(): ProjectWriteFenceResult;
}

type FileBackup =
	| { kind: "file"; data: Buffer; mode: number }
	| { kind: "symlink"; target: string };

type SnapshotArchiveEntry =
	| { path: string; kind: "file"; mode: number }
	| { path: string; kind: "symlink"; target: string };

interface SnapshotArchiveManifest {
	version: 1;
	snapshot: ProjectSnapshot;
	files: SnapshotArchiveEntry[];
}

const PROTECTED_CONTROL_FILES = [
	".pi/pi-simple-subagents/config.json",
] as const;

function bufferFromSpawnStdout(value: string | Buffer): Buffer {
	return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function runGit(cwd: string, args: string[]): Buffer | undefined {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
	if (result.status !== 0 || result.error) return undefined;
	return bufferFromSpawnStdout(result.stdout as string | Buffer);
}

function normalizedRelativePath(relativePath: string): string {
	return relativePath.split(path.sep).join("/");
}

function isExcluded(absolutePath: string, excludedRoots: string[]): boolean {
	return excludedRoots.map((root) => path.resolve(root)).some((root) => isPathInside(root, absolutePath));
}

function addProtectedControlFiles(cwd: string, files: string[], excludedRoots: string[]): string[] {
	const seen = new Set(files.map((file) => normalizedRelativePath(file)));
	for (const protectedFile of PROTECTED_CONTROL_FILES) {
		const absolutePath = path.resolve(cwd, protectedFile);
		if (isExcluded(absolutePath, excludedRoots)) continue;
		if (fs.existsSync(absolutePath)) seen.add(protectedFile);
	}
	return [...seen].sort();
}

function hashPathEntry(hash: ReturnType<typeof createHash>, cwd: string, relativePath: string): boolean {
	const absolutePath = path.resolve(cwd, relativePath);
	if (!isPathInside(path.resolve(cwd), absolutePath) || !fs.existsSync(absolutePath)) return false;
	const stat = fs.lstatSync(absolutePath);
	hash.update(normalizedRelativePath(relativePath));
	hash.update("\0");
	if (stat.isSymbolicLink()) {
		hash.update("symlink\0");
		hash.update(fs.readlinkSync(absolutePath));
		return true;
	}
	if (!stat.isFile()) return false;
	hash.update(`${stat.mode}\0${stat.size}\0`);
	hash.update(fs.readFileSync(absolutePath));
	hash.update("\0");
	return true;
}

function listGitProjectFiles(cwd: string, excludedRoots: string[] = []): string[] | undefined {
	const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"])?.toString("utf8").trim();
	if (inside !== "true") return undefined;
	const output = runGit(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	if (!output) return undefined;
	const files = output.toString("utf8").split("\0").filter(Boolean).filter((file) => {
		const absolutePath = path.resolve(cwd, file);
		return !isExcluded(absolutePath, excludedRoots);
	});
	return addProtectedControlFiles(cwd, files, excludedRoots);
}

function listFilesystemProjectFiles(cwd: string, excludedRoots: string[] = []): string[] {
	const excludedNames = new Set([".git", ".pi", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache"]);
	const files: string[] = [];
	const walk = (dir: string) => {
		if (isExcluded(path.resolve(dir), excludedRoots)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (excludedNames.has(entry.name)) continue;
			const absolutePath = path.join(dir, entry.name);
			const relativePath = path.relative(cwd, absolutePath);
			if (entry.isDirectory()) walk(absolutePath);
			else if (entry.isFile() || entry.isSymbolicLink()) files.push(normalizedRelativePath(relativePath));
		}
	};
	walk(cwd);
	return addProtectedControlFiles(cwd, files, excludedRoots);
}

function listProjectFiles(cwd: string, excludedRoots: string[] = []): { kind: ProjectSnapshot["kind"]; files: string[] } {
	const gitFiles = listGitProjectFiles(cwd, excludedRoots);
	return gitFiles ? { kind: "git", files: gitFiles } : { kind: "filesystem", files: listFilesystemProjectFiles(cwd, excludedRoots) };
}

function createSnapshotFromFiles(cwd: string, kind: ProjectSnapshot["kind"], files: string[]): ProjectSnapshot {
	const hash = createHash("sha256");
	hash.update(`${kind}\0`);
	let fileCount = 0;
	for (const file of files) if (hashPathEntry(hash, cwd, file)) fileCount++;
	return { kind, hash: hash.digest("hex"), fileCount };
}

export function createProjectSnapshot(cwd: string, excludedRoots: string[] = []): ProjectSnapshot {
	const { kind, files } = listProjectFiles(cwd, excludedRoots);
	return createSnapshotFromFiles(cwd, kind, files);
}

function backupFile(cwd: string, relativePath: string): FileBackup | undefined {
	const absolutePath = path.resolve(cwd, relativePath);
	if (!isPathInside(path.resolve(cwd), absolutePath) || !fs.existsSync(absolutePath)) return undefined;
	const stat = fs.lstatSync(absolutePath);
	if (stat.isSymbolicLink()) return { kind: "symlink", target: fs.readlinkSync(absolutePath) };
	if (!stat.isFile()) return undefined;
	return { kind: "file", data: fs.readFileSync(absolutePath), mode: stat.mode };
}

function removeEmptyParents(cwd: string, relativePath: string): void {
	let dir = path.dirname(path.resolve(cwd, relativePath));
	const root = path.resolve(cwd);
	while (dir !== root && isPathInside(root, dir)) {
		try {
			fs.rmdirSync(dir);
		} catch {
			return;
		}
		dir = path.dirname(dir);
	}
}

function restoreFile(cwd: string, relativePath: string, backup: FileBackup): void {
	const absolutePath = path.resolve(cwd, relativePath);
	if (!isPathInside(path.resolve(cwd), absolutePath)) return;
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.rmSync(absolutePath, { force: true, recursive: true });
	if (backup.kind === "symlink") {
		fs.symlinkSync(backup.target, absolutePath);
		return;
	}
	fs.writeFileSync(absolutePath, backup.data);
	fs.chmodSync(absolutePath, backup.mode);
}

function assertArchivePathInside(archiveDir: string, target: string): void {
	const archiveRoot = path.resolve(archiveDir);
	const resolved = path.resolve(target);
	if (!isPathInside(archiveRoot, resolved)) throw new Error(`Snapshot archive path escapes archive dir: ${resolved}`);
}

function archiveFilePath(archiveDir: string, relativePath: string): string {
	const target = path.resolve(archiveDir, "files", relativePath);
	assertArchivePathInside(path.resolve(archiveDir, "files"), target);
	return target;
}

function manifestPath(archiveDir: string): string {
	const target = path.resolve(archiveDir, "manifest.json");
	assertArchivePathInside(archiveDir, target);
	return target;
}

function validateArchiveEntry(value: unknown): SnapshotArchiveEntry | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.path !== "string" || record.path.trim() === "" || path.isAbsolute(record.path) || record.path.split(/[\\/]/).includes("..")) return undefined;
	if (record.kind === "file" && Number.isInteger(record.mode)) return { path: record.path, kind: "file", mode: Number(record.mode) };
	if (record.kind === "symlink" && typeof record.target === "string") return { path: record.path, kind: "symlink", target: record.target };
	return undefined;
}

function readSnapshotArchiveManifest(archiveDir: string): SnapshotArchiveManifest {
	const parsed = JSON.parse(fs.readFileSync(manifestPath(archiveDir), "utf8")) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Snapshot archive manifest must be an object");
	const record = parsed as Record<string, unknown>;
	const snapshot = record.snapshot as Partial<ProjectSnapshot> | undefined;
	if (record.version !== 1 || !snapshot || (snapshot.kind !== "git" && snapshot.kind !== "filesystem") || typeof snapshot.hash !== "string" || typeof snapshot.fileCount !== "number") {
		throw new Error("Snapshot archive manifest has an invalid snapshot header");
	}
	if (!Array.isArray(record.files)) throw new Error("Snapshot archive manifest files must be an array");
	const files = record.files.map(validateArchiveEntry);
	if (files.some((entry) => entry === undefined)) throw new Error("Snapshot archive manifest contains an invalid file entry");
	return { version: 1, snapshot: { kind: snapshot.kind, hash: snapshot.hash, fileCount: snapshot.fileCount }, files: files as SnapshotArchiveEntry[] };
}

export function writeProjectSnapshotArchive(cwd: string, archiveDir: string, excludedRoots: string[] = []): ProjectSnapshot {
	const listed = listProjectFiles(cwd, excludedRoots);
	const snapshot = createSnapshotFromFiles(cwd, listed.kind, listed.files);
	fs.rmSync(archiveDir, { recursive: true, force: true });
	fs.mkdirSync(path.resolve(archiveDir, "files"), { recursive: true });
	const manifest: SnapshotArchiveManifest = { version: 1, snapshot, files: [] };
	for (const file of listed.files) {
		const backup = backupFile(cwd, file);
		if (!backup) continue;
		if (backup.kind === "symlink") {
			manifest.files.push({ path: normalizedRelativePath(file), kind: "symlink", target: backup.target });
			continue;
		}
		const target = archiveFilePath(archiveDir, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, backup.data);
		manifest.files.push({ path: normalizedRelativePath(file), kind: "file", mode: backup.mode });
	}
	fs.writeFileSync(manifestPath(archiveDir), JSON.stringify(manifest, null, 2), "utf8");
	return snapshot;
}

export function restoreProjectSnapshotArchive(cwd: string, archiveDir: string, excludedRoots: string[] = []): ProjectWriteFenceResult {
	const manifest = readSnapshotArchiveManifest(archiveDir);
	const after = createProjectSnapshot(cwd, excludedRoots);
	if (manifest.snapshot.hash === after.hash) return { changed: false, before: manifest.snapshot, after, restored: false };
	let error: string | undefined;
	try {
		const afterFiles = listProjectFiles(cwd, excludedRoots).files;
		const manifestSet = new Set(manifest.files.map((entry) => entry.path));
		for (const file of afterFiles) {
			if (manifestSet.has(normalizedRelativePath(file))) continue;
			const absolutePath = path.resolve(cwd, file);
			if (isPathInside(path.resolve(cwd), absolutePath)) {
				fs.rmSync(absolutePath, { force: true, recursive: true });
				removeEmptyParents(cwd, file);
			}
		}
		for (const entry of manifest.files) {
			const absolutePath = path.resolve(cwd, entry.path);
			if (!isPathInside(path.resolve(cwd), absolutePath)) continue;
			fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
			fs.rmSync(absolutePath, { force: true, recursive: true });
			if (entry.kind === "symlink") {
				fs.symlinkSync(entry.target, absolutePath);
			} else {
				fs.copyFileSync(archiveFilePath(archiveDir, entry.path), absolutePath);
				fs.chmodSync(absolutePath, entry.mode);
			}
		}
	} catch (restoreError) {
		error = restoreError instanceof Error ? restoreError.message : String(restoreError);
	}
	const restoredSnapshot = createProjectSnapshot(cwd, excludedRoots);
	return { changed: true, before: manifest.snapshot, after, restored: restoredSnapshot.hash === manifest.snapshot.hash, restoredSnapshot, error };
}

export function createProjectWriteFence(cwd: string, excludedRoots: string[] = []): ProjectWriteFence {
	const beforeFiles = listProjectFiles(cwd, excludedRoots);
	const before = createSnapshotFromFiles(cwd, beforeFiles.kind, beforeFiles.files);
	const backups = new Map<string, FileBackup>();
	for (const file of beforeFiles.files) {
		const backup = backupFile(cwd, file);
		if (backup) backups.set(file, backup);
	}
	return {
		before,
		restoreIfChanged(): ProjectWriteFenceResult {
			const after = createProjectSnapshot(cwd, excludedRoots);
			if (before.hash === after.hash) return { changed: false, before, after, restored: false };
			let error: string | undefined;
			try {
				const afterFiles = listProjectFiles(cwd, excludedRoots).files;
				const beforeSet = new Set(backups.keys());
				for (const file of afterFiles) {
					if (beforeSet.has(file)) continue;
					const absolutePath = path.resolve(cwd, file);
					if (isPathInside(path.resolve(cwd), absolutePath)) {
						fs.rmSync(absolutePath, { force: true, recursive: true });
						removeEmptyParents(cwd, file);
					}
				}
				for (const [file, backup] of backups) restoreFile(cwd, file, backup);
			} catch (restoreError) {
				error = restoreError instanceof Error ? restoreError.message : String(restoreError);
			}
			const restoredSnapshot = createProjectSnapshot(cwd, excludedRoots);
			return { changed: true, before, after, restored: restoredSnapshot.hash === before.hash, restoredSnapshot, error };
		},
	};
}
