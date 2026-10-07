import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { CheckError, EnolaPolicy, normaliseEnolaSarif, staticSeverity } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPolicyFile } from "../src/paths.ts";
import { SourceError } from "../src/source.ts";
import { gitIn, isolatedGitEnv, rejection, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

describe("Enola policy and reports", () => {
	it("orders policy inputs before hashing and leaves configuration-only policy out of the gate", () => {
		const files = [
			{ path: "mcp-arch.yaml", text: "rules: [fallback]\n" },
			{ path: "enola.yaml", text: "rules: [primary]\n" },
			{ path: ".enola/suppressions.yaml", text: "[]\n" },
		];
		const policy = EnolaPolicy.from(files);
		expect(policy.toJSON().files.map((file) => file.path)).toEqual([
			".enola/suppressions.yaml",
			"enola.yaml",
			"mcp-arch.yaml",
		]);
		expect(policy.hash).toBe(EnolaPolicy.from([...files].reverse()).hash);
		expect(policy.toJSON().failOn).toEqual([]);
		expect(policy.toJSON().config).toContain("primary");
		expect(policy.toJSON().config).not.toContain("fallback");
		expect(EnolaPolicy.from([files[0]!]).toJSON().config).toContain("fallback");
	});
	it("refuses YAML warnings before using a configuration mapping", () => {
		expect(() => EnolaPolicy.from([{ path: "enola.yaml", text: "foo: !unknown value\n" }])).toThrow(
			"Invalid Enola configuration",
		);
	});
	it("retains the typed SARIF refusal and its exact diagnostic", () => {
		try {
			normaliseEnolaSarif("{}", { root: "/repo", version: "0.4.27" });
			throw new Error("accepted invalid report");
		} catch (error) {
			expect(error).toMatchObject({
				name: "CheckError",
				code: "invalidOutput",
				check: "static.enola",
				message: "Enola wrote unreadable SARIF: Not one SARIF 2.1.0 run",
			});
		}
	});
	it("recognises every policy path and leaves a committed baseline out", () => {
		for (const path of [
			"enola.yaml",
			"mcp-arch.yaml",
			"enola-intent.yaml",
			"enola/constraints/core.yaml",
			".enola/suppressions.yaml",
		])
			expect(isPolicyFile(path)).toBe(true);
		expect(isPolicyFile(".enola/baseline/facts.jsonl")).toBe(false);
	});
	it("disables executable providers and names only declared constraints as gate policy", () => {
		const policy = EnolaPolicy.from([
			{
				path: "enola.yaml",
				text: "providers:\n  - command: [evil]\noutput: {dir: outside}\nhistory: {enabled: true}\nrepos: [outside]\n",
			},
			{ path: "enola/constraints/core.yaml", text: "rules: []\n" },
		]);
		expect(policy.toJSON().config).toContain("providers: []");
		expect(policy.toJSON().config).toContain("dir: .enola");
		expect(policy.toJSON().config).toContain("enabled: false");
		expect(policy.toJSON().config).not.toContain("repos:");
		expect(policy.toJSON().failOn).toEqual(["constraints"]);
		expect(EnolaPolicy.from([]).toJSON().failOn).toEqual([]);
	});
	it("turns on the constraint gate for a top-level rules or recipes key in the intent file", () => {
		const none = EnolaPolicy.from([{ path: "enola-intent.yaml", text: "name: x\n" }]);
		for (const key of ["rules", "recipes"]) {
			const policy = EnolaPolicy.from([{ path: "enola-intent.yaml", text: `name: x\n${key}:\n  - a\n` }]);
			expect(policy.toJSON().failOn).toEqual(["constraints"]);
			expect(policy.hash).not.toBe(none.hash);
		}
		const gated = EnolaPolicy.from([{ path: "enola-intent.yaml", text: "rules:\n  - a\n" }]);
		const ungated = EnolaPolicy.from([{ path: "enola-intent.yaml", text: "notes:\n  - a\n" }]);
		expect(gated.hash).not.toBe(ungated.hash);
	});
	it("leaves the constraint gate off for an intent file without a top-level rules or recipes key", () => {
		expect(EnolaPolicy.from([{ path: "enola-intent.yaml", text: "name: x\n" }]).toJSON().failOn).toEqual([]);
		expect(
			EnolaPolicy.from([{ path: "enola-intent.yaml", text: "name: x\n  rules:\n    - a\n" }]).toJSON().failOn,
		).toEqual([]);
		expect(
			EnolaPolicy.from([{ path: "enola-intent.yaml", text: "# rules:\nname: x\n  recipes: []\n" }]).toJSON().failOn,
		).toEqual([]);
		expect(EnolaPolicy.from([{ path: "other/enola-intent.yaml", text: "rules:\n  - a\n" }]).toJSON().failOn).toEqual(
			[],
		);
	});
	it("reads located and unlocated results, excluding resolved and suppressed findings", () => {
		const result = { ruleId: "constraints/core-layer", level: "error", message: { text: "Layer crossed" } };
		const log = normaliseEnolaSarif(
			JSON.stringify({
				version: "2.1.0",
				runs: [
					{
						results: [
							result,
							{ ...result, properties: { bucket: "resolved" } },
							{ ...result, suppressions: [{ kind: "external" }] },
							{
								...result,
								locations: [
									{
										physicalLocation: {
											artifactLocation: { uri: "packages/core/src/a.ts" },
											region: { startLine: 4 },
										},
									},
								],
							},
						],
					},
				],
			}),
			{ root: "/repo", version: "0.4.27" },
		);
		expect(log.runs[0].tool.driver).toEqual({ name: "enola", version: "0.4.27" });
		expect(log.runs[0].results.map((r) => r.locations[0]?.physicalLocation.artifactLocation.uri)).toEqual([
			"enola-intent.yaml",
			"packages/core/src/a.ts",
		]);
		expect(staticSeverity("enola", "enola/layer", "error", {})).toBe("P2");
		expect(staticSeverity("enola", "enola/layer", "warning", {})).toBe("P3");
		expect(staticSeverity("enola", "enola/layer", "note", {})).toBe("nit");
		expect(staticSeverity("enola", "enola/layer", "warning", { "enola/layer": "P1" })).toBe("P1");
	});
	it.each(["", "{}", '{"version":"2.1.0","runs":[{"results":[{}]}]}'])("fails unreadable SARIF closed", (text) => {
		expect(() => normaliseEnolaSarif(text, { root: "/repo", version: "0.4.27" })).toThrow();
	});
});

describe("revision Enola policy limits", () => {
	let repo: string;
	beforeEach(() => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		repo = temporaryDirectory();
		gitIn(repo, "init", "--quiet", "--initial-branch=main");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		removeDirectory(repo);
	});
	it("detects unchanged policy and refuses each file beyond 256 KiB", async () => {
		writeFiles(repo, { "enola/constraints/a.yaml": "rules: []\n" });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "policy");
		const policy = await EnolaPolicy.load(repo, "HEAD");
		expect(await policy.differs(repo, "HEAD")).toBe(false);
		const text = "#".repeat(256 * 1024 + 1);
		writeFiles(repo, { "enola/constraints/a.yaml": text });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "oversized policy");
		await expect(EnolaPolicy.load(repo, "HEAD")).rejects.toMatchObject({ code: "tooLarge" });
		expect(await EnolaPolicy.from([{ path: "enola/constraints/a.yaml", text }]).differs(repo, "HEAD")).toBe(true);
	});
	it.each([1, 230 * 1024])("rejects an aggregate exceeding 1 MiB by %i bytes", async (extra) => {
		writeFiles(
			repo,
			Object.fromEntries(
				Array.from({ length: 4 }, (_, i) => [`enola/constraints/${i}.yaml`, "#".repeat(256 * 1024)]),
			),
		);
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "boundary");
		const boundary = await EnolaPolicy.load(repo, "HEAD");
		expect(boundary.toJSON().files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0)).toBe(1024 * 1024);
		writeFiles(repo, { "enola/constraints/4.yaml": "#".repeat(extra) });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "oversize");
		const error = await rejection(EnolaPolicy.load(repo, "HEAD"), CheckError);
		expect(error.code).toBe("outputTooLarge");
		expect(error.message).toContain("Enola policy exceeds 1 MiB");
	});
	it.each(["symlink", "tooLarge"])("treats %s head policy as changed", async (kind) => {
		writeFiles(repo, { "enola.yaml": "rules: []\n" });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "base");
		const policy = await EnolaPolicy.load(repo, "HEAD");
		if (kind === "symlink") {
			rmSync(join(repo, "enola.yaml"));
			symlinkSync("outside.yaml", join(repo, "enola.yaml"));
		} else writeFiles(repo, { "enola.yaml": "#".repeat(256 * 1024 + 1) });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "head");
		expect(await policy.differs(repo, "HEAD")).toBe(true);
	});
	it("propagates unreadable head policy instead of treating it as changed", async () => {
		writeFiles(repo, { "enola/constraints/a.yaml": "base\n" });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "base");
		const policy = await EnolaPolicy.load(repo, "HEAD");
		writeFiles(repo, { "enola/constraints/a.yaml": "head\n" });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "head");
		const blob = gitIn(repo, "rev-parse", "HEAD:enola/constraints/a.yaml");
		rmSync(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
		const error = await rejection(policy.differs(repo, "HEAD"), SourceError);
		expect(error.code).toBe("unreadable");
	});
});
