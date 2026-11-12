// Spike for issue #369: what is the record, and how big is it? Reviews a small pull-request changeset on the fake model
// with three lenses' findings, a verification, a dismissal and a publication through the fake GitHub, into SQLite. Then
// sorts every document and task the store holds into the record or working state, exports the record as #368's
// envelopes, and measures both.
// Run from the checkout: node --experimental-strip-types --no-warnings --conditions=@melian-agent/source spikes/record-369/run.ts
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGitHubProvider } from "@melian-agent/github";
import { backgroundContext as context, publishReview, ReviewError, recordDismissal } from "@melian-agent/pipeline";
import { fakeGitHub } from "../../packages/github/test/fixtures/fake-github.ts";
import {
	emptyName,
	isolatedGitEnv,
	lensScript,
	moveTo,
	nanRetries,
	openPublishHarness,
	pullRequestState,
	reviewScenario,
	scenarioModels,
	scenarioRepository,
	unsafeManager,
} from "../../packages/github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../../packages/pipeline/src/adjudication.ts";
import { openSqliteStorage } from "../../packages/pipeline/src/harness.ts";
import { canonical, type Json, Signer } from "./record.ts";

Object.assign(process.env, isolatedGitEnv);
const scratch = mkdtempSync(join(tmpdir(), "spike-369-"));
const database = join(scratch, "store.sqlite");

// 1. A scripted review of pull request #7: correctness reports three findings, contracts none; the verifier judges
// each; the maintainer dismisses one; the review is published to the fake GitHub.
const repo = scenarioRepository();
const fake = scenarioModels();
const state = pullRequestState();
const github = createGitHubProvider({
	owner: state.owner,
	repo: state.repo,
	token: "test-token",
	fetch: fakeGitHub(state),
});
const harness = await openPublishHarness(await openSqliteStorage(database), fake, github);
const { changeset, review } = await reviewScenario(repo, harness, fake, {
	...lensScript(unsafeManager, emptyName, nanRetries),
});
const reviewed = await review.catch((error: unknown) => {
	if (!(error instanceof ReviewError)) throw error;
	return undefined;
});
const revision = `${changeset.revision.base}..${changeset.revision.head}`;
const root = (await harness.root(context)).id;
const before = (await harness.snapshot(VerdictDocument, root, context))!.verdicts[revision]!;
const live = Object.values(before.findings).flat();
const target = live.find((each) => each.properties.severity === "P2") ?? live[0]!;
await recordDismissal({
	harness,
	revision: changeset.revision,
	id: target.properties.id,
	dismissal: {
		by: "Tal <tal@melian.invalid>",
		reason: "An empty name is refused upstream.",
		at: "2026-11-12T02:00:00Z",
	},
	repoRoot: repo,
});
moveTo(state, changeset);
const publication = await publishReview({
	harness,
	provider: github,
	changeset,
	pullRequest: await github.pullRequest(7),
	base: changeset.revision.base,
	trustedWriters: true,
});
const after = (await harness.snapshot(VerdictDocument, root, context))!.verdicts[revision]!;
const ran = (after.ran ?? []).map((check) => `${check.name}:${check.status}`).join(", ");
await harness.close(context);
console.log(
	`review: ${reviewed === undefined ? "threw" : "returned"}; verdict ${before.status} -> ${after.status} after dismissing ${target.properties.id}; ran ${ran}`,
);
console.log(
	`published: ${publication.posted ?? "?"} posts; fake GitHub holds ${state.reviews.length} reviews, ${state.comments.length} comments, ${state.ledgers.length} ledgers`,
);

