import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultConfig } from "@melian-agent/core";
import {
	backgroundContext as context,
	createNodeExecutionEnv,
	runStaticTool,
	type StaticRunInput,
} from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Run } from "../src/static.ts";
import { commit, createRepository, fakeTool, gitIn, lines, removeRepository } from "./fixtures/repo.ts";
import { unconfinedNotes } from "./fixtures/sandbox.ts";
import { RunV1, removeStaleWorktreesV1 } from "./fixtures/stale-worktrees-v1.ts";

// Reviews from several worktrees of one clone run at once, each from its own build, and every one starts by cleaning up
// stale worktrees across the whole clone. These tests run the build before this one against this one's registrations,
// and this one against the old build's.

let repo: string;
let head: string;
const made: string[] = [];

beforeEach(() => {
	repo = createRepository();
	head = commit(repo, { ".gitignore": lines("node_modules"), "src/a.ts": lines("export const a = 1;") });
});

afterEach(() => {
	for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
	removeRepository(repo);
});

function input(): StaticRunInput {
	return {
		env: createNodeExecutionEnv(repo),
		repoRoot: repo,
		commit: head,
		tool: "biome",
		settings: defaultConfig.static.biome,
	};
}

function staticTrees(): string[] {
	return gitIn(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((line) => /^worktree .*\/melian-static-[^/]+\/tree$/.test(line))
		.map((line) => line.slice("worktree ".length));
}

it("a build from before this one leaves this build's live run alone, and the run finishes", {
	timeout: 60_000,
}, async () => {
	// A fake Biome that writes a file beside its report and waits there until the test lets it go. It gives up by itself
	// after thirty seconds: when the old build does delete the scratch, nothing can release it, and it must not run on.
	fakeTool(
		repo,
		"biome",
		[
			'if [ "$1" = "--version" ]; then echo 0.0.0; exit 0; fi',
			'for arg in "$@"; do case "$arg" in --reporter-file=*) out=$(printf %s "$arg" | cut -d= -f2-);; esac; done',
			'echo started > "$(dirname "$out")/started"',
			"waited=0",
			'while [ ! -f "$(dirname "$out")/release" ]; do sleep 0.05; waited=$((waited + 1)); [ "$waited" -lt 600 ] || exit 9; done',
			`printf '%s' '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"Biome"}},"results":[]}]}' > "$out"`,
		].join("\n"),
	);
	const running = runStaticTool(input(), context);
	// Settled before the test ends whatever an assertion below throws, so no run is left behind it.
	const settled = running.catch(() => undefined);
	let scratch = "";
	for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(20)) {
		const [tree] = staticTrees();
		if (tree !== undefined && existsSync(join(dirname(tree), "started"))) {
			scratch = dirname(tree);
			break;
		}
	}
	expect(scratch).not.toBe("");
	try {
		const old = mkdtempSync(join(tmpdir(), "melian-old-build-"));
		made.push(old);
		await removeStaleWorktreesV1(new RunV1(input(), context), old);
		expect(staticTrees()).toEqual([join(scratch, "tree")]);
		expect(readFileSync(join(scratch, "tree/src/a.ts"), "utf8")).toBe(lines("export const a = 1;"));
		expect(readFileSync(join(scratch, "started"), "utf8")).toBe("started\n");
	} finally {
		if (scratch !== "" && existsSync(scratch)) writeFileSync(join(scratch, "release"), "");
		await settled;
	}
	expect(await running).toMatchObject({ status: "ran", notes: unconfinedNotes("biome") });
	expect(staticTrees()).toEqual([]);
});

it("this build leaves the old build's live run alone, and removes its dead one", { timeout: 60_000 }, async () => {
	// A dead run of the old form: the exact lock, a process that is gone, and no marker.
	const dead = join(dirname(repo), `melian-static-oldcrash-${process.pid}`);
	made.push(dead);
	mkdirSync(dead);
	gitIn(
		repo,
		"worktree",
		"add",
		"--quiet",
		"--detach",
		"--lock",
		"--reason",
		"melian-static pid 2147483646",
		join(dead, "tree"),
	);
	let release = () => {};
	const parked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let live = "";
	const oldRun = new RunV1(input(), context).inWorktree(async (root) => {
		live = root;
		await parked;
		return readFileSync(join(root, "src/a.ts"), "utf8");
	});
	try {
		for (const deadline = Date.now() + 30_000; live === "" && Date.now() < deadline; ) await sleep(20);
		expect(live).not.toBe("");
		expect(await new Run(input(), context).inWorktree(async () => "ran")).toBe("ran");
		expect(staticTrees()).toEqual([live]);
		expect(existsSync(dead)).toBe(false);
		expect(existsSync(join(live, "src/a.ts"))).toBe(true);
	} finally {
		release();
		await oldRun.catch(() => undefined);
	}
	expect(await oldRun).toBe(lines("export const a = 1;"));
	expect(staticTrees()).toEqual([]);
});
