import {
	Adjudication,
	type AlsoReportedAs,
	defaultConfig,
	Finding,
	type FindingInput,
	loadConfig,
	type MelianConfig,
	type Resolution,
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalInput } from "./fixtures/findings.ts";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

// As a producer stores it: no resolution until adjudication.
const finding = (input: Partial<FindingInput>) =>
	Finding.create({ ...evalInput, trigger: undefined, resolution: undefined, ...input });
// The findings that speak for each defect, as adjudication merges them under the aliases `configFor` gives each path.
const dedupe = (findings: readonly Finding[], configFor: (path: string) => Pick<MelianConfig, "ruleAliases">) =>
	new Adjudication({
		findings,
		manifest: [],
		checks: [],
		config: (path) => ({ ...defaultConfig, ...configFor(path) }),
	}).dedupe();
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

describe("Finding.resolve", () => {
	it("takes the resolution configured for the severity of an introduced finding", () => {
		expect(finding({ severity: "P0" }).resolve(defaultConfig)).toBe("block");
		expect(finding({ severity: "P2" }).resolve(defaultConfig)).toBe("acknowledge");
		expect(finding({ severity: "nit" }).resolve(defaultConfig)).toBe("silent");
	});

	it("keeps the configured resolution of an affected finding, which carries evidence", () => {
		const affected = finding({ severity: "P1", cause: "affected", evidence: [...renamedParameter] });
		expect(affected.resolve(defaultConfig)).toBe("block");
	});

	it("caps a pre-existing finding at advisory, whatever its severity", () => {
		const strict: MelianConfig = {
			...defaultConfig,
			resolution: { P0: "block", P1: "block", P2: "block", P3: "block", nit: "silent" },
		};
		for (const severity of ["P0", "P1", "P2", "P3"] as const) {
			expect(finding({ severity, cause: "pre-existing" }).resolve(strict)).toBe("advisory");
		}
		expect(finding({ severity: "nit", cause: "pre-existing" }).resolve(strict)).toBe("silent");
	});

	it("never resolves a policy-change-review finding on a melian.yaml below acknowledge", () => {
		const quiet: MelianConfig = { ...defaultConfig, resolution: { ...defaultConfig.resolution, P2: "silent" } };
		const policy = { rule: "guardrail/policy-change-review", severity: "P2" } as const;
		expect(finding({ ...policy, file: "melian.yaml" }).resolve(quiet)).toBe("acknowledge");
		expect(finding({ ...policy, file: "docs/melian.yaml" }).resolve(quiet)).toBe("acknowledge");
		expect(finding({ ...policy, file: "AGENTS.md" }).resolve(quiet)).toBe("silent");
		expect(finding({ severity: "P2", file: "melian.yaml" }).resolve(quiet)).toBe("silent");
		expect(finding({ ...policy, severity: "P1", file: "melian.yaml" }).resolve(defaultConfig)).toBe("block");
	});

	it("decides from severity and cause, never from a resolution the finding already carries", () => {
		expect(finding({ severity: "P0", resolution: "silent" }).resolve(defaultConfig)).toBe("block");
		expect(finding({ severity: "nit", resolution: "block" }).resolve(defaultConfig)).toBe("silent");
	});
});

describe("Finding.resolved under layered configuration", () => {
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

		const resolved = findings.map((each) => each.resolved(((path) => configs.get(path)!)(each.properties.path)));

		expect(resolved.map((each) => each.properties.resolution)).toEqual([
			"acknowledge",
			"advisory",
			"acknowledge",
			"block",
		]);
		expect(findings[1]!.properties.resolution).toBeUndefined();
	});
});

