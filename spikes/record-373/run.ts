// Spike for issue #373: is the verdict a pure function of the record? Runs decided rounds on the fake model, exports
// each as signed records, computes the verdict from the records alone, and compares it with the one Pi stored.
// Run from the checkout: node --experimental-strip-types --no-warnings --conditions=@melian-agent/source spikes/record-373/run.ts
import { execFileSync } from "node:child_process";
import type { KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens, Revision, type StoredVerdict } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	openHarness,
	recordDismissal,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	type ScriptedReply,
	scriptConversations,
	scriptVerifier,
} from "@melian-agent/pipeline/testing";
import { VerdictDocument } from "../../packages/pipeline/src/adjudication.ts";
import { FindingsDocument } from "../../packages/pipeline/src/findings.ts";
import { verifierMarker } from "../../packages/pipeline/src/verification-instructions.ts";
import { exportRound } from "./export.ts";
import { canonical, RecordDirectory, recordId, Signer } from "./record.ts";
import { computeVerdict } from "./verdict.ts";

const scratch = mkdtempSync(join(tmpdir(), "spike-373-"));
const env = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_COUNT: "0",
	GIT_AUTHOR_NAME: "Spike",
	GIT_AUTHOR_EMAIL: "spike@melian.invalid",
	GIT_COMMITTER_NAME: "Spike",
	GIT_COMMITTER_EMAIL: "spike@melian.invalid",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const user = (body: string) =>
	[
		"export interface User {",
		"\tname: string;",
		"\tmanager?: User;",
		"}",
		"",
		"export function managerName(user: User): string {",
		body,
		"}",
		"",
	].join("\n");

function repository(name: string): string {
	const repo = join(scratch, name);
	mkdirSync(join(repo, "src"), { recursive: true });
	git(repo, "init", "--quiet", "--initial-branch=main");
	writeFileSync(join(repo, "src/user.ts"), user('\treturn user.manager?.name ?? "none";'));
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "-m", "base");
	git(repo, "checkout", "--quiet", "-b", "feature");
	writeFileSync(join(repo, "src/user.ts"), user("\treturn user.manager.name;"));
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "-m", "head");
	return repo;
}

const crashFinding = {
	file: "src/user.ts",
	line: 7,
	rule: "null-dereference",
	severity: "P1",
	explanation: {
		what: "managerName reads name from a manager that may be undefined.",
		why: "This change dropped the optional chain, so a user without a manager throws.",
		fix: "Restore user.manager?.name with a fallback.",
	},
	failureScenario: 'managerName({ name: "Ada" }) throws a TypeError reading name of undefined.',
	evidence: [{ file: "src/user.ts", line: 7, role: "cause" }],
};
const report = (args: unknown) =>
	fauxAssistantMessage(fauxToolCall("report_finding", args as never), { stopReason: "toolUse" });

const host = Signer.generate();
const writer = Signer.generate();
const keys: ReadonlyMap<string, KeyObject> = new Map([
	[host.id, host.publicKey],
	[writer.id, writer.publicKey],
]);

type Scenario = { name: string; reports: boolean; extraCheck: boolean; policy: boolean };

type Session = Awaited<ReturnType<typeof open>>;

async function open(name: string) {
	const repo = repository(name);
	const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	await harness.root(context, { agent: { model: fake.ref("finder") } });
	const base = git(repo, "rev-parse", "main");
	const lenses = (await Lens.load(repo, { kind: "revision", commit: base }, ["src/user.ts"])).filter(
		(lens) => lens.name === "correctness" || lens.name === "contracts",
	);
	return { name, repo, fake, harness, base, lenses };
}

const verify: ScriptedReply = (messages) => scriptVerifier(messages);

