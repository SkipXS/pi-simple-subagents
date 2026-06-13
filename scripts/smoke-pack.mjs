#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const piCli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
		encoding: "utf8",
		shell: false,
		...options,
	});
	if (result.status !== 0) {
		const rendered = [command, ...args].join(" ");
		const detail = result.error ? `: ${result.error.message}` : "";
		throw new Error(`${rendered} failed with exit code ${result.status ?? "unknown"}${detail}`);
	}
	return result.stdout ?? "";
}

function runNpm(args, options = {}) {
	if (npmCli) return run(process.execPath, [npmCli, ...args], options);
	return run(npmCommand, args, { ...options, shell: process.platform === "win32" });
}

let tarball;
let tempDir;
try {
	tarball = runNpm(["pack", "--ignore-scripts", "--silent"], { capture: true }).trim().split(/\r?\n/).filter(Boolean).at(-1);
	if (!tarball) throw new Error("npm pack did not report a tarball path");
	const tarballPath = join(root, tarball);
	tempDir = mkdtempSync(join(tmpdir(), "pi-simple-subagents-smoke-"));
	const installPrefix = join(tempDir, "install");
	runNpm(["install", "--prefix", installPrefix, tarballPath, "--ignore-scripts", "--legacy-peer-deps"]);
	const pkgDir = join(installPrefix, "node_modules", "pi-simple-subagents");
	if (!existsSync(pkgDir)) throw new Error(`Packed package was not installed at ${pkgDir}`);
	if (!existsSync(piCli)) throw new Error(`Pi CLI entrypoint not found at ${piCli}; run npm ci first`);
	run(process.execPath, [piCli, "-e", pkgDir, "--list-models", "pi-simple-subagents-smoke-no-model"]);
} finally {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	if (tarball) rmSync(join(root, tarball), { force: true });
}
