import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type StoredVerdict, visibleText } from "@melian-agent/core";
import { buildGoldenRepository, loadGoldens } from "@melian-agent/evals";
import type { EvidencePointer, EvidenceStage } from "@melian-agent/pipeline";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = join(root, "packages/cli/bin/melian.js");
const golden = loadGoldens().find((each) => each.name === "correctness-null-deref")!;
const range = "main...feature";
const lensDirectory = ".melian/lenses/correctness";
const lensFile = `${lensDirectory}/LENS.md`;
// Every character visible text escapes, but the line feed that ends each printed line.
const unsafe = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const gitEnv = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_COUNT: "0",
	GIT_AUTHOR_NAME: "Melian Test",
	GIT_AUTHOR_EMAIL: "test@melian.invalid",
	GIT_COMMITTER_NAME: "Melian Test",
	GIT_COMMITTER_EMAIL: "test@melian.invalid",
};

const cleanup: string[] = [];

afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function melian(cwd: string, args: string[], env: Record<string, string>) {
	const result = spawnSync(process.execPath, [bin, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...gitEnv, NO_COLOR: "1", ...env },
		timeout: 60_000,
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// The null-dereference golden reviewed on its feature branch, with Codex's findings imported against the review.
// With `committedLens`, the policy and a repository `correctness` lens are committed on main, which feature merges, and
// main is checked out again, so the range reads its policy from the base commit, as `revision:<sha>`.
function compared(lines: readonly number[], committedLens = false) {
	const { repo } = buildGoldenRepository(golden);
	cleanup.push(repo);
	if (committedLens) {
		const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, ...gitEnv } });
		run("checkout", "--quiet", "main");
		writeFileSync(join(repo, "melian.yaml"), "tiers:\n  fast: [guardrails]\n");
		mkdirSync(join(repo, lensDirectory), { recursive: true });
		writeFileSync(join(repo, lensFile), "---\nname: correctness\nextends: correctness\n---\n");
		run("add", "--all");
		run("commit", "--quiet", "-m", "policy");
		run("checkout", "--quiet", "feature");
		run("merge", "--quiet", "--no-edit", "main");
		run("checkout", "--quiet", "main");
	} else writeFileSync(join(repo, "melian.yaml"), "tiers:\n  fast: [guardrails]\n");
	const files = realpathSync(mkdtempSync(join(tmpdir(), "melian-evidence-cli-")));
	cleanup.push(files);
	const script = join(files, "script.json");
	writeFileSync(script, JSON.stringify(golden.script));
	const env = { MELIAN_TEST_SCRIPT: script };
	expect(melian(repo, ["review", range], env).status).toBe(1);
	const verdict = JSON.parse(melian(repo, ["findings", range, "--json"], env).stdout) as StoredVerdict;
	const codex = join(files, "codex.json");
	const findings = lines.map((line) => ({
		severity: "high",
		title: `Line ${line}`,
		body: "In detail.",
		file: "src/user.ts",
		line_start: line,
		line_end: line,
		confidence: 0.9,
		recommendation: "",
	}));
	writeFileSync(codex, JSON.stringify({ verdict: "needs-attention", summary: "s", findings, next_steps: [] }));
	const imported = melian(repo, ["compare", range, "--from", `file:${codex}`], env);
	expect(imported.status).toBe(0);
	const external = (line: number) =>
		new RegExp(`^ {2,4}([0-9a-f]{16}) {2}codex {2}src/user\\.ts:${line}\\b`, "m").exec(imported.stdout)![1]!;
	const evidence = join(repo, ".git", "melian", "scripted", "evidence");
	return { repo, env, codex, melianId: verdict.findings.block[0]!.properties.id, external, evidence };
}

const valid = (id: string) => ["compare", "adjudicate", range, id, "--verdict", "valid", "--reason", "owned-missed"];

function stored(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((each) => each.isFile())
		.map((each) => join(each.parentPath, each.name).slice(directory.length + 1))
		.sort();
}