describe("Adjudication.dedupe", () => {
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
		const [kept, ...rest] = dedupe([eslint, lens], () => aliases);

		expect(rest).toEqual([]);
		expect(kept!.properties.id).toBe(lens.properties.id);
		expect(kept!.properties.alsoReportedAs).toEqual([reportOf(eslint)]);
		expect(kept!.properties.alsoReportedAs![0]).toMatchObject({
			ruleId: "security/detect-eval-with-expression",
			check: "static.eslint",
		});
		expect(Finding.parse(kept)).toEqual(kept);
	});

	it("keeps the more severe finding when no alias names an owner", () => {
		const severe = finding({ ...eslintInput, severity: "P0" });
		const deduped = dedupe([lens, severe], () => defaultConfig);
		expect(deduped.map((each) => each.properties.source.check)).toEqual(["static.eslint"]);
		expect(deduped[0]!.properties.alsoReportedAs).toEqual([reportOf(lens)]);
	});

	it("keeps the alias's owner and raises it to the highest severity reported", () => {
		const severe = finding({ ...eslintInput, severity: "P0" });
		const [kept, ...rest] = dedupe([lens, severe], () => aliases);
		expect(rest).toEqual([]);
		expect(kept).toMatchObject({ ruleId: "no-eval", level: "error", properties: { severity: "P0" } });
		expect(Finding.parse(kept)).toEqual(kept);
	});

	it("keeps both at another occurrence or from the same check", () => {
		const second = finding({ ...eslintInput, occurrence: 1 });
		expect(dedupe([second, lens], () => aliases)).toHaveLength(2);
		const sameCheck = finding({ ...eslintInput, source: { check: "lens.security" } });
		expect(dedupe([sameCheck, lens], () => aliases)).toHaveLength(2);
	});

	it("keeps apart two findings whose snippets are cut alike but differ past the cut", () => {
		const long = `const table = [${Array.from({ length: 300 }, (_, index) => `"cell${index}"`).join(", ")}];`;
		const atLine = { startLine: 1, startColumn: undefined, endColumn: undefined };
		const oneLine = finding({ ...atLine, endLine: 1, snippet: long });
		const twoLines = finding({ ...eslintInput, ...atLine, endLine: 2, snippet: `${long}\nrun(table);` });
		expect(oneLine.locations[0]!.physicalLocation.region.snippet).toEqual(
			twoLines.locations[0]!.physicalLocation.region.snippet,
		);
		expect(dedupe([oneLine, twoLines], () => aliases)).toHaveLength(2);
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
			const deduped = dedupe([brokenCaller, unhandledError], () => defaultConfig);
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
				const [kept, ...rest] = dedupe(order, () => defaultConfig);
				expect(rest).toEqual([]);
				expect(kept!.properties).toMatchObject({
					id: unproven.properties.id,
					severity: "P0",
					cause: "affected",
					failureScenario: "A guess.",
					evidence: [...context, ...evidence],
					otherClaims: [claimOf(unproven), claimOf(evidenced)],
				});
				expect(Finding.parse(kept)).toEqual(kept);
				expect(kept!.resolve(defaultConfig)).toBe("block");
			}
		});

		it("lets the alias owner keep its own scenario and evidence when another member proves the cause", () => {
			const owned = { ruleAliases: { "unhandled-error": ["broken-caller"] } };
			const owner = finding({ ...unprovenInput, failureScenario: "The owner's scenario.", severity: "P3" });
			const [kept] = dedupe([evidenced, owner], () => owned);
			expect(kept!.properties).toMatchObject({
				id: owner.properties.id,
				severity: "P1",
				cause: "affected",
				failureScenario: "The owner's scenario.",
				evidence: [...context, ...evidence],
				otherClaims: [claimOf(owner), claimOf(evidenced)],
			});
			expect(kept!.resolve(defaultConfig)).toBe("block");
		});

		it("caps the merged evidence at ten locations and still carries a cause location that proves it", () => {
			const many = Array.from({ length: 10 }, (_, index) => ({
				...context[0]!,
				startLine: index + 1,
				snippet: `line ${index + 1}`,
			}));
			const crowded = finding({ ...unprovenInput, evidence: many });
			const [kept] = dedupe([crowded, evidenced], () => defaultConfig);
			expect(kept!.properties.evidence).toEqual([...many.slice(0, 9), evidence[0]]);
			expect(kept!.properties.otherClaims).toEqual([claimOf(crowded), claimOf(evidenced)]);
			expect(kept!.resolve(defaultConfig)).toBe("block");
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
			const [kept] = dedupe([crowded, twoCauses], () => defaultConfig);
			expect(kept!.properties.cause).toBe("affected");
			expect(kept!.properties.evidence).toEqual([...many.slice(0, 9), proving]);
			expect(kept!.resolve(defaultConfig)).toBe("block");
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
			const [kept] = dedupe([crowded, threeCauses], () => defaultConfig);
			expect(kept!.properties.evidence).toEqual([...many, proving, ownLine]);
			expect(kept!.resolve(defaultConfig)).toBe("block");
		});

		it("counts only a cause location marked as proving once any location is marked, and any one when none is", () => {
			const marked = finding({
				...atCart,
				severity: "P1",
				evidence: [ownLine, { ...context[0]!, proves: true }],
			});
			expect(marked.resolve(defaultConfig)).toBe("advisory");
			const stored = finding({ ...atCart, severity: "P1", evidence: [ownLine] });
			expect(stored.resolve(defaultConfig)).toBe("block");
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
			const [kept] = dedupe([brokenCaller, introduced], () => defaultConfig);
			expect(kept!.properties).toMatchObject({
				id: brokenCaller.properties.id,
				cause: "introduced",
				failureScenario,
				evidence: [...evidence, ...own],
				otherClaims: [claimOf(brokenCaller), claimOf(introduced)],
			});
			expect(Finding.parse(kept)).toEqual(kept);
			const tsc = finding({
				...atCart,
				cause: "introduced",
				evidence: undefined,
				failureScenario: undefined,
				source: { check: "static.tsc" },
			});
			const [plain] = dedupe([brokenCaller, tsc], () => defaultConfig);
			expect(plain!.properties).toMatchObject({ cause: "introduced", failureScenario, evidence });
			expect(plain!.properties).not.toHaveProperty("otherClaims");
		});

		it("carries the claims a merged finding already holds into the next merge", () => {
			const [first] = dedupe([unproven, evidenced], () => defaultConfig);
			const third = finding({
				...atCart,
				severity: "P3",
				failureScenario: "A third view.",
				rule: "null-dereference",
				source: { check: "lens.security", version: "1" },
			});
			const [kept] = dedupe([first!, third], () => defaultConfig);
			expect(kept!.properties.otherClaims).toEqual([claimOf(unproven), claimOf(evidenced), claimOf(third)]);
		});

		it("never merges two rules an alias entry marks distinct", () => {
			const apart = { ruleAliases: { "unhandled-error": { rules: ["broken-caller"], distinct: true } } };
			expect(dedupe([brokenCaller, unhandledError], () => apart)).toHaveLength(2);
			const reversed = { ruleAliases: { "broken-caller": { rules: ["unhandled-error"], distinct: true } } };
			expect(dedupe([unhandledError, brokenCaller], () => reversed)).toHaveLength(2);
		});

		it("keeps the contracts lens's finding when the alias table says the defect is its", () => {
			const owned = { ruleAliases: { "broken-caller": ["unhandled-error"] } };
			for (const order of [
				[brokenCaller, unhandledError],
				[unhandledError, brokenCaller],
			]) {
				const [kept, ...rest] = dedupe(order, () => owned);
				expect(rest).toEqual([]);
				expect(kept!.properties.id).toBe(brokenCaller.properties.id);
				expect(kept!.properties.alsoReportedAs).toEqual([reportOf(unhandledError)]);
			}
		});
	});
});

