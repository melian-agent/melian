import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { baseAndHead } from "../../pipeline/test/fixtures/repo.ts";
import { main } from "../src/main.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("mints for a CLI cold run with identical check records, then attaches to that cold run", async () => {
	// A docs-only change exercises real check identities without starting Stryker.
	const repo = baseAndHead(
		{
			"melian.yaml":
				"tiers:\n  full: [static.mutation]\nstatic:\n  mutation:\n    enabled: true\n  enola:\n    enabled: false\n",
			"README.md": "Before\n",
		},
		{ "README.md": "After\n" },
	);
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-cli-cold-")));
	scratch.push(repo, dir);
	const script = join(dir, "script.json");
	writeFileSync(script, "{}");
	const io = {
		cwd: repo,
		color: false,
		env: {
			MELIAN_TEST_SCRIPT: script,
			MELIAN_STATE_DIR: join(dir, "state"),
			XDG_CONFIG_HOME: join(dir, "config"),
			PI_CODING_AGENT_DIR: join(dir, "pi"),
		},
		stdout: vi.fn<(text: string) => void>(),
		stderr: vi.fn<(text: string) => void>(),
	};
	const command = ["review", "main...feature", "--trust-head", "--no-walkthrough"];
	expect(await main(command, io)).toBe(0);
	expect(await main([...command, "--cold"], io)).toBe(0);
	expect(await main([...command, "--cold"], io)).toBe(0);
	io.stdout.mockClear();
	expect(await main(["findings", "main...feature", "--rounds", "--json"], io)).toBe(0);
	const rounds = JSON.parse(io.stdout.mock.calls.join("")) as { id: string }[];
	expect(rounds.map((round) => round.id.split(".").at(-1))).toEqual(["r1", "r2"]);
}, 60_000);
