import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pipeline from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { GitRecordStore } from "@melian-agent/state-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { doctor } from "../src/doctor.ts";

const scratch: string[] = [];
let repo: string;
let home: string;
let committed: string;
let local: string;

function directory(prefix: string): string {
	const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	scratch.push(path);
	return path;
}

// The committed melian.yaml routes a lens to one model; a preference file routes it to another, as the host finisher's
// melian.local.yaml did on pull request #532, whose review read the base and ran the committed model.
beforeEach(() => {
	vi.spyOn(pipeline.Probe, "availability").mockResolvedValue({ available: true });
	vi.spyOn(pipeline.Probe, "gitAvailability").mockResolvedValue({ available: true });
	vi.spyOn(GitRecordStore.prototype, "strays").mockResolvedValue([]);
	const fake = createFakeModels({ models: [{ id: "finder" }, { id: "claude" }] });
	vi.spyOn(pipeline, "createReviewModels").mockReturnValue(fake.review);
	committed = `${fake.ref("finder").provider}/finder`;
	local = `${fake.ref("claude").provider}/claude`;
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = directory("melian-doctor-preferences-");
	home = directory("melian-doctor-preferences-home-");
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFileSync(join(repo, "melian.yaml"), `lenses:\n  correctness:\n    route: { model: ${committed} }\n`);
	gitIn(repo, "add", "melian.yaml");
	gitIn(repo, "commit", "--quiet", "-m", "policy");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function plan(): Promise<string[]> {
	let stdout = "";
	const io: Io = {
		cwd: repo,
		env: { ...process.env, XDG_CONFIG_HOME: home, PI_CODING_AGENT_DIR: home },
		stdout: (text) => {
			stdout += text;
		},
		stderr: () => {},
		color: false,
	};
	await doctor(io);
	return stdout.split("\n").filter((line) => / {2}plan\s+/.test(line));
}

const ignored = (file: string, keys: string) =>
	new RegExp(
		`^warn {2}plan +${file.replaceAll(".", "\\.")} sets ${keys.replaceAll(".", "\\.")}, which a pull request's review ignores: it reads its policy and lenses from its base$`,
	);

describe("doctor's plan beside a preference a pull request's review ignores", { timeout: 60_000 }, () => {
	it("names melian.local.yaml and the key it sets", async () => {
		writeFileSync(join(repo, "melian.local.yaml"), `lenses:\n  correctness:\n    route: { model: ${local} }\n`);

		const lines = await plan();

		expect(lines.some((line) => line.includes(`correctness route: ${local}`))).toBe(true);
		expect(lines.filter((line) => line.includes("review ignores"))).toEqual([
			expect.stringMatching(ignored("melian.local.yaml", "lenses.correctness.route.model")),
		]);
	});

	it("names the user's preference file by its path, with every key it sets, after melian.local.yaml", async () => {
		writeFileSync(join(repo, "melian.local.yaml"), `models:\n  heavy:\n    model: ${local}\n`);
		mkdirSync(join(home, "melian"));
		const preferences = join(home, "melian", "config.yaml");
		writeFileSync(preferences, `lenses:\n  correctness:\n    route: { model: ${local}, thinking: high }\n`);

		const lines = await plan();

		expect(lines.filter((line) => line.includes("review ignores"))).toEqual([
			expect.stringMatching(ignored("melian.local.yaml", "models.heavy.model")),
			expect.stringMatching(
				ignored(preferences, "lenses.correctness.route.model, lenses.correctness.route.thinking"),
			),
		]);
	});

	it("leaves out output.emoji, which every review reads from the preference files for the terminal", async () => {
		writeFileSync(join(repo, "melian.local.yaml"), "output:\n  emoji: off\n");
		mkdirSync(join(home, "melian"));
		const preferences = join(home, "melian", "config.yaml");
		writeFileSync(preferences, `output:\n  emoji: on\nmodels:\n  heavy:\n    model: ${local}\n`);

		const lines = await plan();

		expect(lines.filter((line) => line.includes("review ignores"))).toEqual([
			expect.stringMatching(ignored(preferences, "models.heavy.model")),
		]);
	});

	it("leaves out an empty output too", async () => {
		writeFileSync(join(repo, "melian.local.yaml"), `output: {}\nmodels:\n  heavy:\n    model: ${local}\n`);

		const lines = await plan();

		expect(lines.filter((line) => line.includes("review ignores"))).toEqual([
			expect.stringMatching(ignored("melian.local.yaml", "models.heavy.model")),
		]);
	});

	it("warns of nothing when no preference file sets anything", async () => {
		const lines = await plan();

		expect(lines.some((line) => line.includes(`correctness route: ${committed}`))).toBe(true);
		expect(lines.some((line) => line.includes("review ignores"))).toBe(false);
	});
});
