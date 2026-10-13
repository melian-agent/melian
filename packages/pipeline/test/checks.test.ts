import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as core from "@melian-agent/core";
import {
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
	type defineTask,
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
import { fakeMutationProcesses } from "./fixtures/mutation-process.ts";
import { commit, createRepository, fakeTool, lines, removeRepository } from "./fixtures/repo.ts";
import { hostConfinement, unconfinedNotes, unconfinedSandbox } from "./fixtures/sandbox.ts";

let repo: string;
let opened: Harness[];

beforeEach(() => {
	fakeMutationProcesses();
	repo = createRepository();
	opened = [];
});

afterEach(async () => {
	vi.restoreAllMocks();
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
	return { harness, fake, registry, root: await harness.root(context, { agent: { model: fake.ref() } }) };
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
	it("does not claim mutation authority for an unknown tier", async () => {
		vi.spyOn(Sandbox, "detect").mockResolvedValue(unconfinedSandbox);
		const base = commit(repo, { "a.ts": "export const a = 0;\n" });
		const head = commit(repo, { "a.ts": "export const a = 1;\n" });
		const { harness, root } = await open();
		await expect(
			runChecks(
				harness,
				{
					rootConversationId: root.id,
					changeset: await Changeset.resolve(repo, `${base}..${head}`),
					config: {
						...defaultConfig,
						static: { ...defaultConfig.static, mutation: { ...defaultConfig.static.mutation, enabled: true } },
					},
					source: { kind: "revision", commit: base },
					tier: "missing",
				},
				context,
			),
		).rejects.toMatchObject({ code: "unknownTier" });
		const document = await harness.snapshot(ChecksDocument, root.id, context);
		expect(document).toMatchObject({ tasks: expect.any(Object) });
		expect(document).not.toHaveProperty("owners");
	});

	it("propagates an unexpected tier error before starting any task", async () => {
		const base = commit(repo, { "a.ts": "export const a = 0;\n" });
		const head = commit(repo, { "a.ts": "export const a = 1;\n" });
		const { harness, root } = await open();
		const error = new Error("tier reader broke");
		vi.spyOn(core, "checksOfTier").mockImplementationOnce(() => {
			throw error;
		});
		await expect(
			runChecks(
				harness,
				{
					rootConversationId: root.id,
					changeset: await Changeset.resolve(repo, `${base}..${head}`),
					config: defaultConfig,
					source: { kind: "revision", commit: base },
				},
				context,
			),
		).rejects.toBe(error);
		expect(await harness.snapshot(ChecksDocument, root.id, context)).toBeUndefined();
	});

	it("runs a stored check whose checks document is absent", async () => {
		const base = commit(repo, { "a.ts": "export const a = 0;\n" });
		const head = commit(repo, { "a.ts": "export const a = 1;\n" });
		const { harness, root, registry } = await open();
		const check = registry.snapshot().task("melian.check") as ReturnType<
			typeof defineTask<unknown, { phase: "run" }, unknown>
		>;
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		const task = await root.commit(
			(tx) =>
				tx.createTask(
					check,
					{
						check: "guardrails",
						run: "direct",
						authority: "direct",
						changeset: changeset.toJSON(),
						config: defaultConfig,
						source: { kind: "revision", commit: base },
					},
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
		expect(await harness.snapshot(ChecksDocument, root.id, context)).toBeUndefined();
		expect((await harness.waitForTask(task, context)).state.outcome).toMatchObject({
			status: "completed",
			result: { name: "guardrails", status: "ran" },
		});
	});

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
			// Head and base each ran the tool, so a host with no sandbox notes it twice.
			{
				name: "static.biome",
				status: "ran",
				version: "2.5.15",
				findings: 2,
				notes: [...unconfinedNotes("biome"), ...unconfinedNotes("biome")],
				confinement: hostConfinement,
			},
			{
				name: "static.tsc",
				status: "ran",
				version: versionOf("tsc/"),
				findings: 2,
				notes: [...unconfinedNotes("tsc"), ...unconfinedNotes("tsc")],
				confinement: hostConfinement,
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
