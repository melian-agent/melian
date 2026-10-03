import {
	adjudicate,
	applyResolutions,
	createFinding,
	dedupeFindings,
	defaultConfig,
	type Finding,
	type FindingInput,
	loadConfig,
	type MelianConfig,
	parseFinding,
	type Resolution,
	resolveFinding,
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalInput } from "./fixtures/findings.ts";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

// As a producer stores it: no resolution until adjudication.
const finding = (input: Partial<FindingInput>) =>
	createFinding({ ...evalInput, trigger: undefined, resolution: undefined, ...input });
const resolvedAs = (each: Finding, resolution: Resolution) => ({
	...each,
	properties: { ...each.properties, resolution },
});
const renamedParameter = { file: "src/api.ts", startLine: 3, snippet: "export function load(userId: string) {" };

describe("resolveFinding", () => {
	it("takes the resolution configured for the severity of an introduced finding", () => {
		expect(resolveFinding(finding({ severity: "P0" }), defaultConfig)).toBe("block");
		expect(resolveFinding(finding({ severity: "P2" }), defaultConfig)).toBe("acknowledge");
		expect(resolveFinding(finding({ severity: "nit" }), defaultConfig)).toBe("silent");
	});

	it("keeps the configured resolution of an affected finding, which carries evidence", () => {
		const affected = finding({ severity: "P1", cause: { evidence: renamedParameter } });
		expect(resolveFinding(affected, defaultConfig)).toBe("block");
	});

	it("caps a pre-existing finding at advisory, whatever its severity", () => {
		const strict: MelianConfig = {
			...defaultConfig,
			resolution: { P0: "block", P1: "block", P2: "block", P3: "block", nit: "silent" },
		};
		for (const severity of ["P0", "P1", "P2", "P3"] as const) {
			expect(resolveFinding(finding({ severity, cause: "pre-existing" }), strict)).toBe("advisory");
		}
		expect(resolveFinding(finding({ severity: "nit", cause: "pre-existing" }), strict)).toBe("silent");
	});

	it("decides from severity and cause, never from a resolution the finding already carries", () => {
		expect(resolveFinding(finding({ severity: "P0", resolution: "silent" }), defaultConfig)).toBe("block");
		expect(resolveFinding(finding({ severity: "nit", resolution: "block" }), defaultConfig)).toBe("silent");
	});
});

describe("applyResolutions under layered configuration", () => {
	let repo: string;

	beforeEach(() => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		repo = temporaryDirectory();
		gitIn(repo, "init", "--quiet", "--initial-branch=main");
		writeFiles(repo, {
			"melian.yaml": lines("resolution:", "  P3: acknowledge"),
			"docs/melian.yaml": lines("resolution:", "  P2: advisory"),
		});
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "policy");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		removeDirectory(repo);
	});

	it("resolves each finding under the configuration for its own path", async () => {
		const source = { kind: "revision", commit: gitIn(repo, "rev-parse", "HEAD") } as const;
		const findings = [
			finding({ file: "src/run.ts", severity: "P2" }),
			finding({ file: "docs/guide/setup.md", severity: "P2" }),
			finding({ file: "docs/guide/setup.md", severity: "P3", rule: "stale-link" }),
			finding({ file: "docs/guide/setup.md", severity: "P1", rule: "leaked-key" }),
		];
		const configs = new Map<string, MelianConfig>();
		for (const { properties } of findings) {
			configs.set(properties.path, (await loadConfig(repo, source, properties.path)).config);
		}

		const resolved = applyResolutions(findings, (path) => configs.get(path)!);

		expect(resolved.map((each) => each.properties.resolution)).toEqual([
			"acknowledge",
			"advisory",
			"acknowledge",
			"block",
		]);
		expect(findings[1]!.properties.resolution).toBeUndefined();
	});
});

