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

function bufferFromSpawnStdout(value: string | Buffer): Buffer {
	return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function runGit(cwd: string, args: string[]): Buffer | undefined {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
	if (result.status !== 0 || result.error) return undefined;
	return bufferFromSpawnStdout(result.stdout as string | Buffer);
}

function hashPathEntry(hash: ReturnType<typeof createHash>, cwd: string, relativePath: string): boolean {
	const absolutePath = path.resolve(cwd, relativePath);
	if (!isPathInside(path.resolve(cwd), absolutePath) || !fs.existsSync(absolutePath)) return false;
	const stat = fs.lstatSync(absolutePath);
	hash.update(relativePath);
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
	const excluded = excludedRoots.map((root) => path.resolve(root));
	return output.toString("utf8").split("\0").filter(Boolean).filter((file) => {
		const absolutePath = path.resolve(cwd, file);
		return !excluded.some((root) => isPathInside(root, absolutePath));
	}).sort();
}

function listFilesystemProjectFiles(cwd: string, excludedRoots: string[] = []): string[] {
	const excludedNames = new Set([".git", ".pi", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache"]);
	const excluded = excludedRoots.map((root) => path.resolve(root));
	const files: string[] = [];
	const walk = (dir: string) => {
		if (excluded.some((root) => isPathInside(root, path.resolve(dir)))) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (excludedNames.has(entry.name)) continue;
			const absolutePath = path.join(dir, entry.name);
			const relativePath = path.relative(cwd, absolutePath);
			if (entry.isDirectory()) walk(absolutePath);
			else if (entry.isFile() || entry.isSymbolicLink()) files.push(relativePath);
		}
	};
	walk(cwd);
	return files.sort();
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
