import { CheckError, type Finding, loadConfig, type RepositorySource, resolveRange } from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createRegistry,
	type Harness,
	openHarness,
	readCheckRecords,
	readFindings,
	runChecks,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commit, createRepository, fakeTool, lines, removeRepository } from "./fixtures/repo.ts";

let repo: string;
let opened: Harness[];

beforeEach(() => {
	repo = createRepository();
	opened = [];
});

afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	removeRepository(repo);
});

async function open(options: { env?: boolean } = {}) {
	const fake = createFakeModels();
	const registry = createRegistry();
	registry.install(checksExtension);
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry,
		env: options.env === false ? undefined : () => createNodeExecutionEnv(repo),
	});
	opened.push(harness);
	return { harness, root: await harness.root(context, { agent: { model: fake.ref() } }) };
}

async function checks(base: string, head: string, tier?: string, options: { env?: boolean } = {}) {
	const { harness, root } = await open(options);
	const changeset = await resolveRange(repo, `${base}..${head}`);
	const source: RepositorySource = { kind: "revision", commit: base };
	const { config } = await loadConfig(repo, source, "");
	const input = { rootConversationId: root.id, changeset, config, source, tier };
	return { harness, root, input, records: await runChecks(harness, input, context) };
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
		const { harness, root, records } = await checks(base, head);
		expect(records).toEqual([
			{ check: "guardrails", status: "ran", findings: 0, notes: [] },
			{ check: "static.biome", status: "ran", findings: 2, notes: [] },
			{ check: "static.tsc", status: "ran", findings: 2, notes: [] },
		]);
		const findings = await readFindings(harness, root.id, context);
		expect(summary(findings)).toEqual([
			{ rule: "tsc/TS2322", file: "src/old.ts", line: 1, cause: "introduced", severity: "P1" },
			{ rule: "biome/suspicious/noDoubleEquals", file: "src/old.ts", line: 2, cause: "introduced", severity: "P2" },
			{ rule: "tsc/TS2322", file: "src/old.ts", line: 3, cause: "pre-existing", severity: "P1" },
			{ rule: "biome/suspicious/noDebugger", file: "src/old.ts", line: 4, cause: "pre-existing", severity: "P2" },
		]);
		const biome = findings.find((finding) => finding.ruleId.startsWith("biome/"))!;
		expect(biome.properties.source).toEqual({ check: "static.biome", version: "2.5.15" });
		expect(await readCheckRecords(harness, root.id, head, context)).toEqual(
			Object.fromEntries(records.map((record) => [record.check, record])),
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
			records.map((record) => [record.check, record.status, record.status === "failed" ? record.error.code : ""]),
		).toEqual([
			["guardrails", "ran", ""],
			["static.biome", "failed", "timeout"],
			["static.tsc", "failed", "toolFailed"],
		]);
		const findings = await readFindings(harness, root.id, context);
		expect(findings.map((finding) => finding.ruleId)).toEqual(["guardrail/forbidden-paths"]);
		// Asking again finds the run already done instead of running the tools a second time.
		expect(await runChecks(harness, input, context)).toEqual(records);
	});

	it("records checks it does not run, and fails a name that is no check", { timeout: 60_000 }, async () => {
		const base = commit(repo, {
			"melian.yaml": lines("tiers:", "  mine: [guardrails, lens.security, decisions.fast, statik]"),
		});
		const head = commit(repo, { "a.ts": lines("a") });
		const { records } = await checks(base, head, "mine");
		expect(records).toEqual([
			{ check: "guardrails", status: "ran", findings: 0, notes: [] },
			{ check: "lens.security", status: "skipped", reason: "lenses run in the lens step, not as a check task" },
			{ check: "decisions.fast", status: "skipped", reason: "decision-model questions are not built yet" },
			{ check: "statik", status: "failed", error: { code: "unknownCheck", message: "no check is named statik" } },
		]);
	});

	it("fails a static check when the harness has no execution environment", { timeout: 60_000 }, async () => {
		const base = commit(repo, { "melian.yaml": fast });
		const head = commit(repo, { "a.ts": lines("a") });
		const { records } = await checks(base, head, "fast", { env: false });
		expect(
			records.map((record) => [record.check, record.status === "failed" ? record.error.code : record.status]),
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