function reportOf(finding: Finding) {
	const { id, source, severity } = finding.properties;
	return { id, ruleId: finding.ruleId, check: source.check, severity };
}

describe("Adjudication.defects", () => {
	const listing = (each: Finding, alsoReportedAs: AlsoReportedAs[]) =>
		Finding.from({ ...each.toJSON(), properties: { ...each.properties, alsoReportedAs } });

	it("gives each defect the members verdict.defect reads back", () => {
		const lens = finding({ severity: "P1" });
		const eslint = finding({ rule: "detect-eval", severity: "P2", source: { check: "static.eslint" } });
		const elsewhere = finding({ file: "src/other.ts", status: "dismissed" });
		// As a verdict recorded before Melian marked a dismissed report it never absorbed.
		const lone = listing(finding({ file: "src/lone.ts" }), [reportOf(elsewhere)]);
		const gone = listing(finding({ file: "src/gone.ts", status: "dismissed" }), [
			{ ...reportOf(elsewhere), dismissed: true },
		]);
		const adjudication = new Adjudication({
			findings: [lens, eslint, lone, gone, elsewhere],
			manifest: [],
			checks: [],
			config: defaultConfig,
		});
		const verdict = adjudication.adjudicate();
		const defects = adjudication.defects();
		expect(defects.map((defect) => defect.speaker.properties.id)).toEqual(
			[lens, lone, gone, elsewhere].map((each) => each.properties.id),
		);
		for (const defect of defects) {
			expect(defect.members).toEqual(verdict.defect(defect.speaker.properties.id)!.members);
		}
		expect(defects[0]!.members).toEqual([reportOf(eslint)]);
	});
});