// Reviews the session's current head, with the fake model scripted as the scenario says.
async function review(session: Session, scenario: Omit<Scenario, "name">) {
	const { repo, fake, harness, base, lenses } = session;
	const lens = (name: string) => lenses.find((each) => each.name === name)!;
	scriptConversations(fake, [
		{
			match: lens("correctness").instructions,
			replies: scenario.reports
				? [report(crashFinding), fauxAssistantMessage("Done.")]
				: [fauxAssistantMessage("Done.")],
		},
		{ match: lens("contracts").instructions, replies: [fauxAssistantMessage("Done.")] },
		{
			match: verifierMarker,
			replies: Array.from({ length: 8 }, () => verify),
		},
	]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const finder = fake.ref("finder");
	const judge = fake.ref("judge");
	const names = lenses.map((each) => `lens.${each.name}`);
	await reviewChangeset({
		harness,
		checks: [],
		changeset,
		lenses,
		standards: [],
		models: fake.review,
		...(scenario.policy ? { policy: { kind: "revision", commit: base } as const } : {}),
		config: {
			...defaultConfig,
			// A check of the manifest that no record answers leaves the round not reviewed.
			tiers: { full: scenario.extraCheck ? [...names, "guardrails"] : names },
			stages: { "pull-request": "full" },
			models: {
				heavy: { model: `${finder.provider}/${finder.modelId}` },
				verifier: { model: `${judge.provider}/${judge.modelId}` },
			},
		},
	}).catch((error: unknown) =>
		console.log(`  ${session.name}: review threw ${(error as Error).message.slice(0, 200)}`),
	);
	return { revision: Revision.key(changeset.revision), changeset: changeset.id, at: changeset.revision };
}

async function decide(scenario: Scenario) {
	const session = await open(scenario.name);
	return { ...session, ...(await review(session, scenario)) };
}

// Dismisses the verdict's first finding as `melian dismiss` does, and returns the dismissal as a record by `by`, with
// what the lifecycle froze beside it.
async function dismissFirst(run: Awaited<ReturnType<typeof decide>>, verdict: StoredVerdict, by: Signer) {
	const [finding] = Object.values(verdict.findings).flat();
	const id = finding!.properties.id;
	await recordDismissal({
		harness: run.harness,
		revision: run.at,
		id,
		dismissal: {
			by: "Tal <tal@melian.invalid>",
			reason: "Every user here has a manager.",
			at: "2026-11-12T01:00:00Z",
		},
		repoRoot: run.repo,
	});
	const root = (await run.harness.root(context)).id;
	const { lifecycle } = (await run.harness.snapshot(FindingsDocument, root, context))!.items[id]!;
	const record = by.sign({
		v: 1,
		changeset: run.changeset,
		kind: "dismissal",
		key: id,
		payload: structuredClone({
			by: lifecycle.dismissedBy,
			reason: lifecycle.dismissedReason,
			at: lifecycle.dismissedAt,
			severity: lifecycle.dismissedSeverity,
			sighting: lifecycle.dismissedSighting,
			trigger: lifecycle.dismissedTrigger,
		}) as never,
	});
	const stored = (await run.harness.snapshot(VerdictDocument, root, context))!.verdicts[run.revision]!;
	return { id, record, stored };
}

const same = (a: StoredVerdict, b: StoredVerdict) => canonical(a) === canonical(b);
const results: { pass: string; ok: boolean; evidence: string }[] = [];
const outside = new Set<string>();

async function scenario(name: string, options: Omit<Scenario, "name">) {
	const decided = await decide({ name, ...options });
	const records = new RecordDirectory(join(scratch, name, ".records"));
	const exported = await exportRound(decided.harness, decided.changeset, decided.revision, host, records);
	const computed = (await computeVerdict(records.list(), keys, decided.revision, decided.repo))!;
	for (const each of computed.outside) outside.add(each);
	return { ...decided, records, exported, computed };
}

// 1. A round that passes, one with a blocking finding, and one that is not reviewed.
for (const [name, options] of [
	["passes", { reports: false, extraCheck: false, policy: false }],
	["blocks", { reports: true, extraCheck: false, policy: true }],
	["not-reviewed", { reports: false, extraCheck: true, policy: false }],
] as const) {
	const run = await scenario(name, options);
	console.log(`  ${name}: stored ${run.exported.stored.status}, computed ${run.computed.verdict.status}`);
	results.push({
		pass: `computed equals stored: ${name}`,
		ok: same(run.computed.verdict, run.exported.stored),
		evidence: `stored ${run.exported.stored.status}, computed ${run.computed.verdict.status}, ${run.exported.records} records`,
	});
	await run.harness.close(context);
}

// 2. A dismissal added as one more record, by another signer, changes the verdict as `melian dismiss` does.
{
	const run = await scenario("dismissed", { reports: true, extraCheck: false, policy: false });
	const before = run.computed.verdict;
	console.log(
		`  dismissed: stored ${run.exported.stored.status}, computed ${before.status}, findings ${JSON.stringify(Object.fromEntries(Object.entries(before.findings).map(([k, v]) => [k, v.length])))}`,
	);
	const dismissed = await dismissFirst(run, before, writer);
	const dismissal = dismissed.record;
	const finding = { properties: { id: dismissed.id } };
	run.records.add(dismissal);
	const after = (await computeVerdict(run.records.list(), keys, run.revision, run.repo))!;
	const storedAfter = dismissed.stored;
	results.push({
		pass: "a dismissal record by another signer changes the computed verdict as melian dismiss changes the stored one",
		ok: before.status !== after.verdict.status && same(after.verdict, storedAfter),
		evidence: `before ${before.status}, computed after ${after.verdict.status}, stored after ${storedAfter.status}; signer ${writer.id} beside host ${host.id}`,
	});

	// 4. Two different records under one kind and key, from two writers: both orders of arrival agree.
	const rival = host.sign({
		v: 1,
		changeset: run.changeset,
		kind: "dismissal",
		key: finding!.properties.id,
		payload: { ...(dismissal.payload as object), reason: "Managers are always set by the loader." } as never,
	});
	const all = [...run.records.list(), rival];
	const forward = (await computeVerdict(all, keys, run.revision, run.repo))!;
	const backward = (await computeVerdict([...all].reverse(), keys, run.revision, run.repo))!;
	const winner = [recordId(dismissal), recordId(rival)].sort()[0];
	const reason = forward.verdict.dismissed.find((each) => each.properties.id === finding!.properties.id)?.properties
		.dismissal?.reason;
	results.push({
		pass: "two records under one kind and key, from two writers, give one verdict in either order of arrival",
		ok: same(forward.verdict, backward.verdict),
		evidence: `lowest ID ${winner!.slice(0, 12)} is the ${winner === recordId(dismissal) ? "writer's" : "host's"}; the verdict carries its reason, "${reason}"`,
	});

	// 3. A round whose closing record names a record that is absent reads as not reviewed.
	const sighting = run.records.list().find((each) => each.kind === "sighting")!;
	unlinkSync(join(run.records.path, `${recordId(sighting)}.json`));
	const missing = (await computeVerdict(run.records.list(), keys, run.revision, run.repo))!;
	results.push({
		pass: "a round that names an absent record reads as not reviewed",
		ok: missing.verdict.status === "not-reviewed" && missing.absent.length === 1,
		evidence: `removed ${sighting.kind} ${sighting.key.split(" ").slice(1).join(" ")}; computed ${missing.verdict.status}`,
	});

	// A record by an unknown key never counts, so a forged dismissal changes nothing.
	const stranger = Signer.generate();
	const { signer: _, signature: __, ...unsigned } = dismissal;
	const forged = stranger.sign(unsigned);
	const withForged = (await computeVerdict([...run.records.list(), forged], keys, run.revision, run.repo))!;
	results.push({
		pass: "(extra) a record signed by an unlisted key changes nothing",
		ok: same(withForged.verdict, missing.verdict),
		evidence: `signer ${stranger.id} is not among the trusted keys`,
	});
	await run.harness.close(context);
}

// 5. A dismissal record outlives the code it accepted. The second head keeps line 7, so the finding keeps its ID, and
// adds a line to its hunk, so the trigger the dismissal accepted is gone and Pi reopens it.
{
	const run = await scenario("reopened", { reports: true, extraCheck: false, policy: false });
	const dismissed = await dismissFirst(run, run.computed.verdict, writer);
	run.records.add(dismissed.record);
	writeFileSync(
		join(run.repo, "src/user.ts"),
		user("\treturn user.manager.name;\n\t// a caller always sets the manager"),
	);
	git(run.repo, "commit", "--quiet", "--all", "-m", "second head");
	const second = await review(run, { reports: true, extraCheck: false, policy: false });
	const exported = await exportRound(run.harness, second.changeset, second.revision, host, run.records);
	const blind = (await computeVerdict(run.records.list(), keys, second.revision, run.repo))!;
	const ruled = (await computeVerdict(run.records.list(), keys, second.revision, run.repo, { reopen: true }))!;
	const id = dismissed.id;
	results.push({
		pass: "(extra) without the lifecycle's reopen rule, a dismissal record outlives the code it accepted",
		ok: !same(blind.verdict, exported.stored),
		evidence: `stored ${exported.stored.status}, computed ${blind.verdict.status}; finding ${id} keeps its ID at the second head`,
	});
	results.push({
		pass: "(extra) the same, computed with the lifecycle's reopen rule",
		ok: same(ruled.verdict, exported.stored),
		evidence: `stored ${exported.stored.status}, computed ${ruled.verdict.status}`,
	});
	for (const each of ruled.outside) outside.add(each);
	if (!same(ruled.verdict, exported.stored)) {
		const [a] = Object.values(ruled.verdict.findings).flat();
		const [b] = Object.values(exported.stored.findings).flat();
		for (const key of new Set([...Object.keys(a!.properties), ...Object.keys(b!.properties)]))
			if (canonical((a!.properties as never)[key]) !== canonical((b!.properties as never)[key]))
				console.log(
					`  differs in ${key}: computed ${canonical((a!.properties as never)[key])} stored ${canonical((b!.properties as never)[key])}`.slice(
						0,
						400,
					),
				);
	}
	await run.harness.close(context);
}

for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.pass}\n      ${result.evidence}`);
console.log(`read outside the record: ${[...outside].join("; ") || "nothing"}`);
rmSync(scratch, { recursive: true, force: true });
process.exit(results.every((result) => result.ok) ? 0 : 1);
