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

function createGitProjectSnapshot(cwd: string, excludedRoots: string[] = []): ProjectSnapshot | undefined {
	const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"])?.toString("utf8").trim();
	if (inside !== "true") return undefined;
	const output = runGit(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	if (!output) return undefined;
	const excluded = excludedRoots.map((root) => path.resolve(root));
	const files = output.toString("utf8").split("\0").filter(Boolean).filter((file) => {
		const absolutePath = path.resolve(cwd, file);
		return !excluded.some((root) => isPathInside(root, absolutePath));
	}).sort();
	const hash = createHash("sha256");
	hash.update("git\0");
	let fileCount = 0;
	for (const file of files) if (hashPathEntry(hash, cwd, file)) fileCount++;
	return { kind: "git", hash: hash.digest("hex"), fileCount };
}

function createFilesystemProjectSnapshot(cwd: string, excludedRoots: string[] = []): ProjectSnapshot {
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
	files.sort();
	const hash = createHash("sha256");
	hash.update("filesystem\0");
	let fileCount = 0;
	for (const file of files) if (hashPathEntry(hash, cwd, file)) fileCount++;
	return { kind: "filesystem", hash: hash.digest("hex"), fileCount };
}

export function createProjectSnapshot(cwd: string, excludedRoots: string[] = []): ProjectSnapshot {
	return createGitProjectSnapshot(cwd, excludedRoots) ?? createFilesystemProjectSnapshot(cwd, excludedRoots);
}