describe("dedupeFindings", () => {
	const lens = finding({ severity: "P1" });
	const eslintInput: Partial<FindingInput> = {
		rule: "security/detect-eval-with-expression",
		severity: "P2",
		message: "eval with a non-literal argument",
		source: { check: "static.eslint" },
	};
	const eslint = finding(eslintInput);
	const aliases = { ruleAliases: { "no-eval": ["security/detect-eval-with-expression"] } };

	it("keeps the higher-severity finding when a static tool and a lens report one problem under aliased rules", () => {
		const [kept, ...rest] = dedupeFindings([eslint, lens], () => aliases);

		expect(rest).toEqual([]);
		expect(kept!.properties.id).toBe(lens.properties.id);
		expect(kept!.properties.alsoReportedAs).toEqual([
			{ id: eslint.properties.id, ruleId: "security/detect-eval-with-expression", check: "static.eslint" },
		]);
		expect(parseFinding(kept)).toEqual(kept);
	});

	it("keeps the more severe finding when no alias names an owner", () => {
		const severe = finding({ ...eslintInput, severity: "P0" });
		const deduped = dedupeFindings([lens, severe], () => defaultConfig);
		expect(deduped.map((each) => each.properties.source.check)).toEqual(["static.eslint"]);
		expect(deduped[0]!.properties.alsoReportedAs).toEqual([
			{ id: lens.properties.id, ruleId: "no-eval", check: "lens.security" },
		]);
	});

	it("keeps the alias's owner and raises it to the highest severity reported", () => {
		const severe = finding({ ...eslintInput, severity: "P0" });
		const [kept, ...rest] = dedupeFindings([lens, severe], () => aliases);
		expect(rest).toEqual([]);
		expect(kept).toMatchObject({ ruleId: "no-eval", level: "error", properties: { severity: "P0" } });
		expect(parseFinding(kept)).toEqual(kept);
	});

	it("keeps both at another occurrence or from the same check", () => {
		const second = finding({ ...eslintInput, occurrence: 1 });
		expect(dedupeFindings([second, lens], () => aliases)).toHaveLength(2);
		const sameCheck = finding({ ...eslintInput, source: { check: "lens.security" } });
		expect(dedupeFindings([sameCheck, lens], () => aliases)).toHaveLength(2);
	});

	// The first live golden run: two lenses filed one broken caller in src/cart.ts under different rules.
	describe("two lenses reporting one defect under different rules", () => {
		const evidence = {
			file: "src/price.ts",
			startLine: 1,
			snippet: "export function formatPrice(amount: number, currency: string): string {",
		};
		const atCart = {
			file: "src/cart.ts",
			startLine: 10,
			endLine: 10,
			startColumn: undefined,
			endColumn: undefined,
			snippet: `\treturn \`Total: \${formatPrice(total)}\`;`,
			occurrence: 0,
			cause: { evidence },
			severity: "P0",
		} as const;
		const brokenCaller = finding({
			...atCart,
			rule: "broken-caller",
			message: "summary still calls formatPrice(total) with one argument",
			source: { check: "lens.contracts", version: "1" },
		});
		const unhandledError = finding({
			...atCart,
			rule: "unhandled-error",
			message: "summary still calls formatPrice(total) with one argument, but currency is now required",
			source: { check: "lens.correctness", version: "1" },
		});

		it("merges them without any alias", () => {
			const deduped = dedupeFindings([brokenCaller, unhandledError], () => defaultConfig);
			expect(deduped).toHaveLength(1);
			const other = deduped[0]!.ruleId === "broken-caller" ? unhandledError : brokenCaller;
			expect(deduped[0]!.properties.alsoReportedAs).toEqual([reportOf(other)]);
		});

		it("keeps the affected cause and its evidence when the more severe finding cites none", () => {
			const unproven = finding({
				...atCart,
				cause: "pre-existing",
				rule: "unhandled-error",
				source: { check: "lens.correctness", version: "1" },
			});
			const evidenced = finding({
				...atCart,
				severity: "P1",
				rule: "broken-caller",
				source: { check: "lens.contracts", version: "1" },
			});
			for (const order of [
				[unproven, evidenced],
				[evidenced, unproven],
			]) {
				const [kept, ...rest] = dedupeFindings(order, () => defaultConfig);
				expect(rest).toEqual([]);
				expect(kept!.properties).toMatchObject({ severity: "P0", cause: "affected", evidence });
				expect(parseFinding(kept)).toEqual(kept);
				expect(resolveFinding(kept!, defaultConfig)).toBe("block");
			}
		});

		it("keeps an introduced cause over an affected one, and drops evidence only an affected finding carries", () => {
			const introduced = finding({ ...atCart, cause: "introduced", severity: "P2", rule: "unhandled-error" });
			const [kept] = dedupeFindings([brokenCaller, introduced], () => defaultConfig);
			expect(kept!.properties.cause).toBe("introduced");
			expect(kept!.properties).not.toHaveProperty("evidence");
			expect(parseFinding(kept)).toEqual(kept);
		});

		it("never merges two rules an alias entry marks distinct", () => {
			const apart = { ruleAliases: { "unhandled-error": { rules: ["broken-caller"], distinct: true } } };
			expect(dedupeFindings([brokenCaller, unhandledError], () => apart)).toHaveLength(2);
			const reversed = { ruleAliases: { "broken-caller": { rules: ["unhandled-error"], distinct: true } } };
			expect(dedupeFindings([unhandledError, brokenCaller], () => reversed)).toHaveLength(2);
		});

		it("keeps the contracts lens's finding when the alias table says the defect is its", () => {
			const owned = { ruleAliases: { "broken-caller": ["unhandled-error"] } };
			for (const order of [
				[brokenCaller, unhandledError],
				[unhandledError, brokenCaller],
			]) {
				const [kept, ...rest] = dedupeFindings(order, () => owned);
				expect(rest).toEqual([]);
				expect(kept!.properties.id).toBe(brokenCaller.properties.id);
				expect(kept!.properties.alsoReportedAs).toEqual([
					{ id: unhandledError.properties.id, ruleId: "unhandled-error", check: "lens.correctness" },
				]);
			}
		});
	});
});

