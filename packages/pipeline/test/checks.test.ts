import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Adjudication,
	Changeset,
	CheckError,
	defaultConfig,
	type EnolaSnapshot,
	type Finding,
	loadConfig,
	normaliseEnolaSarif,
	type RepositorySource,
	type ToolLog,
	ToolManifest,
} from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	type Harness,
	openHarness,
	readCheckRecords,
	readFindings,
	readVerdict,
	reviewChangeset,
	revisionKey,
	runChecks,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChecksDocument } from "../src/checks.ts";
import { findingsVersion } from "../src/findings.ts";
import { Sandbox } from "../src/sandbox.ts";
import * as staticRunner from "../src/static.ts";
import { ToolProvisioning } from "../src/tool-provisioning.ts";
import { commit, createRepository, fakeTool, lines, removeRepository } from "./fixtures/repo.ts";
import { hostSandbox, standInWhereNoSandbox } from "./fixtures/sandbox.ts";

let repo: string;
let opened: Harness[];

beforeEach(() => {
	repo = createRepository();
	opened = [];
	standInWhereNoSandbox();
});

afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	removeRepository(repo);
});

async function open(options: { env?: boolean } = {}) {
	const fake = createFakeModels();
	// The review registry too, so a test can review a changeset with the records its checks left.
	const registry = createReviewRegistry();
	registry.install(checksExtension);
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry,
		env: options.env === false ? undefined : () => createNodeExecutionEnv(repo),
	});
	opened.push(harness);
	return { harness, fake, root: await harness.root(context, { agent: { model: fake.ref() } }) };
}

async function checks(base: string, head: string, tier?: string, options: { env?: boolean } = {}) {
	const { harness, fake, root } = await open(options);
	const changeset = await Changeset.resolve(repo, `${base}..${head}`);
	const source: RepositorySource = { kind: "revision", commit: base };
	const { config } = await loadConfig(repo, source, "");
	const input = { rootConversationId: root.id, changeset, config, source, tier };
	const run = await runChecks(harness, input, context);
	return { harness, fake, root, input, run, records: run.records };
}

function summary(findings: readonly Finding[]) {
	return findings
		.map((finding) => ({
			rule: finding.ruleId,
			file: finding.properties.path,
			line: finding.locations[0]!.physicalLocation.region.startLine,
			cause: finding.properties.cause,
			severity: finding.properties.severity,
		}))
		.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

const tsconfig = JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext" },
});
const fast = lines("tiers:", "  fast: [guardrails, static.biome, static.tsc]");

