import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adjudication, defaultConfig, Finding, Lens } from "@melian-agent/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { baseAndHead } from "../../pipeline/test/fixtures/repo.ts";
import { ReviewOutcome } from "../src/commands.ts";
import { main } from "../src/main.ts";

const policy = [
	"tiers:",
	"  full: [guardrails]",
	"guardrails:",
	"  forbidden-paths:",
	"    rules:",
	"      no-secrets:",
	"        paths: [secrets/**]",
	"        message: keys never live in the repository",
	"",
].join("\n");

const red = "\u{1F7E0} P1 | \u{26D4} Blocks merge | \u{1F6A6} Guardrails: forbidden-paths | New in this change";
const words = "  P1 | Blocks merge | Guardrails: forbidden-paths | New in this change";

describe("output.emoji in the terminal", { timeout: 60_000 }, () => {
	let repo: string;
	let dir: string;

	beforeAll(async () => {
		repo = baseAndHead({ "melian.yaml": policy, "README.md": "Before\n" }, { "secrets/key.pem": "key\n" });
		dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-cli-emoji-")));
		const script = join(dir, "script.json");
		writeFileSync(script, "{}");
		expect(await main(["review", "main...feature", "--no-walkthrough"], io({}))).toBe(1);
	});

	afterAll(() => {
		rmSync(repo, { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	});

	function io(env: NodeJS.ProcessEnv, tty?: boolean) {
		return {
			cwd: repo,
			color: false,
			...(tty === undefined ? {} : { tty }),
			env: {
				MELIAN_TEST_SCRIPT: join(dir, "script.json"),
				MELIAN_STATE_DIR: join(dir, "state"),
				XDG_CONFIG_HOME: join(dir, "config"),
				PI_CODING_AGENT_DIR: join(dir, "pi"),
				...env,
			},
			stdout: vi.fn<(text: string) => void>(),
			stderr: vi.fn<(text: string) => void>(),
		};
	}

	async function findings(env: NodeJS.ProcessEnv, tty?: boolean, local?: string): Promise<string> {
		if (local === undefined) rmSync(join(repo, "melian.local.yaml"), { force: true });
		else writeFileSync(join(repo, "melian.local.yaml"), local);
		const each = io(env, tty);
		expect(await main(["findings", "main...feature"], each)).toBe(0);
		return each.stdout.mock.calls.join("");
	}

	it("shows emojis under auto on a terminal whose locale is UTF-8", async () => {
		expect(await findings({ LANG: "en_AU.UTF-8" }, true)).toContain(`  ${red}\n`);
		expect(await findings({ LC_CTYPE: "en_AU.utf8", LANG: "C" }, true)).toContain(`  ${red}\n`);
	});

	it("prints words alone under auto off a terminal, or on one whose locale is not UTF-8", async () => {
		expect(await findings({ LANG: "en_AU.UTF-8" }, false)).toContain(`${words}\n`);
		expect(await findings({ LANG: "en_AU.UTF-8" })).toContain(`${words}\n`);
		expect(await findings({ LANG: "C" }, true)).toContain(`${words}\n`);
		expect(await findings({}, true)).toContain(`${words}\n`);
		expect(await findings({ LC_ALL: "C", LANG: "en_AU.UTF-8" }, true)).toContain(`${words}\n`);
		expect(await findings({ LC_CTYPE: "C", LANG: "en_AU.UTF-8" }, true)).toContain(`${words}\n`);
	});

	it("takes on and off from a preference file, whatever the terminal", async () => {
		expect(await findings({}, false, "output:\n  emoji: on\n")).toContain(`  ${red}\n`);
		expect(await findings({ LANG: "en_AU.UTF-8" }, true, "output:\n  emoji: off\n")).toContain(`${words}\n`);
	});

	it("falls back to auto when the configuration does not load, so stored findings still print", async () => {
		expect(await findings({ LANG: "en_AU.UTF-8" }, true, "output:\n  emoji: sometimes\n")).toContain(`  ${red}\n`);
		expect(await findings({ LANG: "C" }, true, "output:\n  emoji: sometimes\n")).toContain(`${words}\n`);
	});

	it("shows emojis in a review's own output too", async () => {
		writeFileSync(join(repo, "melian.local.yaml"), "output:\n  emoji: on\n");
		const each = io({});
		expect(await main(["review", "main...feature", "--no-walkthrough"], each)).toBe(1);
		expect(each.stdout.mock.calls.join("")).toContain(`  ${red}\n`);
		rmSync(join(repo, "melian.local.yaml"));
	});
});

describe("ReviewOutcome.render", () => {
	it("shows a repository lens beside the emoji its LENS.md declares, and only when emojis are on", async () => {
		const [base] = await Lens.builtins();
		const cleanup = Lens.from({ ...base!.toJSON(), name: "cleanup", emoji: "\u{1F9FD}" });
		const finding = Finding.create({
			rule: "dead-code",
			message: "Nothing calls retryLater.",
			file: "src/a.ts",
			startLine: 3,
			discriminator: "retryLater",
			cause: "introduced",
			severity: "P3",
			source: { check: "lens.cleanup" },
			explanation: { what: "Nothing calls retryLater.", whyHere: "This change adds it.", whatToDo: "Delete it." },
		});
		const verdict = new Adjudication({
			findings: [finding],
			manifest: [],
			checks: [],
			config: defaultConfig,
		}).adjudicate();
		const outcome = new ReviewOutcome(verdict);
		expect(outcome.render(false, true, [cleanup])).toContain(" | \u{1F9FD} cleanup | ");
		expect(outcome.render(false, true, [base!])).toContain(" | \u{1F50E} cleanup | ");
		expect(outcome.render(false, false, [cleanup])).toContain(" | cleanup | ");
	});
});