function reportOf(finding: Finding) {
	return { id: finding.properties.id, ruleId: finding.ruleId, check: finding.properties.source.check };
}

describe("adjudicate", () => {
	const ran = (name: string) => ({ name, status: "ran" }) as const;
	const checks = [ran("lens.correctness"), ran("static.biome")];
	const blocker = finding({ severity: "P1" });
	const advisory = finding({ severity: "P3", rule: "naming" });
	const silent = finding({ severity: "nit", rule: "prefer-const" });

	it("passes when every check ran and nothing is above silent", () => {
		const verdict = adjudicate({ findings: [silent], checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "passed", blocking: false, notRun: [] });
		expect(verdict.findings.silent).toEqual([resolvedAs(silent, "silent")]);
	});

	it("reports findings without blocking when nothing resolves to block", () => {
		const verdict = adjudicate({ findings: [advisory, silent], checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "findings", blocking: false });
		expect(verdict.findings.advisory).toEqual([resolvedAs(advisory, "advisory")]);
	});

	it("blocks when a finding resolves to block, and groups by resolution", () => {
		const verdict = adjudicate({ findings: [silent, advisory, blocker], checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "findings", blocking: true });
		expect(Object.keys(verdict.findings)).toEqual(["block", "acknowledge", "advisory", "silent"]);
		expect(verdict.findings.block).toEqual([resolvedAs(blocker, "block")]);
		expect(verdict.findings.acknowledge).toEqual([]);
	});

	it("resolves a finding that arrives without a resolution, rather than drop it or count it silent", () => {
		expect(blocker.properties.resolution).toBeUndefined();
		const verdict = adjudicate({ findings: [blocker], checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "findings", blocking: true });
		expect(verdict.findings.block).toEqual([resolvedAs(blocker, "block")]);
		expect(verdict.findings.silent).toEqual([]);
	});

	it("replaces a resolution a finding arrives with", () => {
		const marked = finding({ severity: "P0", resolution: "silent" });
		const verdict = adjudicate({ findings: [marked], checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "findings", blocking: true });
		expect(verdict.findings.block).toEqual([resolvedAs(marked, "block")]);
	});

	it("is not reviewed when a check failed, even with no findings", () => {
		const failed = { name: "lens.security", status: "failed", reason: "the lens did not finish" } as const;
		const verdict = adjudicate({ findings: [], checks: [...checks, failed], config: defaultConfig });
		expect(verdict).toEqual({
			status: "not-reviewed",
			blocking: false,
			findings: { block: [], acknowledge: [], advisory: [], silent: [] },
			dismissed: [],
			notRun: [failed],
		});
	});

	it("is not reviewed when a check was skipped without leave, and still says whether it blocks", () => {
		const skipped = { name: "static.tsc", status: "skipped", reason: "no tsconfig.json" } as const;
		const input = { findings: [blocker], checks: [...checks, skipped], config: defaultConfig };
		expect(adjudicate(input)).toMatchObject({ status: "not-reviewed", blocking: true, notRun: [skipped] });
		expect(adjudicate({ ...input, allowSkip: ["static.tsc"] })).toMatchObject({
			status: "findings",
			notRun: [skipped],
		});
		expect(adjudicate({ ...input, findings: [], allowSkip: ["static.tsc"] }).status).toBe("passed");
	});

	it("counts a dismissed finding toward neither status nor blocking", () => {
		const dismissed = finding({ status: "dismissed" });
		const verdict = adjudicate({ findings: [dismissed], checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "passed", blocking: false, dismissed: [resolvedAs(dismissed, "block")] });
	});

	it("resolves per path and dedupes across sources", () => {
		const docs = finding({ file: "docs/guide.md", severity: "P1" });
		const eslint = finding({ rule: "detect-eval", severity: "P2", source: { check: "static.eslint" } });
		const lowered = { ...defaultConfig.resolution, P1: "advisory" } as const;
		const configFor = (path: string) => ({
			resolution: path.startsWith("docs/") ? lowered : defaultConfig.resolution,
			ruleAliases: { "no-eval": ["detect-eval"] },
		});
		const verdict = adjudicate({ findings: [docs, eslint, blocker], checks, config: configFor });
		expect(verdict.findings.advisory.map((each) => each.properties.path)).toEqual(["docs/guide.md"]);
		expect(verdict.findings.block).toHaveLength(1);
		expect(verdict.findings.block[0]!.properties.alsoReportedAs).toEqual([
			{ id: eslint.properties.id, ruleId: "detect-eval", check: "static.eslint" },
		]);
		expect(verdict.findings.acknowledge).toEqual([]);
	});
});