describe("runChecks", () => {
	it("reports exactly what the head introduced, marks what the base had as pre-existing, and drops what it resolved", {
		timeout: 120_000,
	}, async () => {
		const base = commit(repo, {
			"melian.yaml": fast,
			"tsconfig.json": tsconfig,
			"src/old.ts": lines("export const old: number = 'old';", "debugger;"),
			"src/fixed.ts": lines("export const fixed: number = 'fixed';", "debugger;"),
		});
		const head = commit(repo, {
			// Two lines above the old errors move them down; they stay pre-existing.
			"src/old.ts": lines(
				"export const added: string = 1;",
				"export const loose = (x: number) => x == 1;",
				"export const old: number = 'old';",
				"debugger;",
			),
			"src/fixed.ts": lines("export const fixed: number = 1;"),
		});
		const { harness, root, run, records } = await checks(base, head);
		const findings = await readFindings(harness, root.id, revisionKey({ base, head }), context);
		// Each static record names the tool version its findings name, so a review counts only that version's sightings.
		const versionOf = (prefix: string) =>
			findings.find((finding) => finding.ruleId.startsWith(prefix))!.properties.source.version;
		expect(records).toEqual([
			{ name: "guardrails", status: "ran", findings: 0, notes: [] },
			{
				name: "static.biome",
				status: "ran",
				version: "2.5.15",
				findings: 2,
				notes: [],
				confinement: { confined: true },
			},
			{
				name: "static.tsc",
				status: "ran",
				version: versionOf("tsc/"),
				findings: 2,
				notes: [],
				confinement: { confined: true },
			},
		]);
		expect(summary(findings)).toEqual([
			{ rule: "tsc/TS2322", file: "src/old.ts", line: 1, cause: "introduced", severity: "P1" },
			{ rule: "biome/suspicious/noDoubleEquals", file: "src/old.ts", line: 2, cause: "introduced", severity: "P2" },
			{ rule: "tsc/TS2322", file: "src/old.ts", line: 3, cause: "pre-existing", severity: "P1" },
			{ rule: "biome/suspicious/noDebugger", file: "src/old.ts", line: 4, cause: "pre-existing", severity: "P2" },
		]);
		const biome = findings.find((finding) => finding.ruleId.startsWith("biome/"))!;
		expect(biome.properties.source).toEqual({ check: "static.biome", version: "2.5.15" });
		expect(await readCheckRecords(harness, root.id, run.identity, context)).toEqual(
			Object.fromEntries(records.map((record) => [record.name, record])),
		);
	});

	it("records a failed tool as a failed check, with no findings, while the other checks run", {
		timeout: 120_000,
	}, async () => {
		const base = commit(repo, {
			".gitignore": lines("node_modules"),
			"melian.yaml": lines(
				fast,
				"static:",
				"  biome:",
				"    timeout: 1",
				"guardrails:",
				"  forbidden-paths:",
				"    rules:",
				"      out:",
				"        paths: [dist/**]",
				"        message: built output",
			),
			"tsconfig.json": tsconfig,
		});
		const head = commit(repo, { "dist/a.js": lines("built") });
		fakeTool(
			repo,
			"tsc",
			'if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\necho "segfault"\nexit 139',
		);
		fakeTool(repo, "biome", 'if [ "$1" = "--version" ]; then echo "Version: 0.0.1"; exit 0; fi\nsleep 30');
		const { harness, root, input, records } = await checks(base, head);
		expect(
			records.map((record) => [record.name, record.status, record.status === "failed" ? record.reason : ""]),
		).toEqual([
			["guardrails", "ran", ""],
			["static.biome", "failed", "timeout"],
			["static.tsc", "failed", "toolFailed"],
		]);
		const findings = await readFindings(harness, root.id, revisionKey({ base, head }), context);
		expect(findings.map((finding) => finding.ruleId)).toEqual(["guardrail/forbidden-paths"]);
		// Asking again finds the run already done instead of running the tools a second time.
		expect((await runChecks(harness, input, context)).records).toEqual(records);
		// Asking for a rerun repeats only the failed checks; with the broken tools gone, Melian's own run.
		rmSync(join(repo, "node_modules"), { recursive: true, force: true });
		const { records: rerun } = await runChecks(harness, { ...input, rerunFailed: true }, context);
		expect(rerun.map((record) => [record.name, record.status])).toEqual([
			["guardrails", "ran"],
			["static.biome", "ran"],
			["static.tsc", "ran"],
		]);
		expect(rerun[0]).toEqual(records[0]);
	});

	it("runs again when the policy source differs, rather than returning the earlier run", {
		timeout: 60_000,
	}, async () => {
		const base = commit(repo, { "melian.yaml": lines("tiers:", "  fast: [guardrails]") });
		const head = commit(repo, { "dist/a.js": lines("built") });
		const policy = commit(repo, {
			"melian.yaml": lines(
				"tiers:",
				"  fast: [guardrails]",
				"guardrails:",
				"  forbidden-paths:",
				"    rules:",
				"      out:",
				"        paths: [dist/**]",
				"        message: built output",
			),
		});
		const { harness, input } = await checks(base, head);
		const stricter = { ...input, source: { kind: "revision" as const, commit: policy } };
		expect((await runChecks(harness, stricter, context)).records).toEqual([
			{ name: "guardrails", status: "ran", findings: 1, notes: [] },
		]);
	});

	it("runs again when Melian's tool pins differ, rather than returning the earlier run", {
		timeout: 60_000,
	}, async () => {
		const base = commit(repo, { "melian.yaml": lines("tiers:", "  fast: [guardrails]") });
		const head = commit(repo, { "src/a.ts": lines("a") });
		const { harness, input } = await checks(base, head);
		const first = await runChecks(harness, input, context);
		const text = readFileSync(new URL("../../../tools.yaml", import.meta.url), "utf8");
		const newer = ToolManifest.parse(text.replace("version: 0.4.27", "version: 0.4.28"));
		vi.spyOn(ToolProvisioning, "manifest").mockResolvedValue(newer);
		const second = await runChecks(harness, input, context);
		expect(second.identity.policy).not.toBe(first.identity.policy);
		expect(second.identity.task).not.toBe(first.identity.task);
	});

	it("records a fast and a full run of one head apart", { timeout: 120_000 }, async () => {
		const base = commit(repo, {
			"melian.yaml": lines("tiers:", "  fast: [guardrails]", "  full: [fast, static.biome]"),
		});
		const head = commit(repo, { "src/a.ts": lines("debugger;") });
		const { harness, root, input, run: fast } = await checks(base, head);
		const full = await runChecks(harness, { ...input, tier: "full" }, context);
		expect(Object.keys(await readCheckRecords(harness, root.id, fast.identity, context))).toEqual(["guardrails"]);
		expect(Object.keys(await readCheckRecords(harness, root.id, full.identity, context))).toEqual([
			"guardrails",
			"static.biome",
		]);
		expect(fast.identity).toMatchObject({ head, tier: "fast" });
		expect(full.identity).toMatchObject({ head, tier: "full", policy: fast.identity.policy });
	});

	it("drops a check's earlier findings at the revision when a later run of it fails", {
		timeout: 60_000,
	}, async () => {
		const rule = lines(
			"tiers:",
			"  fast: [guardrails]",
			"guardrails:",
			"  forbidden-paths:",
			"    rules:",
			"      out:",
			"        paths: [dist/**]",
			"        message: built output",
		);
		const base = commit(repo, { "melian.yaml": rule });
		const head = commit(repo, { "dist/a.js": lines("built") });
		const broken = commit(repo, { "melian.yaml": lines(rule, "unknown: key") });
		const { harness, root, input } = await checks(base, head);
		const revision = revisionKey({ base, head });
		expect((await readFindings(harness, root.id, revision, context)).map((finding) => finding.ruleId)).toEqual([
			"guardrail/forbidden-paths",
		]);
		const before = await findingsVersion(harness, root.id, revision, context);
		const failed = await runChecks(harness, { ...input, source: { kind: "revision", commit: broken } }, context);
		expect(failed.records.map((record) => record.status)).toEqual(["failed"]);
		expect(await readFindings(harness, root.id, revision, context)).toEqual([]);
		// A review after the rerun must not attach to an adjudication that read the dropped finding.
		expect(await findingsVersion(harness, root.id, revision, context)).toBeGreaterThan(before);
	});

	it("records checks it does not run, and fails a name that is no check", { timeout: 60_000 }, async () => {
		const base = commit(repo, {
			"melian.yaml": lines("tiers:", "  mine: [guardrails, lens.security, decisions.fast, statik]"),
		});
		const head = commit(repo, { "a.ts": lines("a") });
		const { records } = await checks(base, head, "mine");
		expect(records).toEqual([
			{ name: "guardrails", status: "ran", findings: 0, notes: [] },
			{ name: "lens.security", status: "skipped", reason: "lenses run in the lens step, not as a check task" },
			{ name: "decisions.fast", status: "skipped", reason: "decision-model questions are not built yet" },
			{ name: "statik", status: "failed", reason: "unknownCheck", error: "no check is named statik" },
		]);
	});

	it("fails a static check when the harness has no execution environment", { timeout: 60_000 }, async () => {
		const base = commit(repo, { "melian.yaml": fast });
		const head = commit(repo, { "a.ts": lines("a") });
		const { records } = await checks(base, head, "fast", { env: false });
		expect(
			records.map((record) => [record.name, record.status === "failed" ? record.reason : record.status]),
		).toEqual([
			["guardrails", "ran"],
			["static.biome", "noEnvironment"],
			["static.tsc", "noEnvironment"],
		]);
	});

	it("rejects a tier that does not exist or includes itself", { timeout: 60_000 }, async () => {
		const base = commit(repo, { "melian.yaml": lines("tiers:", "  loop: [again]", "  again: [loop]") });
		const head = commit(repo, { "a.ts": lines("a") });
		for (const [tier, code] of [
			["nope", "unknownTier"],
			["loop", "tierCycle"],
		]) {
			const error = await checks(base, head, tier).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(CheckError);
			expect((error as CheckError).code).toBe(code);
		}
	});
});