// 2. Read the closed store directly. Pi keeps every document's history as base and delta revisions.
const db = new DatabaseSync(database, { readOnly: true });
const bytes = (path: string) => {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
};
const files = bytes(database) + bytes(`${database}-wal`) + bytes(`${database}-shm`);
type Row = Record<string, number | string | null>;
const rows = (sql: string) => db.prepare(sql).all() as Row[];
const tables = rows(
	`SELECT 'conversations' AS t, COUNT(*) AS n, COALESCE(SUM(LENGTH(record)), 0) AS b FROM conversations
	 UNION ALL SELECT 'entries', COUNT(*), COALESCE(SUM(LENGTH(record)), 0) FROM entries
	 UNION ALL SELECT 'tasks', COUNT(*), COALESCE(SUM(LENGTH(record)), 0) FROM tasks
	 UNION ALL SELECT 'submissions', COUNT(*), COALESCE(SUM(LENGTH(record)), 0) FROM submissions
	 UNION ALL SELECT 'documents', COUNT(*), COALESCE(SUM(LENGTH(record)), 0) FROM documents
	 UNION ALL SELECT 'document_revisions', COUNT(*), COALESCE(SUM(LENGTH(content)), 0) FROM document_revisions`,
);
const documents = rows(
	`SELECT d.kind AS kind, d.scope_kind AS scope, COUNT(DISTINCT d.id) AS docs, COUNT(r.seq) AS revisions,
	        COALESCE(SUM(LENGTH(r.content)), 0) AS history
	 FROM documents d LEFT JOIN document_revisions r ON r.document_id = d.id GROUP BY d.kind, d.scope_kind ORDER BY d.kind`,
);
const tasks = rows(
	"SELECT kind, COUNT(*) AS n, COALESCE(SUM(LENGTH(record)), 0) AS b FROM tasks GROUP BY kind ORDER BY kind",
);
const scopes = rows("SELECT DISTINCT scope_kind AS kind, owner_id AS owner FROM documents");
db.close();
// The current value of every document, as Pi reads it, through storage's detached reads: no harness, no hand-parsed
// revisions.
const storage = await openSqliteStorage(database);
const latest = new Map<string, unknown[]>();
for (const scope of scopes) {
	const owner = Number(scope.owner);
	const query = {
		at: "current" as const,
		scope:
			scope.kind === "session"
				? ({ kind: "session" } as const)
				: scope.kind === "task"
					? ({ kind: "task", taskId: owner } as never)
					: ({ kind: "conversation", conversationId: owner } as never),
	};
	let cursor: unknown;
	do {
		const page = await storage.scanDocuments(query, 200, cursor as never, context);
		for (const record of page.items) {
			const document = await storage.document(record.id, "current", context);
			if (document !== undefined) latest.set(record.kind, [...(latest.get(record.kind) ?? []), document.value]);
		}
		cursor = page.next;
	} while (cursor !== undefined);
}
await storage.close(context);

// 3. Sort each kind. A record kind and key, or why it is working state, and whether it is neither cleanly.
type Sort = { becomes: string; mixed?: string };
const sorting: Record<string, Sort> = {
	"melian.findings": {
		becomes:
			"record: `sighting` by revision, finding and producer; `verification` by revision, claim and verifier version; `dismissal` by finding; `inheritance` by revision and finding",
		mixed: "rewritten in place: a lens rerun replaces its sighting, a dismissal or reopen rewrites the lifecycle, and `versions` counts writes for attachment, which is run state",
	},
	"melian.checks": {
		becomes: "record: `check` by revision and check name, from each run's records",
		mixed: "keyed by run identity, which holds the task ID, so the record must drop the task and keep the run's inputs",
	},
	"melian.verdicts": {
		becomes:
			"derived: the verdict is computed from the record (#373); provenance, run details and the walkthrough become `round` and `walkthrough` records",
		mixed: "rewritten in place per revision, and `decisions` names the adjudication task and the findings version it read",
	},
	"melian.rounds": {
		becomes: "record: `round` by revision and round number, the closing record",
		mixed: "the storage-wide counter and each revision's current-round pointer are rewritten in place; only the minted rounds are facts",
	},
	"melian.published": {
		becomes:
			"record: `post` by head, round and finding for each review, root comment and reply GitHub accepted, and `status` by head",
		mixed: "latest only and rewritten in place; a pending round's plan and the refusal counts are run state beside the posts",
	},
	"melian.ledger": {
		becomes: "record: `ledger` by changeset, the comment's ID, author and URL",
		mixed: "one value rewritten in place on every publish",
	},
	"melian.publisher": {
		becomes: "working state: the publish target is the host's; the marker secret must never leave the host",
		mixed: "holds the marker secret, the only secret in the store",
	},
	"melian.reviews": {
		becomes: "working state: which task owns which step of a revision",
		mixed: "the selection (lenses, levels, routes) is a fact the round needs, beside task IDs that only this host's tasks mean",
	},
	"melian.lens": { becomes: "working state: a lens conversation's policy and its budget counters" },
	"melian.verification-waves": { becomes: "working state: which wave tasks a lens task started" },
	"melian.decisions": {
		becomes: "record: `decision` by revision and question set, triage's answer",
		mixed: "names the decision task beside the answer",
	},
	"melian.summaries": { becomes: "working state: which summariser task is indexed and how many attempts it spent" },
	"melian.walkthrough-result": { becomes: "record: `walkthrough` by revision, the summary the ledger renders" },
	"melian.prepare": { becomes: "record, optional: `telemetry` by revision and stage; it decides nothing" },
	"melian.stage-timing": { becomes: "record, optional: `telemetry`; start and end of a task only this host ran" },
	"melian.run-details": { becomes: "record, optional: `telemetry` by revision, the ledger's run table" },
	"melian.model-usage": { becomes: "record, optional: `telemetry`; tokens and cost of a conversation" },
	"melian.model-attempts": { becomes: "working state: requests started and not yet measured" },
	"melian.check-sources": { becomes: "working state: which task ran a check source" },
	"melian.comparisons": { becomes: "record: `comparison` by round and source, the maintainer's matches" },
	"melian.pull-request-rounds": { becomes: "record: `membership` snapshot by version" },
	"melian.mutation-processes": { becomes: "working state: process trees a mutation run started on this host" },
};
const piWorking = "working state: Pi's own conversation state";

