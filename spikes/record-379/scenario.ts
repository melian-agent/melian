// Issue #379: real reviews on the fake model, across heads, for the cases that need the pipeline's own lifecycle beside
// the computed verdict. Built from spikes/record-373/run.ts, whose functions are not exported.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens, type ProvingHunk, Revision, type StoredVerdict } from "@melian-agent/core";
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
import { VerdictDocument } from "../../packages/pipeline/src/adjudication.ts";
import { FindingsDocument } from "../../packages/pipeline/src/findings.ts";
import { provingHunk, reviewFiles } from "../../packages/pipeline/src/lens-tools.ts";
import { verifierMarker } from "../../packages/pipeline/src/verification-instructions.ts";
import { exportRound } from "../record-373/export.ts";
import { RecordDirectory, type RecordEnvelope, Signer } from "../record-373/record.ts";

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
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

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

// An affected finding: it sits on line 2, which no head changes, and its cause is the changed return on line 7, so its
// dismissal's proof is that hunk and nothing in its own snippet.
const affected = {
	file: "src/user.ts",
	line: 2,
	rule: "null-dereference",
	severity: "P2",
	explanation: {
		what: "User.name is read through a manager this change no longer guards.",
		why: "The return on line 7 dropped its optional chain, so a User without a manager reaches .name on undefined.",
		fix: "Guard the manager before reading its name.",
	},
	failureScenario: 'managerName({ name: "Ada" }) throws reading name of undefined.',
	evidence: [{ file: "src/user.ts", line: 7, role: "cause" }],
};

const report = (args: unknown) =>
	fauxAssistantMessage(fauxToolCall("report_finding", args as never), { stopReason: "toolUse" });

export type Session = Awaited<ReturnType<typeof openSession>>;

// `policy` is the base commit's root melian.yaml, given the session's host key; undefined commits none.
export async function openSession(policy?: (host: { id: string; key: string }) => string) {
	const scratch = mkdtempSync(join(tmpdir(), "spike-379-"));
	const repo = join(scratch, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	git(repo, "init", "--quiet", "--initial-branch=main");
	writeFileSync(join(repo, "src/user.ts"), user('\treturn user.manager?.name ?? "none";'));
	const host = Signer.generate();
	const pinned = { id: host.id, key: host.publicKey.export({ format: "jwk" }).x! };
	if (policy !== undefined) writeFileSync(join(repo, "melian.yaml"), policy(pinned));
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "-m", "base");
	git(repo, "checkout", "--quiet", "-b", "feature");
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
	const records = new RecordDirectory(join(scratch, "records"));
	const hunks = new Map<string, ProvingHunk[]>();
	return {
		scratch,
		repo,
		fake,
		harness,
		base,
		lenses,
		host,
		pinned,
		records,
		hunks,
		close: async () => {
			await harness.close(context);
			rmSync(scratch, { recursive: true, force: true });
		},
	};
}

// Commits `files` as the next head, reviews it with the lens reporting the affected finding, and returns the revision.
export async function reviewHead(session: Session, files: Record<string, string>, message: string) {
	const { repo, fake, harness, base, lenses } = session;
	for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "--allow-empty", "-m", message);
	const lens = (name: string) => lenses.find((each) => each.name === name)!;
	scriptConversations(fake, [
		{ match: lens("correctness").instructions, replies: [report(affected), fauxAssistantMessage("Done.")] },
		{ match: lens("contracts").instructions, replies: [fauxAssistantMessage("Done.")] },
		{
			match: verifierMarker,
			replies: Array.from({ length: 8 }, () => (messages: never) => scriptVerifier(messages)),
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
		config: {
			...defaultConfig,
			tiers: { full: names },
			stages: { "pull-request": "full" },
			models: {
				heavy: { model: `${finder.provider}/${finder.modelId}` },
				verifier: { model: `${judge.provider}/${judge.modelId}` },
			},
		},
	});
	const revision = Revision.key(changeset.revision);
	// The hunks git gives at this head, as the review's own reopen pass reads them.
	session.hunks.set(
		revision,
		reviewFiles(changeset.revision.files).flatMap((file) => file.hunks.map(provingHunk)),
	);
	return { revision, changeset: changeset.id, at: changeset.revision, base };
}

export async function storedVerdict(session: Session, revision: string): Promise<StoredVerdict> {
	const root = (await session.harness.root(context)).id;
	return (await session.harness.snapshot(VerdictDocument, root, context))!.verdicts[revision]!;
}

export async function lifecycleOf(session: Session, id: string) {
	const root = (await session.harness.root(context)).id;
	return (await session.harness.snapshot(FindingsDocument, root, context))!.items[id]!.lifecycle;
}

// Dismisses `id` as `melian dismiss` does, and returns the dismissal as a record with what the lifecycle froze.
export async function dismiss(
	session: Session,
	reviewed: Awaited<ReturnType<typeof reviewHead>>,
	id: string,
): Promise<RecordEnvelope> {
	await recordDismissal({
		harness: session.harness,
		revision: reviewed.at,
		id,
		dismissal: {
			by: "Tal <tal@melian.invalid>",
			reason: "Every user here has a manager.",
			at: "2026-11-13T01:00:00Z",
		},
		repoRoot: session.repo,
	});
	const lifecycle = await lifecycleOf(session, id);
	return session.host.sign({
		v: 1,
		changeset: reviewed.changeset,
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
}

export async function exportAt(session: Session, reviewed: Awaited<ReturnType<typeof reviewHead>>) {
	return exportRound(session.harness, reviewed.changeset, reviewed.revision, session.host, session.records);
}