describe("runChecks feeding reviewChangeset", () => {
	it("preserves Enola snapshot lineage and coverage IDs through durable checks and verdicts", {
		timeout: 60_000,
	}, async () => {
		const base = commit(repo, {
			"melian.yaml": lines("tiers:", "  fast: [static.enola]", "static:", "  enola:", "    enabled: true"),
			"src/a.ts": "export const a = 1;\n",
		});
		const head = commit(repo, { "src/a.ts": "export const a = 2;\n" });
		const snapshots: EnolaSnapshot[] = [base, head].map((commit, index) => ({
			commit,
			snapshotId: `sha256:${String(index + 1).repeat(64)}`,
			receipt: JSON.stringify({ format_version: 1, snapshot_id: `sha256:${String(index + 1).repeat(64)}` }),
			cacheKey: String(index + 3).repeat(64),
			coverage: { graph: String(index + 5).repeat(64), test: String(index + 7).repeat(64) },
		}));
		const log = normaliseEnolaSarif('{"version":"2.1.0","runs":[{"results":[]}]}', {
			root: repo,
			version: "0.0.1",
		});
		const runner = vi.spyOn(staticRunner, "runStaticTool").mockResolvedValue({
			status: "ran",
			log,
			baseLog: log,
			notes: [],
			snapshots: structuredClone(snapshots),
		});
		try {
			const { harness, fake, root, input, run } = await checks(base, head);
			const record = { name: "static.enola", status: "ran", version: "0.0.1", findings: 0, notes: [], snapshots };
			expect(runner).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ tool: "enola", base, commit: head }),
				expect.anything(),
			);
			expect(run.records).toEqual([record]);
			expect(await readCheckRecords(harness, root.id, run.identity, context)).toEqual({ "static.enola": record });
			const { verdict } = await reviewChangeset({
				harness,
				changeset: input.changeset,
				config: input.config,
				policy: input.source,
				lenses: [],
				standards: [],
				models: fake.review,
				tier: "fast",
				checks: run.records,
			});
			expect(verdict.status).toBe("passed");
			expect(verdict.ran).toEqual([record]);
			const stored = await readVerdict(harness, root.id, revisionKey({ base, head }), context);
			expect(stored?.toJSON().ran).toEqual([record]);
		} finally {
			runner.mockRestore();
		}
	});

	it("passes a clean change under the default fast tier and counts a static finding once the head adds one", {
		timeout: 120_000,
	}, async () => {
		const base = commit(repo, { "tsconfig.json": tsconfig, "src/a.ts": lines("export const a: number = 1;") });
		const clean = commit(repo, { "src/b.ts": lines("export const b: number = 2;") });
		const dirty = commit(repo, { "src/c.ts": lines("export const c = (x: number) => x == 1;") });
		const review = async (head: string) => {
			const { harness, fake, input, run } = await checks(base, head);
			expect(input.config.tiers).toEqual(defaultConfig.tiers);
			return reviewChangeset({
				harness,
				changeset: input.changeset,
				config: input.config,
				policy: input.source,
				lenses: [],
				standards: [],
				models: fake.review,
				tier: "fast",
				checks: run.records,
			});
		};

		// The default fast tier names decisions.fast, an allowed skip while no decision provider is configured. The review
		// records it, as it records lenses, in place of the check runner's record.
		const decisions = {
			name: "decisions.fast",
			status: "skipped",
			reason: "no decision provider is configured",
		};
		expect((await review(clean)).verdict).toMatchObject({ status: "passed", blocking: false, notRun: [decisions] });

		const { verdict } = await review(dirty);
		expect(verdict).toMatchObject({ status: "findings", notRun: [decisions] });
		expect(verdict.findings.acknowledge.map((finding) => finding.ruleId)).toEqual([
			"biome/suspicious/noDoubleEquals",
		]);
	});

	it("resolves a change to a nested melian.yaml under the configuration that judged it, not the file's own", {
		timeout: 60_000,
	}, async () => {
		const base = commit(repo, {
			"melian.yaml": lines("tiers:", "  fast: [guardrails]", "resolution:", "  P2: block"),
			"docs/melian.yaml": lines("resolution:", "  P2: silent"),
		});
		const head = commit(repo, { "docs/melian.yaml": lines("resolution:", "  P2: advisory") });
		const { harness, fake, input, run } = await checks(base, head, "fast");

		const { verdict } = await reviewChangeset({
			harness,
			changeset: input.changeset,
			config: input.config,
			policy: input.source,
			lenses: [],
			standards: [],
			models: fake.review,
			tier: "fast",
			checks: run.records,
		});

		expect(verdict).toMatchObject({ status: "findings", blocking: true });
		expect(verdict.findings.block.map((finding) => [finding.ruleId, finding.properties.path])).toEqual([
			["guardrail/policy-change-review", "docs/melian.yaml"],
		]);
	});
});