// 4. Export the record as #368's envelopes, signed by a throwaway host key, and measure it.
const host = Signer.generate();
const exported: { kind: string; key: string; size: number; text: string }[] = [];
const add = (kind: string, key: string, payload: unknown) => {
	const record = host.sign({ v: 1, changeset: changeset.id, kind, key, payload: structuredClone(payload) as Json });
	const text = canonical(record);
	exported.push({ kind, key, size: Buffer.byteLength(text), text });
};
const one = (kind: string) => latest.get(kind)?.[0] as Record<string, unknown> | undefined;
const findings = one("melian.findings") as
	| {
			items: Record<
				string,
				{
					lifecycle: Record<string, unknown>;
					sightings: Record<string, Record<string, unknown>>;
					verifications?: Record<string, Record<string, Record<string, unknown>>>;
				}
			>;
			inherited?: Record<string, Record<string, unknown>>;
	  }
	| undefined;
for (const [id, item] of Object.entries(findings?.items ?? {})) {
	for (const [at, byProducer] of Object.entries(item.sightings))
		for (const [producer, sighting] of Object.entries(byProducer))
			add("sighting", `${at} ${id} ${producer}`, sighting);
	for (const [at, byProducer] of Object.entries(item.verifications ?? {}))
		for (const [producer, byVersion] of Object.entries(byProducer))
			for (const [version, verification] of Object.entries(byVersion))
				add("verification", `${at} ${id} ${producer} ${version}`, verification);
	const { lifecycle } = item;
	if (lifecycle.status === "dismissed") {
		const {
			status: _,
			firstSeenRevision: __,
			lastSeenRevision: ___,
			history: ____,
			proof: _____,
			...dismissal
		} = lifecycle;
		add("dismissal", id, dismissal);
	}
}
for (const [at, links] of Object.entries(findings?.inherited ?? {}))
	for (const [id, link] of Object.entries(links)) add("inheritance", `${at} ${id}`, link);
const checks = one("melian.checks") as { runs?: Record<string, { records?: { name: string }[] }> } | undefined;
for (const [run, entry] of Object.entries(checks?.runs ?? {}))
	for (const record of entry.records ?? []) add("check", `${revision} ${record.name} ${run.slice(0, 16)}`, record);
const verdicts = one("melian.verdicts") as
	| { provenance?: Record<string, unknown>; details?: Record<string, unknown>; walkthroughs?: Record<string, unknown> }
	| undefined;
const rounds = one("melian.rounds") as { items?: Record<string, Record<string, unknown>> } | undefined;
for (const [key, round] of Object.entries(rounds?.items ?? {}))
	add("round", key, {
		...round,
		provenance: verdicts?.provenance?.[revision],
		details: verdicts?.details?.[revision],
	});
for (const [at, walkthrough] of Object.entries(verdicts?.walkthroughs ?? {})) add("walkthrough", at, walkthrough);
const published = one("melian.published") as
	| {
			revisions?: Record<
				string,
				{
					reviews?: string[];
					open?: Record<string, unknown>;
					resolved?: Record<string, unknown>;
					replies?: Record<string, unknown>;
					status?: unknown;
				}
			>;
			ledgerRounds?: unknown[];
	  }
	| undefined;