describe("Adjudication.adjudicate", () => {
	const ran = (name: string) => ({ name, status: "ran" }) as const;
	const checks = [ran("lens.correctness"), ran("static.biome")];
	const manifest = checks.map((check) => check.name);
	const blocker = finding({ severity: "P1" });
	const advisory = finding({ severity: "P3", rule: "naming" });
	const silent = finding({ severity: "nit", rule: "prefer-const" });

	it("passes when every check ran and nothing is above silent", () => {
		const verdict = new Adjudication({ findings: [silent], manifest, checks, config: defaultConfig }).adjudicate();
		expect(verdict).toMatchObject({ status: "passed", blocking: false, notRun: [] });
		expect(verdict.findings.silent).toEqual([resolvedAs(silent, "silent")]);
	});

	it("reports findings without blocking when nothing resolves to block", () => {
		const verdict = new Adjudication({
			findings: [advisory, silent],
			manifest,
			checks,
			config: defaultConfig,
		}).adjudicate();
		expect(verdict).toMatchObject({ status: "findings", blocking: false });
		expect(verdict.findings.advisory).toEqual([resolvedAs(advisory, "advisory")]);
	});

	it("blocks when a finding resolves to block, and groups by resolution", () => {
		const verdict = new Adjudication({
			findings: [silent, advisory, blocker],
			manifest,
			checks,
			config: defaultConfig,
		}).adjudicate();
		expect(verdict).toMatchObject({ status: "findings", blocking: true });
		expect(Object.keys(verdict.findings)).toEqual(["block", "acknowledge", "advisory", "silent"]);
		expect(verdict.findings.block).toEqual([resolvedAs(blocker, "block")]);
		expect(verdict.findings.acknowledge).toEqual([]);
	});

	it("resolves a finding that arrives without a resolution, rather than drop it or count it silent", () => {
		expect(blocker.properties.resolution).toBeUndefined();
		const verdict = new Adjudication({ findings: [blocker], manifest, checks, config: defaultConfig }).adjudicate();
		expect(verdict).toMatchObject({ status: "findings", blocking: true });
		expect(verdict.findings.block).toEqual([resolvedAs(blocker, "block")]);
		expect(verdict.findings.silent).toEqual([]);
	});

	it("replaces a resolution a finding arrives with", () => {
		const marked = finding({ severity: "P0", resolution: "silent" });
		const verdict = new Adjudication({ findings: [marked], manifest, checks, config: defaultConfig }).adjudicate();
		expect(verdict).toMatchObject({ status: "findings", blocking: true });
		expect(verdict.findings.block).toEqual([resolvedAs(marked, "block")]);
	});

	it("is not reviewed when a check failed, even with no findings", () => {
		const failed = { name: "lens.security", status: "failed", reason: "the lens did not finish" } as const;
		const verdict = new Adjudication({
			findings: [],
			manifest,
			checks: [...checks, failed],
			config: defaultConfig,
		}).adjudicate();
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
		const verdict = new Adjudication({
			findings: [],
			manifest,
			checks: [...checks, ended],
			config: defaultConfig,
			allowSkip: ["lens.correctness"],
		}).adjudicate();
		expect(verdict).toMatchObject({ status: "not-reviewed", notRun: [ended], ran: checks });
	});

	it("keeps the checks that ran, each lens with its level", () => {
		const lens = { name: "lens.correctness", status: "ran", level: "careful" } as const;
		const verdict = new Adjudication({
			findings: [],
			manifest,
			checks: [...checks, lens],
			config: defaultConfig,
		}).adjudicate();
		expect(verdict.ran).toEqual([...checks, lens]);
	});

	it("is not reviewed when a check the manifest names left no record, even with no findings", () => {
		const verdict = new Adjudication({
			findings: [],
			manifest: [...manifest, "guardrails"],
			checks,
			config: defaultConfig,
			allowSkip: ["guardrails"],
		}).adjudicate();
		expect(verdict).toMatchObject({
			status: "not-reviewed",
			blocking: false,
			notRun: [{ name: "guardrails", status: "skipped", reason: "no record" }],
		});
	});

	it("passes when every check of the manifest ran and nothing was found", () => {
		expect(new Adjudication({ findings: [], manifest, checks, config: defaultConfig }).adjudicate().status).toBe(
			"passed",
		);
	});

	it("is not reviewed when a check was skipped without leave, and still says whether it blocks", () => {
		const skipped = { name: "static.tsc", status: "skipped", reason: "no tsconfig.json" } as const;
		const input = { findings: [blocker], manifest, checks: [...checks, skipped], config: defaultConfig };
		expect(new Adjudication(input).adjudicate()).toMatchObject({
			status: "not-reviewed",
			blocking: true,
			notRun: [skipped],
		});
		expect(new Adjudication({ ...input, allowSkip: ["static.tsc"] }).adjudicate()).toMatchObject({
			status: "findings",
			notRun: [skipped],
		});
		expect(new Adjudication({ ...input, findings: [], allowSkip: ["static.tsc"] }).adjudicate().status).toBe(
			"passed",
		);
	});

	it("counts a dismissed finding toward neither status nor blocking", () => {
		const dismissed = finding({ status: "dismissed" });
		const verdict = new Adjudication({ findings: [dismissed], manifest, checks, config: defaultConfig }).adjudicate();
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
			const verdict = new Adjudication({
				findings: [dismissedKeeper, live],
				manifest,
				checks,
				config: defaultConfig,
			}).adjudicate();
			expect(verdict).toMatchObject({ status: "findings", blocking: true });
			expect(verdict.findings.block.map((each) => each.properties.id)).toEqual([live.properties.id]);
			expect(verdict.findings.block[0]!.properties.alsoReportedAs).toEqual([
				{ ...reportOf(dismissedKeeper), dismissed: true },
			]);
			expect(verdict.dismissed.map((each) => each.properties.id)).toEqual([dismissedKeeper.properties.id]);
		});

		it("keeps a live P0 blocking when the alias's owner is a dismissed P3", () => {
			const owned = { ...defaultConfig, ruleAliases: { "no-eval": ["detect-eval"] } };
			const dismissedOwner = lensAt("P3", "dismissed");
			const live = fromEslint("P0");
			const verdict = new Adjudication({
				findings: [dismissedOwner, live],
				manifest,
				checks,
				config: owned,
			}).adjudicate();
			expect(verdict).toMatchObject({ status: "findings", blocking: true });
			expect(verdict.findings.block.map((each) => each.properties.id)).toEqual([live.properties.id]);
			expect(verdict.findings.block[0]!.properties.alsoReportedAs).toEqual([
				{ ...reportOf(dismissedOwner), dismissed: true },
			]);
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
		const verdict = new Adjudication({
			findings: [docs, eslint, blocker],
			manifest,
			checks,
			config: configFor,
		}).adjudicate();
		expect(verdict.findings.advisory.map((each) => each.properties.path)).toEqual(["docs/guide.md"]);
		expect(verdict.findings.block).toHaveLength(1);
		expect(verdict.findings.block[0]!.properties.alsoReportedAs).toEqual([reportOf(eslint)]);
		expect(verdict.findings.acknowledge).toEqual([]);
	});
});