describe("runChecks and a tool that links its output to a credential", () => {
	// Runs inside the host's sandbox where there is one, and with the host reader alone where there is none.
	it.each([
		["biome.sarif", "static.biome", 'rm -f "$out"; ln -s "$secret" "$out"; exit 0'],
		[
			"biome.err",
			"static.biome",
			'rm -f "$out" "$(dirname "$out")/biome.err"; ln -s "$secret" "$(dirname "$out")/biome.err"; exit 2',
		],
		["tsc-0.out", "static.tsc", 'rm -f ../tsc-0.out; ln -s "$secret" ../tsc-0.out; exit 3'],
	])(
		"refuses %s and keeps the credential out of the stored record",
		{ timeout: 120_000 },
		async (file, check, attack) => {
			const home = join(dirname(repo), `melian-fake-home-${process.pid}`);
			mkdirSync(home);
			writeFileSync(join(home, "auth.json"), '{"key":"credential-marker"}');
			const base = commit(repo, { ".gitignore": "node_modules\n", "melian.yaml": fast, "tsconfig.json": tsconfig });
			const head = commit(repo, { "src/a.ts": lines("export const a = 1;") });
			const quiet = [
				'if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi',
				'for arg in "$@"; do case "$arg" in --reporter-file=*) out=$(printf %s "$arg" | cut -d= -f2-);; esac; done',
				'[ -z "$out" ] || printf \'%s\' \'{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"Biome"}},"results":[]}]}\' > "$out"',
			];
			const hostile = [quiet[0]!, quiet[1]!, `secret='${home}/auth.json'`, attack];
			fakeTool(repo, "biome", (check === "static.biome" ? hostile : quiet).join("\n"));
			fakeTool(repo, "tsc", (check === "static.tsc" ? hostile : quiet).join("\n"));
			try {
				const { harness, root, records } = await checks(base, head);
				const record = records.find((each) => each.name === check)!;
				expect(record).toMatchObject({ status: "failed", reason: "toolFailed" });
				expect((record as { error: string }).error).toMatch(
					new RegExp(`scratch operation refused .*/${file.replace(".", "\\.")}: .*non-file `),
				);
				expect(records.filter((each) => each.name !== check).map((each) => each.status)).toEqual(["ran", "ran"]);
				const stored = await harness.snapshot(ChecksDocument, root.id, context);
				for (const text of [JSON.stringify(records), JSON.stringify(stored)])
					expect(text).not.toContain("credential-marker");
				// The credential was there to be read: the refusal, not an empty file, kept it out.
				expect(readFileSync(join(home, "auth.json"), "utf8")).toContain("credential-marker");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);
});

describe("runChecks and where a static tool ran", () => {
	const log = (version = "1.0.0"): ToolLog => ({
		version: "2.1.0",
		runs: [{ tool: { driver: { name: "Biome", version } }, results: [] }],
	});
	const inside = { confined: true } as const;
	const outside = (reason: string) => ({ confined: false, reason }) as const;

	// The head's run and the base's run of one check may differ, since each probes the sandbox for itself.
	it.each([
		["both ran confined", inside, inside, inside],
		["only the head ran unconfined", outside("head had none"), inside, outside("head had none")],
		["only the base ran unconfined", inside, outside("base had none"), outside("base had none")],
		["both ran unconfined", outside("head had none"), outside("base had none"), outside("head had none")],
		["neither says", undefined, undefined, undefined],
		["only the base says, and it was unconfined", undefined, outside("base had none"), outside("base had none")],
	] as const)(
		"records the check as unconfined when either revision's run was: %s",
		{ timeout: 60_000 },
		async (_name, head, base, expected) => {
			const first = commit(repo, {
				"melian.yaml": lines("tiers:", "  fast: [static.biome]"),
				"src/a.ts": lines("a"),
			});
			const second = commit(repo, { "src/a.ts": lines("b") });
			vi.spyOn(staticRunner, "runStaticTool").mockImplementation(async (input) => ({
				status: "ran",
				log: log(),
				notes: [],
				...((input.commit === second ? head : base) === undefined
					? {}
					: { confinement: input.commit === second ? head : base }),
			}));
			const { harness, root, records } = await checks(first, second);
			expect(records).toEqual([
				{
					name: "static.biome",
					status: "ran",
					version: "1.0.0",
					findings: 0,
					notes: [],
					...(expected === undefined ? {} : { confinement: expected }),
				},
			]);
			const stored = await harness.snapshot(ChecksDocument, root.id, context);
			expect(Object.values(Object.values(stored!.runs)[0]!)).toEqual(records);
			vi.restoreAllMocks();
		},
	);

	it("leaves a skipped base out of the record's confinement", { timeout: 60_000 }, async () => {
		const first = commit(repo, { "melian.yaml": lines("tiers:", "  fast: [static.biome]"), "src/a.ts": lines("a") });
		const second = commit(repo, { "src/a.ts": lines("b") });
		vi.spyOn(staticRunner, "runStaticTool").mockImplementation(async (input) =>
			input.commit === second
				? { status: "ran", log: log(), notes: [], confinement: inside }
				: { status: "skipped", reason: "nothing to check at the base" },
		);
		expect((await checks(first, second)).records).toMatchObject([{ status: "ran", confinement: inside }]);
		vi.restoreAllMocks();
	});
});

describe("runChecks and a head that names a reviewer's file to a stock tool", () => {
	// The review of record's probe: the head's biome.json extends a file outside the repository, and the real Biome
	// quotes that file in its error. Inside the sandbox Biome cannot open it. Outside one, nothing Biome printed is kept.
	it.each([
		[
			"a JSON credential file",
			"auth.json",
			JSON.stringify({ anthropic: { type: "api_key", key: "FAKE-SECRET-112-KEY" } }, null, 2),
		],
		[
			"a text key file",
			"id_fake",
			"-----BEGIN FAKE PRIVATE KEY-----\nFAKE-SECRET-112-KEY\n-----END FAKE PRIVATE KEY-----\n",
		],
	])("keeps %s out of every output, confined or not", { timeout: 120_000 }, async (_name, file, content) => {
		const outside = join(dirname(repo), `melian-outside-${process.pid}`);
		mkdirSync(outside);
		writeFileSync(join(outside, file), content);
		const base = commit(repo, {
			"melian.yaml": lines("tiers:", "  fast: [static.biome]"),
			"src/a.ts": lines("export const a = 1;"),
		});
		const head = commit(repo, { "biome.json": JSON.stringify({ extends: [join(outside, file)] }) });
		try {
			for (const confined of [true, false]) {
				if (!confined) vi.spyOn(Sandbox, "detect").mockResolvedValue(undefined);
				else if (hostSandbox === undefined) continue;
				const { harness, root, records } = await checks(base, head);
				expect(records).toMatchObject([
					{
						name: "static.biome",
						status: "failed",
						reason: "toolFailed",
						confinement: confined
							? { confined: true }
							: { confined: false, reason: "this host offers no sandbox" },
					},
				]);
				const verdict = new Adjudication({
					findings: [],
					manifest: ["static.biome"],
					checks: records,
					config: defaultConfig,
				}).adjudicate();
				const outputs = {
					record: JSON.stringify(records),
					stored: JSON.stringify(await harness.snapshot(ChecksDocument, root.id, context)),
					terminal: verdict.render(),
					json: verdict.renderJson(),
				};
				for (const [where, text] of Object.entries(outputs))
					expect(text, where).not.toContain("FAKE-SECRET-112-KEY");
				const error = (records[0] as { error: string }).error;
				if (confined) expect(error).toContain("biome exited with code");
				else {
					// The reason code, the exit code, and the fixed sentence, and not one word of Biome's own.
					expect(error).toMatch(
						/^biome exited with code \d+ and (no report|a report): output withheld: the tool ran unconfined$/,
					);
					expect(outputs.terminal).toContain("static.biome  ran unconfined: this host offers no sandbox");
					expect(outputs.json).toContain('"confined": false');
				}
				vi.restoreAllMocks();
			}
			// The file was there to be quoted: outside both, the stock Biome prints it.
			const stock = spawnSync(
				fileURLToPath(new URL("../../../node_modules/.bin/biome", import.meta.url)),
				["lint", "."],
				{
					encoding: "utf8",
					cwd: repo,
				},
			);
			expect(`${stock.stdout}${stock.stderr}`).toContain("FAKE-SECRET-112-KEY");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("says a tool that crashed outside a sandbox ran unconfined, in the record and in every rendering", {
		timeout: 60_000,
	}, async () => {
		const base = commit(repo, { "melian.yaml": lines("tiers:", "  fast: [static.biome]") });
		const head = commit(repo, { "src/a.ts": lines("export const a = 1;") });
		const unconfined = { confined: false, reason: "this host offers no sandbox" } as const;
		vi.spyOn(staticRunner, "runStaticTool").mockRejectedValue(
			new CheckError(
				"toolFailed",
				"static.biome",
				"biome exited with code 70 and no report: output withheld: the tool ran unconfined",
				{
					confinement: unconfined,
				},
			),
		);
		const { records } = await checks(base, head);
		vi.restoreAllMocks();
		expect(records).toEqual([
			{
				name: "static.biome",
				status: "failed",
				reason: "toolFailed",
				error: "biome exited with code 70 and no report: output withheld: the tool ran unconfined",
				confinement: unconfined,
			},
		]);
		const verdict = new Adjudication({
			findings: [],
			manifest: ["static.biome"],
			checks: records,
			config: defaultConfig,
		}).adjudicate();
		expect(verdict.unconfined()).toEqual([{ name: "static.biome", reason: "this host offers no sandbox" }]);
		expect(verdict.render()).toContain(
			"1 check ran outside a sandbox:\n  static.biome  ran unconfined: this host offers no sandbox",
		);
		expect(JSON.parse(verdict.renderJson()).notRun[0].confinement).toEqual(unconfined);
	});
});

describe("runChecks and an unconfined tsc", () => {
	// Base and head are both run with every message replaced by one sentence. The comparison keys a result by its rule,
	// its file, and the code on its lines, so what the head introduced is still told from what the base had.
	it("tells an introduced error from a pre-existing one with every message withheld, and shows nothing it read", {
		timeout: 180_000,
	}, async () => {
		const home = join(dirname(repo), `melian-fake-home-${process.pid}`);
		mkdirSync(home);
		writeFileSync(join(home, "secrets.ts"), 'export const KEY = "FAKE-SECRET-112-KEY";\n');
		const options = JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				module: "NodeNext",
				moduleResolution: "NodeNext",
				target: "ES2022",
				allowImportingTsExtensions: true,
			},
			include: ["src"],
		});
		const base = commit(repo, {
			"melian.yaml": lines("tiers:", "  fast: [static.tsc]"),
			"tsconfig.json": options,
			"src/old.ts": lines("export const old: number = 'old';"),
		});
		const head = commit(repo, {
			"src/new.ts": lines(`import { KEY } from "${join(home, "secrets.ts")}";`, 'export const n: "a" = KEY;'),
			"src/missing.ts": lines('import { gone } from "/opt/shared/missing";', "export const m = gone;"),
		});
		const summarised = async () => {
			const { harness, root, records } = await checks(base, head);
			const findings = await readFindings(harness, root.id, revisionKey({ base, head }), context);
			const verdict = new Adjudication({
				findings,
				manifest: ["static.tsc"],
				checks: records,
				config: defaultConfig,
			}).adjudicate();
			const everything = [
				JSON.stringify(records),
				JSON.stringify(findings),
				JSON.stringify(await harness.snapshot(ChecksDocument, root.id, context)),
				verdict.render(),
				verdict.renderJson(),
			].join("\n");
			return {
				records,
				everything,
				found: summary(findings).map(({ rule, file, cause }) => `${rule} ${file} ${cause}`),
				findings,
			};
		};
		try {
			vi.spyOn(Sandbox, "detect").mockResolvedValue(undefined);
			const unconfined = await summarised();
			vi.restoreAllMocks();
			expect(unconfined.records).toMatchObject([{ status: "ran", findings: 3, confinement: { confined: false } }]);
			expect(unconfined.found).toEqual([
				"tsc/TS2307 src/missing.ts introduced",
				"tsc/TS2322 src/new.ts introduced",
				"tsc/TS2322 src/old.ts pre-existing",
			]);
			for (const finding of unconfined.findings)
				expect(finding.properties.explanation.what).toBe("message withheld: the tool ran unconfined");
			expect(unconfined.everything).not.toContain("FAKE-SECRET");
			// The paths the head's own lines name are the repository's content and show in each finding's snippet; what
			// tsc said of them, and what it read at them, does not.
			expect(unconfined.everything).not.toContain("Cannot find module");
			expect(unconfined.everything).not.toContain("is not assignable");
			// A confined run finds the same three, by the same rules except where the sandbox hid the outside file from tsc.
			if (hostSandbox !== undefined) {
				const confined = await summarised();
				expect(confined.found.map((each) => each.replace(/TS\d+/, "TS"))).toEqual(
					unconfined.found.map((each) => each.replace(/TS\d+/, "TS")),
				);
				expect(confined.everything).not.toContain("FAKE-SECRET");
				expect(confined.everything).toContain("Cannot find module");
			}
		} finally {
			vi.restoreAllMocks();
			rmSync(home, { recursive: true, force: true });
		}
	});
});