for (const [head, entry] of Object.entries(published?.revisions ?? {})) {
	for (const [index, posted] of (entry.reviews ?? []).entries()) add("post", `${head} review ${index}`, posted);
	for (const [id, root] of Object.entries(entry.open ?? {})) add("post", `${head} root ${id}`, root);
	for (const [id, resolved] of Object.entries(entry.resolved ?? {})) add("post", `${head} resolved ${id}`, resolved);
	for (const [key, reply] of Object.entries(entry.replies ?? {})) add("post", `${head} reply ${key}`, reply);
	if (entry.status !== undefined) add("status", head, entry.status);
}
for (const [index, round] of (published?.ledgerRounds ?? []).entries()) add("ledger-round", String(index), round);
const ledger = one("melian.ledger") as { comment?: unknown } | undefined;
if (ledger?.comment !== undefined) add("ledger", changeset.id, ledger.comment);
for (const kind of ["melian.run-details", "melian.model-usage", "melian.prepare", "melian.stage-timing"])
	for (const [index, value] of (latest.get(kind) ?? []).entries()) add("telemetry", `${kind} ${index}`, value);

// 5. Report.
const pad = (text: string | number, width: number) => String(text).padEnd(width);
console.log("\nTables in the store (rows, bytes of JSON):");
for (const table of tables) console.log(`  ${pad(table.t as string, 20)} ${pad(table.n as number, 6)} ${table.b}`);
console.log(`  file on disk: ${files} bytes`);
console.log("\nDocuments by kind (documents, revisions, bytes of history) and what each becomes:");
for (const doc of documents) {
	const kind = JSON.parse(doc.kind as string) as string;
	const sort = sorting[kind] ?? (kind.startsWith("pi.") ? { becomes: piWorking } : { becomes: "UNSORTED" });
	console.log(
		`  ${pad(kind, 28)} ${pad(doc.docs as number, 4)} ${pad(doc.revisions as number, 5)} ${pad(doc.history as number, 9)} ${sort.becomes}`,
	);
	if (sort.mixed !== undefined) console.log(`  ${" ".repeat(50)}NOT CLEAN: ${sort.mixed}`);
}
const absent = Object.keys(sorting).filter((kind) => !documents.some((doc) => JSON.parse(doc.kind as string) === kind));
console.log(`  defined but not written by this run: ${absent.join(", ")}`);
console.log("\nTasks by kind (count, bytes): all working state, each one host's run");
for (const task of tasks)
	console.log(`  ${pad(JSON.parse(task.kind as string) as string, 28)} ${pad(task.n as number, 4)} ${task.b}`);
const total = exported.reduce((sum, each) => sum + each.size, 0);
const byKind = new Map<string, { n: number; b: number }>();
for (const each of exported) {
	const entry = byKind.get(each.kind) ?? { n: 0, b: 0 };
	byKind.set(each.kind, { n: entry.n + 1, b: entry.b + each.size });
}
const largest = exported.reduce((a, b) => (b.size > a.size ? b : a));
const stored = tables.reduce((sum, table) => sum + (table.b as number), 0);
console.log(
	`\nExport: ${exported.length} records, ${total} bytes; the store's JSON is ${stored} bytes, its file ${files} bytes`,
);
for (const [kind, entry] of byKind) console.log(`  ${pad(kind, 14)} ${pad(entry.n, 4)} ${entry.b}`);
console.log(`  largest: ${largest.kind} ${largest.key.slice(0, 80)}, ${largest.size} bytes`);
const secret = (one("melian.publisher") as { secret?: string } | undefined)?.secret;
const leaks = (needle: string) =>
	exported.filter((each) => each.text.includes(needle)).map((each) => `${each.kind} ${each.key.slice(0, 40)}`);
console.log(`\nHost paths in the export (${repo}): ${leaks(repo).join("; ") || "none"}`);
console.log(`The provider token in the export: ${leaks("test-token").join("; ") || "none"}`);
if (secret !== undefined) console.log(`The marker secret in the export: ${leaks(secret).join("; ") || "none"}`);
console.log(
	`\nSecrets: the publisher document holds a ${secret === undefined ? "missing" : `${secret.length / 2}-byte`} marker secret; the export leaves it out.`,
);
rmSync(scratch, { recursive: true, force: true });
rmSync(repo, { recursive: true, force: true });