describe("melian compare evidence", { timeout: 120_000 }, () => {
	it("keeps each covering lens run once for two misses, and prints them visibly from a later process", () => {
		const { repo, env, external, evidence } = compared([30, 1]);
		const first = melian(repo, valid(external(30)), env);
		expect(first).toMatchObject({ status: 0, stderr: "" });
		expect(first.stdout).toContain(`Kept evidence for ${external(30)}: 6 conversations, 6 newly written, at `);
		const second = melian(repo, valid(external(1)), env);
		expect(second.stdout).toContain(`Kept evidence for ${external(1)}: 6 conversations, 0 newly written, at `);
		const round = readdirSync(evidence)[0]!;
		expect(stored(join(evidence, round, "r1", "misses"))).toEqual(
			[external(30), external(1)].map((id) => `${id}.json`).sort(),
		);
		expect(stored(join(evidence, round, "r1", "stages"))).toHaveLength(6);

		const printed = melian(repo, ["compare", "evidence", range, external(30)], env);

		expect(printed).toMatchObject({ status: 0, stderr: "" });
		const lines = printed.stdout.split("\n");
		expect(lines[0]).toMatch(
			new RegExp(
				`^Evidence for ${external(30)} in round ${round}\\.r1: base [0-9a-f]{12}, head [0-9a-f]{12}, policy worktree\\.$`,
			),
		);
		expect(lines.filter((line) => line.startsWith("melian."))).toEqual(
			["contracts", "conventions", "correctness", "removed-behaviour", "tests", "trust-boundary"].map((lens) =>
				expect.stringMatching(new RegExp(`^melian\\.lens ${lens}@[0-9a-f]{12}@careful, conversation \\d+:$`)),
			),
		);
		expect(printed.stdout).toContain("Review the change from");
		expect(printed.stdout).toContain('"name":"read_file"');
		// The golden's source is indented with tabs, which print as visible escapes.
		expect(printed.stdout).toContain("1\\u0009export interface User {");
		expect(printed.stdout).not.toMatch(unsafe);

		const json = melian(repo, ["compare", "evidence", range, external(30), "--json"], env);
		const read = JSON.parse(json.stdout) as { pointer: EvidencePointer; stages: EvidenceStage[] };
		expect(read.pointer).toMatchObject({ round: `${round}.r1`, external: external(30), policy: "worktree" });
		expect(read.stages.map(({ stage }) => stage.id)).toEqual(read.pointer.stages);
		expect(read.stages.every(({ entries, dropped }) => entries.length > 0 && dropped === 0)).toBe(true);
		// A lens's system entry holds its prompt in sections, with empty content, so the text view prints the sections.
		const systems = read.stages.map(({ entries }) => entries.find((entry) => entry.kind === "pi.system")!);
		expect(systems).toHaveLength(6);
		for (const system of systems) {
			const [message] = system.model ?? [];
			if (message?.role !== "system") throw new Error("a pi.system entry holds a system message");
			expect(message.content).toBe("");
			const sections = Object.values(message.sections ?? {}) as string[];
			expect(sections.join("\n")).toContain("<injection_policy>");
			const shown = sections.flatMap((text) => text.split("\n").map((line) => `    ${visibleText(line)}`));
			const tools = message.toolsAdded ?? [];
			expect(tools.map((tool) => tool.name)).toContain("read_file");
			expect(printed.stdout).toContain(
				`  system:\n${[...shown, `    tools added: ${tools.map((tool) => tool.name).join(", ")}`].join("\n")}\n`,
			);
		}
	});

	it("keeps the verifier that judged a lens sighting on the miss's lines, and only for such a miss", () => {
		const { repo, env, external, melianId } = compared([8, 30]);
		expect(melian(repo, ["compare", "unmatch", range, external(8), melianId], env).status).toBe(0);
		expect(melian(repo, valid(external(8)), env).stdout).toContain("7 conversations");
		expect(melian(repo, valid(external(30)), env).stdout).toContain("6 conversations");

		const near = melian(repo, ["compare", "evidence", range, external(8)], env).stdout;
		const far = melian(repo, ["compare", "evidence", range, external(30)], env).stdout;

		expect(near).toMatch(new RegExp(`^melian\\.verification\\.candidate ${melianId}, conversation \\d+:$`, "m"));
		expect(far).not.toContain("melian.verification.candidate");
	});

	it("keeps no evidence for a round whose run this clone no longer holds, and says a rerun is a new conversation", () => {
		const { repo, env, codex, external, evidence } = compared([30]);
		writeFileSync(join(repo, "melian.yaml"), "tiers:\n  fast: [guardrails]\nresolution:\n  nit: advisory\n");
		const again = melian(repo, ["review", range], env);
		expect(again, again.stderr).toMatchObject({ status: 1 });
		const round = `${readdirSync(join(repo, ".git", "melian", "scripted"))
			.find((name) => name.endsWith(".sqlite"))!
			.slice(0, -".sqlite".length)}.r1`;
		expect(melian(repo, ["compare", range, "--round", round, "--from", `file:${codex}`], env).status).toBe(0);

		const kept = melian(repo, [...valid(external(30)), "--round", round], env);

		expect(kept).toMatchObject({ status: 0, stderr: "" });
		const head = execFileSync("git", ["rev-parse", "feature"], { cwd: repo, encoding: "utf8" }).trim();
		expect(kept.stdout).toContain(
			`Kept no evidence for ${external(30)}: this clone holds no record of its round's run. An Actions round's records went with its job, and rerunning ${head.slice(0, 12)} on a host gives a new conversation, not the original.`,
		);
		expect(stored(evidence)).toEqual([]);
		expect(melian(repo, ["compare", "evidence", range, external(30), "--round", round], env)).toMatchObject({
			status: 1,
			stderr: expect.stringContaining(`Melian kept no evidence for ${external(30)} in round ${round}`),
		});
	});

	it("records the adjudication but keeps no evidence past the budget, naming the directory and prune", () => {
		const { repo, env, external, evidence } = compared([30]);
		writeFileSync(join(repo, "melian.local.yaml"), "evidence:\n  budget: 1KiB\n");

		const refused = melian(repo, valid(external(30)), env);

		expect(refused.status).toBe(1);
		expect(refused.stdout).toContain(`Adjudicated ${external(30)} as valid`);
		expect(refused.stderr).toContain("the adjudication is recorded, but no evidence was kept");
		expect(refused.stderr).toMatch(new RegExp(`${evidence.replaceAll(".", "\\.")}/range-[0-9a-f]+/ `));
		expect(refused.stderr).toContain("melian store prune keeps evidence, and lists what is more than 90 days old");
		expect(refused.stderr).toContain("Raise evidence.budget in your configuration until issue #633");
		expect(refused.stderr).toContain("This refusal wrote no file and lost no evidence already kept");
		expect(refused.stderr).not.toContain("by hand");
		expect(stored(evidence)).toEqual([]);
	});

	it("prints the evidence directory's size against its budget in doctor", () => {
		const { repo, env, external, evidence } = compared([30]);
		const line = (output: string) => output.split("\n").find((each) => /^\S+\s+evidence\s/.test(each));
		expect(line(melian(repo, ["doctor"], env).stdout)).toMatch(
			new RegExp(`^ok {4}evidence +${evidence.replaceAll(".", "\\.")}, 0 B of its budget of 1\\.0 GiB$`),
		);
		expect(melian(repo, valid(external(30)), env).status).toBe(0);
		writeFileSync(join(repo, "melian.local.yaml"), "evidence:\n  budget: 1KiB\n");

		const full = line(melian(repo, ["doctor"], env).stdout);

		expect(full).toMatch(
			new RegExp(
				`^warn {2}evidence +${evidence.replaceAll(".", "\\.")}, [0-9.]+ KiB of its budget of 1\\.0 KiB; a valid miss keeps no more evidence until evidence\\.budget is raised in your configuration, since melian store prune keeps evidence until issue #633 lands$`,
			),
		);
	});

	it("records the blob of a repository lens at the policy commit, and no other lens", () => {
		const { repo, env, external } = compared([30], true);
		const kept = melian(repo, valid(external(30)), env);
		expect(kept).toMatchObject({ status: 0, stderr: "" });
		const policy = execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim();
		const blob = execFileSync("git", ["rev-parse", `${policy}:${lensFile}`], { cwd: repo, encoding: "utf8" }).trim();

		const json = melian(repo, ["compare", "evidence", range, external(30), "--json"], env);

		const { pointer } = JSON.parse(json.stdout) as { pointer: EvidencePointer };
		expect(pointer.policy).toBe(`revision:${policy}`);
		expect(pointer.lensFiles).toEqual([
			{ lens: expect.stringMatching(/^correctness@[0-9a-f]{12}$/), file: lensFile, blob },
		]);
	});

	it("says the adjudication is recorded when the evidence directory cannot be read", () => {
		const { repo, env, external, evidence } = compared([30]);
		writeFileSync(evidence, "not a directory");
		const kept = melian(repo, valid(external(30)), env);
		expect(kept.status).toBe(1);
		expect(kept.stdout).toContain(`Adjudicated ${external(30)}`);
		expect(kept.stderr).toMatch(/^melian: the adjudication is recorded, but no evidence was kept: .*ENOTDIR/);
	});

	it("keeps nothing for an unmatched external finding judged noise", () => {
		const { repo, env, external, evidence } = compared([30]);
		const noise = melian(repo, ["compare", "adjudicate", range, external(30), "--verdict", "noise"], env);
		expect(noise).toMatchObject({ status: 0, stderr: "" });
		expect(noise.stdout).not.toContain("evidence");
		expect(stored(evidence)).toEqual([]);
	});

	it("keeps nothing for a valid Melian finding or a match, which are not misses", () => {
		const { repo, env, external, melianId, evidence } = compared([8]);
		expect(melian(repo, valid(external(8)), env).stdout).not.toContain("evidence");
		expect(melian(repo, ["compare", "adjudicate", range, melianId, "--verdict", "valid"], env).stdout).not.toContain(
			"evidence",
		);
		expect(stored(evidence)).toEqual([]);
	});

	it("keeps nothing for a miss judged a duplicate of another", () => {
		const { repo, env, external, evidence } = compared([30, 1]);
		const duplicate = melian(
			repo,
			["compare", "adjudicate", range, external(1), "--verdict", "duplicate", "--of", external(30)],
			env,
		);
		expect(duplicate).toMatchObject({ status: 0, stderr: "" });
		expect(duplicate.stdout).not.toContain("evidence");
		expect(stored(evidence)).toEqual([]);
	});

	it("records no lens file for a valid miss with no file, though the policy is a committed revision", () => {
		const { repo, env, evidence } = compared([30], true);
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-evidence-nofile-")));
		cleanup.push(directory);
		const other = join(directory, "other.json");
		writeFileSync(
			other,
			JSON.stringify({ reviewer: { name: "claude-code" }, findings: [{ title: "No file", body: "Nowhere." }] }),
		);
		const imported = melian(repo, ["compare", range, "--from", `file:${other}`], env);
		expect(imported, imported.stderr).toMatchObject({ status: 0 });
		const id = /^ {2,4}([0-9a-f]{16}) {2}claude-code /m.exec(imported.stdout)![1]!;
		expect(melian(repo, valid(id), env)).toMatchObject({ status: 0, stderr: "" });

		const json = melian(repo, ["compare", "evidence", range, id, "--json"], env);

		const { pointer } = JSON.parse(json.stdout) as { pointer: EvidencePointer };
		expect(pointer.policy).toMatch(/^revision:[0-9a-f]{40}$/);
		expect(pointer.lensFiles).toEqual([]);
		expect(stored(evidence)).not.toEqual([]);
	});
});
