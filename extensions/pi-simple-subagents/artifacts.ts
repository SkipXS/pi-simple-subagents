import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.ts";
import type { RoleName } from "./roles.ts";

export function runId(): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
	return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureRealDirectoryNoSymlinks(dir: string): void {
	const absolute = path.resolve(dir);
	const root = path.parse(absolute).root;
	let current = root;
	for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		if (fs.existsSync(current)) {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink()) throw new Error(`Refusing to use symlinked artifact directory component: ${current}`);
			if (!stat.isDirectory()) throw new Error(`Artifact directory component is not a directory: ${current}`);
		} else {
			fs.mkdirSync(current);
		}
	}
}

export function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveRunBaseDir(cwd: string, config: Config): string {
	const base = config.artifacts.baseDir || ".pi/agent-runs";
	const resolved = path.isAbsolute(base) ? path.resolve(base) : path.resolve(cwd, base);
	if (!config.artifacts.allowOutsideCwd && !isPathInside(path.resolve(cwd), resolved)) {
		throw new Error(`Artifact baseDir must stay inside the current project directory by default: ${resolved}. Set artifacts.allowOutsideCwd=true to opt in.`);
	}
	ensureRealDirectoryNoSymlinks(resolved);
	if (!config.artifacts.allowOutsideCwd) {
		const realCwd = fs.realpathSync.native(cwd);
		const realBase = fs.realpathSync.native(resolved);
		if (!isPathInside(realCwd, realBase)) {
			throw new Error(`Artifact baseDir resolves outside the current project directory through symlinks: ${resolved}.`);
		}
	}
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

function assertInsidePath(parent: string, child: string): void {
	const relative = path.relative(parent, child);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes parent directory: ${child}`);
}

function ensureSafeArtifactTarget(runDir: string, target: string): void {
	const absoluteRunDir = path.resolve(runDir);
	const absoluteTarget = path.resolve(target);
	assertInsidePath(absoluteRunDir, absoluteTarget);
	ensureDir(absoluteRunDir);
	const runDirStat = fs.lstatSync(absoluteRunDir);
	if (!runDirStat.isDirectory() || runDirStat.isSymbolicLink()) throw new Error(`Artifact run dir is not a real directory: ${absoluteRunDir}`);

	const relative = path.relative(absoluteRunDir, path.dirname(absoluteTarget));
	let current = absoluteRunDir;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		if (fs.existsSync(current)) {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink()) throw new Error(`Artifact path contains a symlink directory: ${current}`);
			if (!stat.isDirectory()) throw new Error(`Artifact path component is not a directory: ${current}`);
		} else {
			fs.mkdirSync(current);
		}
	}

	if (fs.existsSync(absoluteTarget) && fs.lstatSync(absoluteTarget).isSymbolicLink()) {
		throw new Error(`Refusing to write artifact through symlink: ${absoluteTarget}`);
	}
	const realRunDir = fs.realpathSync.native(absoluteRunDir);
	const realParent = fs.realpathSync.native(path.dirname(absoluteTarget));
	assertInsidePath(realRunDir, realParent);
}

export function writeArtifact(runDir: string, name: string, content: string): string {
	const target = resolveArtifactPath(runDir, name);
	ensureSafeArtifactTarget(runDir, target);
	fs.writeFileSync(target, content, "utf8");
	return target;
}

export function appendArtifactFile(runDir: string, target: string, content: string): void {
	ensureSafeArtifactTarget(runDir, target);
	fs.appendFileSync(target, content, "utf8");
}

export function copyArtifactFile(runDir: string, source: string, target: string): void {
	ensureSafeArtifactTarget(runDir, target);
	fs.copyFileSync(source, target);
}

export function uniqueSuffix(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveRoleSessionFile(runDir: string, role: RoleName): string {
	const fileName = role === "worker" || role === "orchestrator" ? `sessions/${role}.jsonl` : `sessions/${role}-${uniqueSuffix()}.jsonl`;
	const sessionFile = resolveArtifactPath(runDir, fileName);
	ensureSafeArtifactTarget(runDir, sessionFile);
	return sessionFile;
}
