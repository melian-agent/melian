import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens, type MelianConfig } from "@melian-agent/core";
import { ChangeLenses } from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, writeFiles } from "./fixtures/repo.ts";

const skipFloor = "lenses:\n  correctness:\n    level: { floor: skip }\n";
const config: MelianConfig = {
	...defaultConfig,
	tiers: { ...defaultConfig.tiers, full: ["guardrails", "lens.correctness", "lens.contracts"] },
	lenses: { contracts: { paths: ["docs/**"] } },
};

let repo: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-change-lenses-")));
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, { "src/old/melian.yaml": skipFloor, "src/old/user.ts": "export const user = 1;\n" });
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", "base");
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	gitIn(repo, "mv", "src/old/user.ts", "src/user.ts");
	gitIn(repo, "commit", "--quiet", "-m", "head");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

async function read(options: { policy?: boolean; tier?: string; settings?: Partial<MelianConfig> } = {}) {
	const changeset = await Changeset.resolve(repo, "main...feature");
	const policy = { kind: "revision", commit: changeset.revision.base } as const;
	return ChangeLenses.read({
		changeset,
		lenses: await Lens.load(repo, policy, changeset.revision.paths()),
		config: { ...config, ...options.settings },
		tier: options.tier ?? "full",
		...(options.policy === false ? {} : { policy }),
		floor: "quick",
	});
}

describe("ChangeLenses", () => {
	it("gives TierAccount every loaded lens and each selected one's covered paths and band", async () => {
		const lenses = await read();

		expect(lenses.tierLenses()).toEqual({
			loaded: lenses.loaded.map((lens) => lens.name),
			selected: [
				{
					name: "correctness",
					covers: ["src/old/user.ts", "src/user.ts"],
					band: expect.objectContaining({ floor: "quick" }),
				},
			],
		});
		expect(lenses.loaded.map((lens) => lens.name)).toContain("contracts");
	});

	it("selects only the tier's lenses", async () => {
		const lenses = await read({ settings: { tiers: { ...config.tiers, quick: ["guardrails"] } }, tier: "quick" });

		expect(lenses.tierLenses().selected).toEqual([]);
	});

	it("reads each band from the configuration it is handed when no policy names the files", async () => {
		const lenses = await read({
			policy: false,
			settings: { lenses: { ...config.lenses, correctness: { level: { floor: "skip" } } } },
		});

		expect(lenses.tierLenses().selected.map(({ band }) => band.floor)).toEqual(["skip"]);
	});

	it("refuses the band of a lens it did not select", async () => {
		const lenses = await read();
		const contracts = lenses.loaded.find((lens) => lens.name === "contracts")!;

		expect(() => lenses.band(contracts)).toThrow(new RangeError("lens contracts is not selected for the change"));
	});
});
