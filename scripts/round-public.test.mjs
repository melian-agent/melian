import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RoundComment } from "./round.mjs";

const script = fileURLToPath(new URL("./round-comment.mjs", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/round-probe-verdict.json", import.meta.url));
const token = "sk-probe-SECRET-123";
// What Biome printed on the probe's run, where a head biome.json extended a file outside the checkout.
const printed = readFileSync(probe, "utf8").match(/biome exited[^"]*/)[0];
const base = "b".repeat(40);
const head = "0123456789abcdef0123456789abcdef01234567";
const mergeBase = "e".repeat(40);
const scratch = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(name, text) {
	const dir = mkdtempSync(join(tmpdir(), "round-public-"));
	scratch.push(dir);
	writeFileSync(join(dir, name), text);
	return join(dir, name);
}

const staticFinding = {
	ruleId: "parse",
	message: { text: `biome.json does not parse: ${printed}` },
	locations: [
		{
			physicalLocation: {
				artifactLocation: { uri: "biome.json" },
				region: { startLine: 1, snippet: { text: token } },
			},
		},
	],
	properties: {
		id: "aaaaaaaaaaaaaaaa",
		path: "biome.json",
		severity: "P1",
		resolution: "block",
		explanation: { what: token },
		source: { check: "static.biome", version: "2.5.15" },
	},
};
const verdict = {
	status: "findings",
	blocking: true,
	findings: { block: [staticFinding], acknowledge: [], advisory: [staticFinding], silent: [] },
	dismissed: [staticFinding],
	notRun: [
		{ name: "static.biome", status: "failed", reason: printed, error: printed },
		{ name: "lens.tests", status: "provisional", level: "deep", reason: printed },
	],
	ran: [{ name: "static.tsc", status: "ran", version: printed }],
	telemetry: { stages: [{ subject: "static.biome", error: printed }] },
};
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("what of a round leaves the job", () => {
	it("keeps the text a static tool printed out of the public verdict", () => {
		const published = run("--public", file("verdict.json", JSON.stringify(verdict)));
		expect([published.status, published.stderr]).toEqual([0, ""]);
		expect(published.stdout).not.toContain(token);
		expect(JSON.parse(published.stdout)).toEqual({
			status: "findings",
			blocking: true,
			findings: {
				block: [
					{
						ruleId: "parse",
						message: { text: "A static check's finding; a local run shows its text." },
						locations: [{ physicalLocation: { region: { startLine: 1 } } }],
						properties: {
							id: "aaaaaaaaaaaaaaaa",
							path: "biome.json",
							severity: "P1",
							resolution: "block",
							source: { check: "static.biome" },
						},
					},
				],
				acknowledge: [],
			},
			notRun: [
				{ name: "static.biome", status: "failed" },
				{ name: "lens.tests", status: "provisional" },
			],
			ran: [{ name: "static.tsc", status: "ran" }],
		});
	});

	it("keeps the probe's own output out of the public verdict, and reads it as no verdict", () => {
		expect(readFileSync(probe, "utf8")).toContain(token);
		const published = run("--public", probe);
		expect([published.status, published.stdout, published.stderr]).toEqual([0, "null\n", ""]);
		const absent = run("--public", join(tmpdir(), "round-public-absent", "verdict.json"));
		expect([absent.status, absent.stdout, absent.stderr]).toEqual([0, "null\n", ""]);
	});

	it("keeps the text a static tool printed out of the comment, whatever verdict file it reads", () => {
		const body = RoundComment.read({
			verdict: file("verdict.json", JSON.stringify(verdict)),
			rounds: file("rounds.json", JSON.stringify([{ base: mergeBase, head }])),
			exitCode: "1",
			runUrl: "https://example.test/run",
			runId: "1",
			nonce: "0123456789abcdef0123456789abcdef",
			base,
			head,
			mergeBase,
			current: { base, head },
		}).body();
		expect(body).not.toContain(token);
		expect(body).toContain("  static.biome  failed\n");
		expect(body).toContain("A local run of melian review shows why each check did not run.");
	});
});
