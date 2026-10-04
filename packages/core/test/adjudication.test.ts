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
const renamedParameter = [
	{
		file: "src/api.ts",
		startLine: 3,
		role: "cause",
		revision: "head",
		snippet: "export function load(userId: string) {",
	},
] as const;

describe("resolveFinding", () => {
	it("takes the resolution configured for the severity of an introduced finding", () => {
		expect(resolveFinding(finding({ severity: "P0" }), defaultConfig)).toBe("block");
		expect(resolveFinding(finding({ severity: "P2" }), defaultConfig)).toBe("acknowledge");
		expect(resolveFinding(finding({ severity: "nit" }), defaultConfig)).toBe("silent");
	});

	it("keeps the configured resolution of an affected finding, which carries evidence", () => {
		const affected = finding({ severity: "P1", cause: "affected", evidence: [...renamedParameter] });
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

	it("keeps apart two findings whose snippets are cut alike but differ past the cut", () => {
		const long = `const table = [${Array.from({ length: 300 }, (_, index) => `"cell${index}"`).join(", ")}];`;
		const atLine = { startLine: 1, startColumn: undefined, endColumn: undefined };
		const oneLine = finding({ ...atLine, endLine: 1, snippet: long });
		const twoLines = finding({ ...eslintInput, ...atLine, endLine: 2, snippet: `${long}\nrun(table);` });
		expect(oneLine.locations[0]!.physicalLocation.region.snippet).toEqual(
			twoLines.locations[0]!.physicalLocation.region.snippet,
		);
		expect(dedupeFindings([oneLine, twoLines], () => aliases)).toHaveLength(2);
	});

	// The first live golden run: two lenses filed one broken caller in src/cart.ts under different rules.
	describe("two lenses reporting one defect under different rules", () => {
		const evidence = [
			{
				file: "src/price.ts",
				startLine: 1,
				role: "cause" as const,
				revision: "head" as const,
				snippet: "export function formatPrice(amount: number, currency: string): string {",
			},
		];
		const failureScenario = "summary() calls formatPrice(total) with no currency, and Intl.NumberFormat throws.";
		const atCart = {
			file: "src/cart.ts",
			startLine: 10,
			endLine: 10,
			startColumn: undefined,
			endColumn: undefined,
			snippet: `\treturn \`Total: \${formatPrice(total)}\`;`,
			occurrence: 0,
			cause: "affected",
			evidence,
			failureScenario,
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

		const claimOf = (each: Finding) => ({
			id: each.properties.id,
			ruleId: each.ruleId,
			source: each.properties.source,
			failureScenario: each.properties.failureScenario,
			evidence: each.properties.evidence,
		});
		const context = [{ ...evidence[0]!, role: "context" as const }];
		const unprovenInput: Partial<FindingInput> = {
			...atCart,
			cause: "pre-existing",
			evidence: context,
			failureScenario: "A guess.",
			rule: "unhandled-error",
			source: { check: "lens.correctness", version: "1" },
		};
		const unproven = finding(unprovenInput);
		const evidenced = finding({
			...atCart,
			severity: "P1",
			rule: "broken-caller",
			source: { check: "lens.contracts", version: "1" },
		});

		it("lets the speaker keep its own claim, adds the cause locations that prove the merged cause, and keeps the other claim whole", () => {
			for (const order of [
				[unproven, evidenced],
				[evidenced, unproven],
			]) {
				const [kept, ...rest] = dedupeFindings(order, () => defaultConfig);
				expect(rest).toEqual([]);
				expect(kept!.properties).toMatchObject({
					id: unproven.properties.id,
					severity: "P0",
					cause: "affected",
					failureScenario: "A guess.",
					evidence: [...context, ...evidence],
					otherClaims: [claimOf(evidenced)],
				});
				expect(parseFinding(kept)).toEqual(kept);
				expect(resolveFinding(kept!, defaultConfig)).toBe("block");
			}
		});

		it("lets the alias owner keep its own scenario and evidence when another member proves the cause", () => {
			const owned = { ruleAliases: { "unhandled-error": ["broken-caller"] } };
			const owner = finding({ ...unprovenInput, failureScenario: "The owner's scenario.", severity: "P3" });
			const [kept] = dedupeFindings([evidenced, owner], () => owned);
			expect(kept!.properties).toMatchObject({
				id: owner.properties.id,
				severity: "P1",
				cause: "affected",
				failureScenario: "The owner's scenario.",
				evidence: [...context, ...evidence],
				otherClaims: [claimOf(evidenced)],
			});
			expect(resolveFinding(kept!, defaultConfig)).toBe("block");
		});

		it("caps the merged evidence at ten locations and still carries a cause location that proves it", () => {
			const many = Array.from({ length: 10 }, (_, index) => ({
				...context[0]!,
				startLine: index + 1,
				snippet: `line ${index + 1}`,
			}));
			const crowded = finding({ ...unprovenInput, evidence: many });
			const [kept] = dedupeFindings([crowded, evidenced], () => defaultConfig);
			expect(kept!.properties.evidence).toEqual([...many.slice(0, 9), evidence[0]]);
			expect(kept!.properties.otherClaims).toEqual([claimOf(evidenced)]);
			expect(resolveFinding(kept!, defaultConfig)).toBe("block");
		});

		// A lens may mark more than one location `cause`, the defect's own unchanged line among them.
		const ownLine = {
			file: "src/cart.ts",
			startLine: 10,
			role: "cause" as const,
			revision: "head" as const,
			snippet: atCart.snippet,
		};
		const proving = { ...evidence[0]!, proves: true as const };
		const contextLines = (count: number) =>
			Array.from({ length: count }, (_, index) => ({
				...context[0]!,
				startLine: index + 1,
				snippet: `line ${index + 1}`,
			}));

		it("keeps the cause location that proves the merged cause when the cap cuts another before it", () => {
			const many = contextLines(10);
			const crowded = finding({ ...unprovenInput, evidence: many });
			const twoCauses = finding({
				...atCart,
				severity: "P1",
				rule: "broken-caller",
				source: { check: "lens.contracts", version: "1" },
				evidence: [ownLine, proving],
			});
			const [kept] = dedupeFindings([crowded, twoCauses], () => defaultConfig);
			expect(kept!.properties.cause).toBe("affected");
			expect(kept!.properties.evidence).toEqual([...many.slice(0, 9), proving]);
			expect(resolveFinding(kept!, defaultConfig)).toBe("block");
		});

		it("imports the proving cause location first when it comes third among the prover's causes", () => {
			const many = contextLines(8);
			const crowded = finding({ ...unprovenInput, evidence: many });
			const otherLine = { ...ownLine, file: "src/total.ts", startLine: 4, snippet: "const total = sum(items);" };
			const threeCauses = finding({
				...atCart,
				severity: "P1",
				rule: "broken-caller",
				source: { check: "lens.contracts", version: "1" },
				evidence: [ownLine, otherLine, proving],
			});
			const [kept] = dedupeFindings([crowded, threeCauses], () => defaultConfig);
			expect(kept!.properties.evidence).toEqual([...many, proving, ownLine]);
			expect(resolveFinding(kept!, defaultConfig)).toBe("block");
		});

		it("counts only a cause location marked as proving once any location is marked, and any one when none is", () => {
			const marked = finding({
				...atCart,
				severity: "P1",
				evidence: [ownLine, { ...context[0]!, proves: true }],
			});
			expect(resolveFinding(marked, defaultConfig)).toBe("advisory");
			const stored = finding({ ...atCart, severity: "P1", evidence: [ownLine] });
			expect(resolveFinding(stored, defaultConfig)).toBe("block");
		});

		it("keeps an introduced cause over an affected one, and every member's own claim", () => {
			const own = [{ ...evidence[0]!, file: "src/cart.ts", startLine: 10, snippet: "formatPrice(total)" }];
			const introduced = finding({
				...atCart,
				cause: "introduced",
				evidence: own,
				failureScenario: "Introduced.",
				severity: "P2",
				rule: "unhandled-error",
			});
			const [kept] = dedupeFindings([brokenCaller, introduced], () => defaultConfig);
			expect(kept!.properties).toMatchObject({
				id: brokenCaller.properties.id,
				cause: "introduced",
				failureScenario,
				evidence: [...evidence, ...own],
				otherClaims: [claimOf(introduced)],
			});
			expect(parseFinding(kept)).toEqual(kept);
			const tsc = finding({
				...atCart,
				cause: "introduced",
				evidence: undefined,
				failureScenario: undefined,
				source: { check: "static.tsc" },
			});
			const [plain] = dedupeFindings([brokenCaller, tsc], () => defaultConfig);
			expect(plain!.properties).toMatchObject({ cause: "introduced", failureScenario, evidence });
			expect(plain!.properties).not.toHaveProperty("otherClaims");
		});

		it("carries the claims a merged finding already holds into the next merge", () => {
			const [first] = dedupeFindings([unproven, evidenced], () => defaultConfig);
			const third = finding({
				...atCart,
				severity: "P3",
				failureScenario: "A third view.",
				rule: "null-dereference",
				source: { check: "lens.security", version: "1" },
			});
			const [kept] = dedupeFindings([first!, third], () => defaultConfig);
			expect(kept!.properties.otherClaims).toEqual([claimOf(evidenced), claimOf(third)]);
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
	const manifest = checks.map((check) => check.name);
	const blocker = finding({ severity: "P1" });
	const advisory = finding({ severity: "P3", rule: "naming" });
	const silent = finding({ severity: "nit", rule: "prefer-const" });

	it("passes when every check ran and nothing is above silent", () => {
		const verdict = adjudicate({ findings: [silent], manifest, checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "passed", blocking: false, notRun: [] });
		expect(verdict.findings.silent).toEqual([resolvedAs(silent, "silent")]);
	});

	it("reports findings without blocking when nothing resolves to block", () => {
		const verdict = adjudicate({ findings: [advisory, silent], manifest, checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "findings", blocking: false });
		expect(verdict.findings.advisory).toEqual([resolvedAs(advisory, "advisory")]);
	});

	it("blocks when a finding resolves to block, and groups by resolution", () => {
		const verdict = adjudicate({ findings: [silent, advisory, blocker], manifest, checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "findings", blocking: true });
		expect(Object.keys(verdict.findings)).toEqual(["block", "acknowledge", "advisory", "silent"]);
		expect(verdict.findings.block).toEqual([resolvedAs(blocker, "block")]);
		expect(verdict.findings.acknowledge).toEqual([]);
	});

	it("resolves a finding that arrives without a resolution, rather than drop it or count it silent", () => {
		expect(blocker.properties.resolution).toBeUndefined();
		const verdict = adjudicate({ findings: [blocker], manifest, checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "findings", blocking: true });
		expect(verdict.findings.block).toEqual([resolvedAs(blocker, "block")]);
		expect(verdict.findings.silent).toEqual([]);
	});

	it("replaces a resolution a finding arrives with", () => {
		const marked = finding({ severity: "P0", resolution: "silent" });
		const verdict = adjudicate({ findings: [marked], manifest, checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "findings", blocking: true });
		expect(verdict.findings.block).toEqual([resolvedAs(marked, "block")]);
	});

	it("is not reviewed when a check failed, even with no findings", () => {
		const failed = { name: "lens.security", status: "failed", reason: "the lens did not finish" } as const;
		const verdict = adjudicate({ findings: [], manifest, checks: [...checks, failed], config: defaultConfig });
		expect(verdict).toEqual({
			status: "not-reviewed",
			blocking: false,
			findings: { block: [], acknowledge: [], advisory: [], silent: [] },
			dismissed: [],
			notRun: [failed],
			ran: checks,
		});
	});

	it("is not reviewed when a budget ended a lens, which allowSkip cannot excuse", () => {
		const ended = {
			name: "lens.correctness",
			status: "ended",
			level: "careful",
			budgetEnded: { budget: "tokens", limit: 200_000, tokens: 201_000, tools: 12 },
		} as const;
		const verdict = adjudicate({
			findings: [],
			manifest,
			checks: [...checks, ended],
			config: defaultConfig,
			allowSkip: ["lens.correctness"],
		});
		expect(verdict).toMatchObject({ status: "not-reviewed", notRun: [ended], ran: checks });
	});

	it("keeps the checks that ran, each lens with its level", () => {
		const lens = { name: "lens.correctness", status: "ran", level: "careful" } as const;
		const verdict = adjudicate({ findings: [], manifest, checks: [...checks, lens], config: defaultConfig });
		expect(verdict.ran).toEqual([...checks, lens]);
	});

	it("is not reviewed when a check the manifest names left no record, even with no findings", () => {
		const verdict = adjudicate({
			findings: [],
			manifest: [...manifest, "guardrails"],
			checks,
			config: defaultConfig,
			allowSkip: ["guardrails"],
		});
		expect(verdict).toMatchObject({
			status: "not-reviewed",
			blocking: false,
			notRun: [{ name: "guardrails", status: "skipped", reason: "no record" }],
		});
	});

	it("passes when every check of the manifest ran and nothing was found", () => {
		expect(adjudicate({ findings: [], manifest, checks, config: defaultConfig }).status).toBe("passed");
	});

	it("is not reviewed when a check was skipped without leave, and still says whether it blocks", () => {
		const skipped = { name: "static.tsc", status: "skipped", reason: "no tsconfig.json" } as const;
		const input = { findings: [blocker], manifest, checks: [...checks, skipped], config: defaultConfig };
		expect(adjudicate(input)).toMatchObject({ status: "not-reviewed", blocking: true, notRun: [skipped] });
		expect(adjudicate({ ...input, allowSkip: ["static.tsc"] })).toMatchObject({
			status: "findings",
			notRun: [skipped],
		});
		expect(adjudicate({ ...input, findings: [], allowSkip: ["static.tsc"] }).status).toBe("passed");
	});

	it("counts a dismissed finding toward neither status nor blocking", () => {
		const dismissed = finding({ status: "dismissed" });
		const verdict = adjudicate({ findings: [dismissed], manifest, checks, config: defaultConfig });
		expect(verdict).toMatchObject({ status: "passed", blocking: false, dismissed: [resolvedAs(dismissed, "block")] });
	});

	describe("when one report of a defect is dismissed and another is not", () => {
		const fromEslint = (severity: FindingInput["severity"], status?: "dismissed") =>
			finding({
				rule: "detect-eval",
				severity,
				source: { check: "static.eslint" },
				...(status === undefined ? {} : { status }),
			});
		const lensAt = (severity: FindingInput["severity"], status?: "dismissed") =>
			finding({ severity, ...(status === undefined ? {} : { status }) });

		it("keeps the live blocker live and blocking, naming the dismissed report, with no alias", () => {
			const dismissedKeeper = fromEslint("P0", "dismissed");
			const live = lensAt("P1");
			const verdict = adjudicate({ findings: [dismissedKeeper, live], manifest, checks, config: defaultConfig });
			expect(verdict).toMatchObject({ status: "findings", blocking: true });
			expect(verdict.findings.block.map((each) => each.properties.id)).toEqual([live.properties.id]);
			expect(verdict.findings.block[0]!.properties.alsoReportedAs).toEqual([reportOf(dismissedKeeper)]);
			expect(verdict.dismissed.map((each) => each.properties.id)).toEqual([dismissedKeeper.properties.id]);
		});

		it("keeps a live P0 blocking when the alias's owner is a dismissed P3", () => {
			const owned = { ...defaultConfig, ruleAliases: { "no-eval": ["detect-eval"] } };
			const dismissedOwner = lensAt("P3", "dismissed");
			const live = fromEslint("P0");
			const verdict = adjudicate({ findings: [dismissedOwner, live], manifest, checks, config: owned });
			expect(verdict).toMatchObject({ status: "findings", blocking: true });
			expect(verdict.findings.block.map((each) => each.properties.id)).toEqual([live.properties.id]);
			expect(verdict.findings.block[0]!.properties.alsoReportedAs).toEqual([reportOf(dismissedOwner)]);
		});
	});

	it("resolves per path and dedupes across sources", () => {
		const docs = finding({ file: "docs/guide.md", severity: "P1" });
		const eslint = finding({ rule: "detect-eval", severity: "P2", source: { check: "static.eslint" } });
		const lowered = { ...defaultConfig.resolution, P1: "advisory" } as const;
		const configFor = (path: string) => ({
			resolution: path.startsWith("docs/") ? lowered : defaultConfig.resolution,
			ruleAliases: { "no-eval": ["detect-eval"] },
		});
		const verdict = adjudicate({ findings: [docs, eslint, blocker], manifest, checks, config: configFor });
		expect(verdict.findings.advisory.map((each) => each.properties.path)).toEqual(["docs/guide.md"]);
		expect(verdict.findings.block).toHaveLength(1);
		expect(verdict.findings.block[0]!.properties.alsoReportedAs).toEqual([
			{ id: eslint.properties.id, ruleId: "detect-eval", check: "static.eslint" },
		]);
		expect(verdict.findings.acknowledge).toEqual([]);
	});
});
