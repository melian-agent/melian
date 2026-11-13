// Real decided rounds on the fake model, exported as the decision's records. Adapted from issue #373's spike, run.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
	scriptConversations,
	scriptVerifier,
} from "@melian-agent/pipeline/testing";
import type { AdjudicationTaskInput } from "../../packages/pipeline/src/adjudication.ts";
import { VerdictDocument } from "../../packages/pipeline/src/adjudication.ts";
import { FindingsDocument } from "../../packages/pipeline/src/findings.ts";
import type { Harness, TaskId } from "../../packages/pipeline/src/harness.ts";
import { ReviewIndex } from "../../packages/pipeline/src/review-index.ts";
import { verifierMarker } from "../../packages/pipeline/src/verification-instructions.ts";
import { type Envelope, type Json, recordId } from "./envelope.ts";
import type { Rest } from "./reader.ts";

const scratchRoot = "/tmp/claude-0/-home-user-melian/49d5dd77-41ed-5de6-b60b-6b3531f2559a/scratchpad/spike-378";
mkdirSync(scratchRoot, { recursive: true });
export const scratch = mkdtempSync(join(scratchRoot, "run-"));

const env = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_COUNT: "0",
	GIT_AUTHOR_NAME: "Spike",
	GIT_AUTHOR_EMAIL: "spike@melian.invalid",
	GIT_COMMITTER_NAME: "Spike",
	GIT_COMMITTER_EMAIL: "spike@melian.invalid",
	GIT_AUTHOR_DATE: "2026-11-13T00:00:00Z",
	GIT_COMMITTER_DATE: "2026-11-13T00:00:00Z",
};
delete env.MELIAN_STATE_DIR;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
export const user = (body: string) =>
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

export type Session = Awaited<ReturnType<typeof open>>;

