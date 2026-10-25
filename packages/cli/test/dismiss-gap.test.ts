import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseAndHead, gitIn, isolatedGitEnv, writeFiles } from "../../pipeline/test/fixtures/repo.ts";
import { main } from "../src/main.ts";

const big = (label: string) =>
	Array.from({ length: 6000 }, (_, index) => `export const ${label}${index} = "${"x".repeat(30)}";\n`).join("");

let repo: string;
let dir: string;
let io: {
	cwd: string;
	color: false;
	env: Record<string, string>;
	stdout: ReturnType<typeof vi.fn<(text: string) => void>>;
	stderr: ReturnType<typeof vi.fn<(text: string) => void>>;
};

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead(
		{
			"melian.yaml": "tiers:\n  full: [lens.correctness]\n",
			"src/big.ts": big("old"),
			"src/a.ts": "export const a = 1;\n",
		},
		{ "src/big.ts": big("new"), "src/a.ts": "export const a = 2;\n" },
	);
	dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-dismiss-gap-")));
	const script = join(dir, "script.json");
	writeFileSync(script, JSON.stringify({ correctness: [{ text: "Reported 0 findings." }] }));
	io = {
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
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
});

const out = () => io.stdout.mock.calls.join("");
const err = () => io.stderr.mock.calls.join("");
const gap = (...more: string[]) =>
	main(["dismiss-gap", "main...feature", "--check", "lens.correctness", "--file", "src/big.ts", ...more], io);
const review = () => main(["review", "main...feature", "--trust-head", "--no-walkthrough"], io);

describe("melian dismiss-gap", () => {
	it("says the review has not run before there is one to dismiss in", async () => {
		expect(await gap("--lines", "1", "--reason", "generated")).toBe(1);
		expect(err()).toContain("no review");
	});

	it("dismisses the named lines on each side, as ranges with spaces, and then the review passes", async () => {
		expect(await review()).toBe(2);
		io.stdout.mockClear();
		expect(await gap("--lines", "1-3000, 3001-5999,6000", "--reason", "generated")).toBe(0);
		expect(out()).toMatch(
			/^Dismissed the lens\.correctness gap at src\/big\.ts lines 1-3000, 3001-5999,6000 as .+\. Run melian review main\.\.\.feature again to decide the verdict with it\.\n$/,
		);
		io.stdout.mockClear();
		expect(await gap("--lines", "1-6000", "--side", "base", "--reason", "generated")).toBe(0);
		expect(out()).toContain("gap at src/big.ts (base) lines 1-6000 as ");
		expect(await review()).toBe(0);
	});

	it("refuses lines the review names no gap at, on the side named, and bad line lists", async () => {
		expect(await review()).toBe(2);
		expect(await gap("--lines", "6001", "--reason", "generated")).toBe(1);
		expect(err()).toContain("the review names no gap for lens.correctness at those lines of src/big.ts");
		io.stderr.mockClear();
		expect(await gap("--lines", "5", "--side", "head", "--reason", "generated")).toBe(0);
		for (const lines of ["0", "3-", "a", "2-x", "3 4"]) {
			io.stderr.mockClear();
			expect(await gap("--lines", lines, "--reason", "generated")).toBe(1);
			expect(err()).toContain(`--lines takes lines such as 3, 3-5 or 3-5,9, not ${lines}`);
		}
	});

	it.each([
		[
			["--file", "src/big.ts", "--lines", "1", "--reason", "r"],
			"dismiss-gap needs --check <name>, --file <path> and --lines <lines>",
		],
		[
			["--check", "lens.correctness", "--lines", "1", "--reason", "r"],
			"dismiss-gap needs --check <name>, --file <path> and --lines <lines>",
		],
		[
			["--check", "lens.correctness", "--file", "src/big.ts", "--reason", "r"],
			"dismiss-gap needs --check <name>, --file <path> and --lines <lines>",
		],
		[
			["--check", "lens.correctness", "--file", "src/big.ts", "--lines", "1", "--side", "left", "--reason", "r"],
			"--side takes head or base",
		],
		[["--check", "lens.correctness", "--file", "src/big.ts", "--lines", "1"], "dismiss-gap needs --reason <text>"],
	])("refuses %j as usage", async (options, message) => {
		expect(await main(["dismiss-gap", "main...feature", ...options], io)).toBe(64);
		expect(err()).toContain(message);
	});
});

describe("melian review --cold", () => {
	it("covers the diff from its own round alone, carrying nothing", async () => {
		writeFiles(repo, {
			"src/big.ts": big("old"),
			"src/c.ts": Array.from({ length: 20 }, (_, index) => `export const c${index} = ${index};\n`).join(""),
		});
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "--all", "-m", "small");
		expect(await review()).toBe(0);
		writeFiles(repo, { "src/a.ts": "export const a = 3;\n" });
		gitIn(repo, "commit", "--quiet", "--all", "-m", "again");
		const coverage = async (cold: boolean) => {
			io.stdout.mockClear();
			await main(["review", "main...feature", "--trust-head", "--no-walkthrough", ...(cold ? ["--cold"] : [])], io);
			io.stdout.mockClear();
			await main(["findings", "main...feature", "--json"], io);
			return (JSON.parse(out()) as { coverage: { rounds: string[] } }).coverage.rounds;
		};
		expect(await coverage(false)).toEqual(["r1", "r2"]);
		writeFiles(repo, { "src/a.ts": "export const a = 4;\n" });
		gitIn(repo, "commit", "--quiet", "--all", "-m", "cold");
		expect(await coverage(true)).toEqual(["r3"]);
	});
});
