import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Changeset,
	canonicalJson,
	evaluateGuardrails,
	loadConfig,
	type RepositorySource,
	Revision,
	recordLimit,
	reviewPayloads,
	type StoredFinding,
	sharedCopyTrimmed,
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
	relayLimits,
	runChecks,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FindingsDocument, producerSightings } from "../../pipeline/src/findings.ts";
import { ReviewRecords } from "../../pipeline/src/review-records.ts";
import { commit, createRepository, lines, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import { Remote } from "../../state-git/test/fixtures/remote.ts";

// Issue #605's example, scaled: each workspace manifest's notice names ten changed and ten removed scripts of 100
// characters, so 1,700 of them pass the budget with their detail and fit it with most of it left out. The root
// manifest's `check` script changes too. Its notice's ID, fixed by its path, sorts past the cut at 1,700 and not at 1,500.
const packages = 1700;
const name = (index: number) => `script-${String(index).padStart(2, "0")}-`.padEnd(100, "x");
const manifest = (scripts: Record<string, string>) => JSON.stringify({ scripts }, undefined, 2);
const all = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [name(index), "vitest --run"]));
const some = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [name(index), "true"]));
const tree = (scripts: Record<string, string>) =>
	Object.fromEntries(
		Array.from({ length: packages }, (_, index) => [
			`packages/p${String(index).padStart(4, "0")}/package.json`,
			manifest(scripts),
		]),
	);

const root = (check: string) => lines(JSON.stringify({ workspaces: ["packages/*"], scripts: { check } }));

let repo: string;
let harness: Harness;
let remote: Remote;

beforeAll(async () => {
	repo = createRepository();
	commit(repo, {
		// Every stage runs the guardrails alone, so a review asks no model, and the base trusts writers, so it exports.
		"melian.yaml": lines(
			"tiers:",
			"  fast: [guardrails]",
			"  standard: [guardrails]",
			"  full: [guardrails]",
			"trust:",
			"  writers: true",
		),
		"package.json": root("vitest --run"),
		...tree(all),
	});
	commit(repo, { "package.json": root("true"), ...tree(some) });
	const registry = createReviewRegistry();
	registry.install(checksExtension);
	harness = await openHarness(createMemoryStorage(), {
		models: createFakeModels().models,
		registry,
		env: () => createNodeExecutionEnv(repo),
	});
	remote = await Remote.create();
});

afterAll(async () => {
	await harness.close(context);
	await remote.close();
	removeRepository(repo);
});

// What decides whether a finding blocks, by its ID.
const blocking = (each: readonly StoredFinding[]) =>
	Object.fromEntries(each.map(({ properties }) => [properties.id, [properties.severity, properties.resolution]]));
const ids = (each: readonly StoredFinding[]) => each.map(({ properties }) => properties.id).sort();
const explanations = (each: readonly StoredFinding[]) =>
	Object.fromEntries(each.map(({ properties }) => [properties.id, properties.explanation]));

describe("a guardrails record past the store's limit", { timeout: 600_000 }, () => {
	it("is trimmed to fit, and the git store takes it whole with every ID and the blocking set kept", async () => {
		const changeset = await Changeset.resolve(repo, "HEAD~1..HEAD");
		const source: RepositorySource = { kind: "revision", commit: changeset.revision.base };
		const untrimmed = await evaluateGuardrails({ repoRoot: repo, revision: changeset.revision, source });
		const notices = untrimmed.findings.map((finding) => finding.toJSON());
		expect(notices).toHaveLength(packages + 1);
		expect(Buffer.byteLength(canonicalJson(notices))).toBeGreaterThan(recordLimit);

		const { config } = await loadConfig(repo, source, "");
		const root = await harness.root(context);
		const run = await runChecks(
			harness,
			{ rootConversationId: root.id, changeset, config, source, tier: "fast" },
			context,
		);
		const state = await harness.snapshot(FindingsDocument, root.id, context);
		const sightings = producerSightings(state!, Revision.key(changeset.revision), { check: "guardrails" });
		const result = (await readCheckRecords(harness, root.id, run.identity, context)).guardrails!;
		const { record, trimmed } = ReviewRecords.of(changeset.id, changeset.revision).fittedCheck(
			run.request,
			result,
			sightings,
		);

		expect(trimmed).toBe(true);
		expect(Buffer.byteLength(record.bytes)).toBeLessThanOrEqual(relayLimits.fileBytes);
		// The local findings stay whole; only the shared copy leaves out detail.
		expect(explanations(sightings)).toEqual(explanations(notices));
		const shared = (record.payload as { sightings: StoredFinding[] }).sightings;
		expect(ids(shared)).toEqual(ids(notices));
		expect(blocking(shared)).toEqual(blocking(notices));
		const left = shared.filter(({ message, properties }) => properties.explanation.what === message.text);
		expect(left.length).toBeGreaterThan(0);
		expect(left.length).toBeLessThan(packages);
		expect(new Set(left.map(({ properties }) => properties.explanation.whyHere))).toEqual(
			new Set([
				`Melian left out the detail for ${left.length} more files to keep this record under its limit; \`git diff\` shows those files.`,
			]),
		);
		// The root's changed gate script reads, cut, as any other manifest's changed script does.
		const top = shared.find(({ properties }) => properties.path === "package.json")!;
		expect(left).toContain(top);
		expect(top.message.text).toBe(
			"Review the change to package.json, which configures the packages Biome and tsc load. The head changes npm scripts.",
		);
		expect(
			new Set(left.filter((each) => each !== top).map(({ message }) => message.text.replace(/^.* load\. /, ""))),
		).toEqual(new Set(["The head changes npm scripts and removes npm scripts."]));
		const store = await remote.open({ payloads: reviewPayloads });
		await store.add([record.toJSON()]);
		expect((await store.list(changeset.id)).map((each) => canonicalJson(each))).toEqual([record.bytes]);
	});
});

describe("a review whose shared copy was trimmed", { timeout: 900_000 }, () => {
	const bin = fileURLToPath(new URL("../bin/melian.js", import.meta.url));
	const scratch = mkdtempSync(join(tmpdir(), "melian-trimmed-"));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));
	const script = join(scratch, "script.json");
	writeFileSync(script, "{}");
	const melian = (...args: string[]) => {
		const { MELIAN_STATE_DIR: _, ...rest } = process.env;
		const result = spawnSync(process.execPath, [bin, ...args], {
			cwd: repo,
			encoding: "utf8",
			env: {
				...rest,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_COUNT: "0",
				NO_COLOR: "1",
				XDG_CONFIG_HOME: scratch,
				MELIAN_TEST_SCRIPT: script,
			},
			timeout: 600_000,
			maxBuffer: 256 * 1024 * 1024,
		});
		return { status: result.status, stdout: result.stdout.replace(/\s+/g, " "), stderr: result.stderr };
	};

	it("says so in melian review and melian findings, without --notes", () => {
		const review = melian("review", "HEAD~1..HEAD", "--records", `dir:${join(scratch, "records")}`);
		expect(review.stderr).not.toContain("records not exported");
		expect(review.status).toBe(1);
		expect(review.stdout).toContain(`guardrails: ${sharedCopyTrimmed}`);
		const findings = melian("findings", "HEAD~1..HEAD");
		expect(findings.status).toBe(0);
		expect(findings.stdout).toContain(`guardrails: ${sharedCopyTrimmed}`);
	});
});