export async function open(name: string) {
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

export async function review(session: Session, reports: boolean) {
	const { repo, fake, harness, base, lenses } = session;
	const lens = (name: string) => lenses.find((each) => each.name === name)!;
	scriptConversations(fake, [
		{
			match: lens("correctness").instructions,
			replies: reports ? [report(crashFinding), fauxAssistantMessage("Done.")] : [fauxAssistantMessage("Done.")],
		},
		{ match: lens("contracts").instructions, replies: [fauxAssistantMessage("Done.")] },
		{
			match: verifierMarker,
			replies: Array.from({ length: 8 }, () => (messages: never) => scriptVerifier(messages)),
		},
	]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const finder = fake.ref("finder");
	const judge = fake.ref("judge");
	await reviewChangeset({
		harness,
		checks: [],
		changeset,
		lenses,
		standards: [],
		models: fake.review,
		config: {
			...defaultConfig,
			tiers: { full: lenses.map((each) => `lens.${each.name}`) },
			stages: { "pull-request": "full" },
			models: {
				heavy: { model: `${finder.provider}/${finder.modelId}` },
				verifier: { model: `${judge.provider}/${judge.modelId}` },
			},
		},
	});
	return { revision: Revision.key(changeset.revision), changeset: changeset.id, at: changeset.revision };
}

// The decision's changeset alphabet is lower-case letters, digits, dots and hyphens.
export const changesetName = (id: string) => id.toLowerCase().replace(/[^a-z0-9.-]/g, "-");

export type Exported = { records: Envelope[]; closing: string; closingRecord: Envelope; stored: StoredVerdict };

// One decided round as unsigned records, the closing record last, naming every record and `rounds` before it.
export async function exportRound(
	harness: Harness,
	changeset: string,
	revision: string,
	rounds: string[] = [],
	extra: Record<string, Json> = {},
): Promise<Exported> {
	const root = (await harness.root(context)).id;
	const entry = (await harness.snapshot(ReviewIndex, root, context))?.reviews[revision];
	if (entry?.adjudication === undefined) throw new Error(`no adjudication is indexed for ${revision}`);
	const task = await harness.getTask(entry.adjudication.task as TaskId, context);
	const input = task!.input as unknown as AdjudicationTaskInput;
	const findings = (await harness.snapshot(FindingsDocument, root, context))!;
	const stored = (await harness.snapshot(VerdictDocument, root, context))!.verdicts[revision]!;
	const records: Envelope[] = [];
	const rests: Rest[] = [];
	const cs = changesetName(changeset);
	const add = (kind: string, at: string | undefined, key: string, payload: unknown) => {
		const record: Envelope = {
			v: 1,
			changeset: cs,
			...(at === undefined ? {} : { revision: at }),
			kind,
			key,
			payload: JSON.parse(JSON.stringify(payload)) as Json,
		};
		records.push(record);
		rests.push({ kind, key, id: recordId(record) });
	};
	const previous = findings.revisions.slice(0, findings.revisions.indexOf(revision));
	for (const [id, item] of Object.entries(findings.items)) {
		for (const [at, byProducer] of Object.entries(item.sightings)) {
			if (at !== revision && !previous.includes(at)) continue;
			for (const [producer, sighting] of Object.entries(byProducer))
				add("sighting", at, `${id} ${producer}`, sighting);
		}
		for (const [producer, byVersion] of Object.entries(item.verifications?.[revision] ?? {}))
			for (const [version, verification] of Object.entries(byVersion))
				add("verification", revision, `${id} ${producer} ${version}`, verification);
	}
	for (const [id, link] of Object.entries(findings.inherited?.[revision] ?? {}))
		add("inheritance", revision, id, link);
	for (const check of input.checks) add("check", revision, check.name, check);
	const closingRecord: Envelope = {
		v: 1,
		changeset: cs,
		revision,
		kind: "round",
		key: "round",
		payload: JSON.parse(
			JSON.stringify({
				base: input.base,
				head: input.head,
				manifest: input.manifest,
				allowSkip: input.allowSkip,
				producers: input.producers,
				config: input.config,
				...(input.verificationRan === undefined ? {} : { verificationRan: input.verificationRan }),
				files: input.files ?? [],
				previous,
				rests,
				rounds,
				...extra,
			}),
		) as Json,
	};
	records.push(closingRecord);
	return { records, closing: recordId(closingRecord), closingRecord, stored };
}

// A dismissal of the verdict's first finding, as `melian dismiss` records it, and its payload as section 5 says.
export async function dismissFirst(
	session: Session,
	at: Revision | ReturnType<typeof Revision.from>,
	revision: string,
	changeset: string,
	verdict: StoredVerdict,
) {
	const [finding] = Object.values(verdict.findings).flat();
	const id = finding!.properties.id;
	await recordDismissal({
		harness: session.harness,
		revision: at as never,
		id,
		dismissal: {
			by: "Tal <tal@melian.invalid>",
			reason: "Every user here has a manager.",
			at: "2026-11-12T01:00:00Z",
		},
		repoRoot: session.repo,
	});
	const root = (await session.harness.root(context)).id;
	const { lifecycle } = (await session.harness.snapshot(FindingsDocument, root, context))!.items[id]!;
	const record: Envelope = {
		v: 1,
		changeset: changesetName(changeset),
		kind: "dismissal",
		key: id,
		payload: JSON.parse(
			JSON.stringify({
				by: lifecycle.dismissedBy,
				reason: lifecycle.dismissedReason,
				at: lifecycle.dismissedAt,
				severity: lifecycle.dismissedSeverity,
				sighting: lifecycle.dismissedSighting,
				trigger: lifecycle.dismissedTrigger,
			}),
		) as Json,
	};
	const stored = (await session.harness.snapshot(VerdictDocument, root, context))!.verdicts[revision]!;
	return { id, record, stored };
}

// Moves the head on so the dismissed finding keeps its ID and loses the trigger it was dismissed at.
export function secondHead(session: Session) {
	writeFileSync(
		join(session.repo, "src/user.ts"),
		user("\treturn user.manager.name;\n\t// a caller always sets the manager"),
	);
	git(session.repo, "commit", "--quiet", "--all", "-m", "second head");
}

export { context };
