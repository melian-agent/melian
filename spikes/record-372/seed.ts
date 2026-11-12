// Export a store's finished lens and check results as records, and seed a fresh store from them. Scripts, not product
// code: the lens task is wrapped from outside, through Pi Durable's public transaction API.
import { createHash } from "node:crypto";
import { type Finding, Revision } from "@melian-agent/core";
import {
	type CheckRunRecord,
	type ConversationId,
	backgroundContext as context,
	defineExtension,
	defineTask,
	type Harness,
	lensExtension,
	readFindings,
	type Tx,
	upsertFinding,
} from "@melian-agent/pipeline";
import { canonical } from "./records.mjs";

// The lens task's run as its stored input holds it. The pipeline keeps the type private, so these are the fields the
// spike reads.
type StoredRun = {
	key: string;
	name: string;
	version: string;
	level: string;
	route: { provider: string; modelId: string }[];
	thinking?: string;
	instructionFingerprint?: string;
	band?: string;
	escalation?: { next?: StoredRun; cap?: string };
	budget: unknown;
	severities: unknown;
	rules: unknown;
	tools: unknown;
	coverage: unknown;
};
type StoredInput = {
	root: ConversationId;
	revision: { base: string; head: string };
	lenses: StoredRun[];
	escalateAt?: string;
};

const modelName = (ref: { provider: string; modelId: string }) => `${ref.provider}/${ref.modelId}`;

// The review index's selection line for one run, copied from `selectionOf` in packages/pipeline/src/review.ts, which is
// not exported. It is the pipeline's own identity for a lens run: key (name@version@level), thinking, instruction
// fingerprint, band, escalateAt, escalation and route.
export function selection(run: StoredRun, escalateAt: string | undefined): string {
	const escalates = (escalation: NonNullable<StoredRun["escalation"]>) => {
		const { next } = escalation;
		if (next !== undefined)
			return `escalates to ${next.key} (${next.route.map(modelName).join(", ")}) ${next.instructionFingerprint ?? ""}${next.thinking === undefined ? "" : ` thinking ${next.thinking}`}`;
		return `capped ${escalation.cap ?? "at its ceiling"}`;
	};
	return [
		run.key,
		...(run.thinking === undefined ? [] : [`thinking ${run.thinking}`]),
		...(run.instructionFingerprint === undefined ? [] : [`instructions ${run.instructionFingerprint}`]),
		...(run.band === undefined ? [] : [`band ${run.band}`]),
		...(escalateAt === undefined ? [] : [`escalateAt ${escalateAt}`]),
		...(run.escalation === undefined ? [] : [escalates(run.escalation)]),
		`on ${run.route.map(modelName).join(", ")}`,
	].join(" ");
}

// The lens's policy as its task holds it, beside the selection: the selection line omits budgets, severities, rules,
// tools and coverage, which the task records in each lens's LensDocument.
export function lensPolicy(run: StoredRun): string {
	const { budget, severities, rules, tools, coverage } = run;
	return createHash("sha256")
		.update(canonical({ budget, severities, rules, tools, coverage }))
		.digest("hex")
		.slice(0, 16);
}

export const lensKey = (run: StoredRun, escalateAt: string | undefined) =>
	`${selection(run, escalateAt)} policy ${lensPolicy(run)}`;
export const checkKey = (name: string, policy: string) => `${name} policy ${policy}`;

const lensProducer = (run: Pick<StoredRun, "name" | "version" | "level">) => ({
	check: `lens.${run.name}`,
	version: `${run.version}@${run.level}`,
});

// A finding as a producer reported it: reportedBy and verification are added on read. upsertFinding requires a status
// and drops it.
function asProduced(finding: Finding): Finding {
	const { reportedBy: _, verification: __, ...properties } = finding.toJSON().properties as Record<string, unknown>;
	return { ...finding.toJSON(), properties } as unknown as Finding;
}

export type Exported = { kind: "lens" | "check"; key: string; payload: Record<string, unknown> };

// Reads the lens task's stored input and the request each lens's first attempt submitted, through a read-only commit.
async function lensTask(harness: Harness) {
	const { tasks } = await harness.inspect(context);
	const record = tasks.find((task) => task.record.kind === "melian.lenses")?.record;
	if (record === undefined) throw new Error("no live lens task");
	const input = record.input as unknown as StoredInput;
	const children = (record.state as { checkpoint?: { children?: Record<string, ConversationId> } }).checkpoint
		?.children;
	return { input, children: children ?? {} };
}

// Every lens run that finished, and every check record given, as records' kind, key and payload.
export async function exportFinished(
	harness: Harness,
	checks: { readonly records: readonly CheckRunRecord[]; readonly policy: string },
): Promise<Exported[]> {
	const { input, children } = await lensTask(harness);
	const revision = Revision.key(input.revision);
	const exported: Exported[] = [];
	for (const run of input.lenses) {
		const child = children[run.key];
		if (child === undefined) continue;
		const submission = await harness.commit((tx) => tx.submissionByRequest(child, `lens:${run.key}:0`), context);
		if (submission?.status !== "done") continue;
		const findings = await readFindings(harness, input.root, revision, context, {
			producers: [lensProducer(run)],
			asReported: true,
		});
		exported.push({
			kind: "lens",
			key: lensKey(run, input.escalateAt),
			payload: {
				run: { key: run.key, name: run.name, version: run.version, level: run.level },
				model: modelName(run.route[0]!),
				findings: findings.map((finding) => asProduced(finding)),
			} as unknown as Record<string, unknown>,
		});
	}
	for (const record of checks.records) {
		if (record.name.startsWith("lens.")) continue;
		const version = "version" in record ? record.version : undefined;
		const findings = await readFindings(harness, input.root, revision, context, {
			producers: [version === undefined ? { check: record.name } : { check: record.name, version }],
			asReported: true,
		});
		exported.push({
			kind: "check",
			key: checkKey(record.name, checks.policy),
			payload: { record, findings: findings.map((finding) => asProduced(finding)) } as unknown as Record<
				string,
				unknown
			>,
		});
	}
	return exported;
}

export type Imported = { kind: string; key: string; id: string; payload: Record<string, unknown> };

// Writes imported check records' findings at the revision, in one commit on the root.
export async function seedChecks(harness: Harness, revision: string, imported: readonly Imported[]): Promise<void> {
	const root = (await harness.root(context)).id;
	await harness.commit(async (tx) => {
		for (const record of imported)
			for (const finding of record.payload.findings as Finding[]) await upsertFinding(tx, root, finding, revision);
	}, context);
}

// What one seeded review did with each lens run: whether a record stood in for it, and the keys that did not match.
export type SeedLog = { used: string[]; missed: { run: string; key: string }[] };

// Seeds a lens run from its record in the commit that spawns the lens conversations: the record's findings become the
// run's sightings, and a settled submission under the request ID the task's first attempt uses tells the task the run
// is done, so it asks no model. Everything else, the outcome, the waves, verification and adjudication, runs as it would.
async function seedRuns(
	tx: Tx,
	input: StoredInput,
	children: Record<string, ConversationId>,
	records: Map<string, Imported>,
	log: SeedLog,
) {
	const revision = Revision.key(input.revision);
	for (const run of input.lenses) {
		const key = lensKey(run, input.escalateAt);
		const record = records.get(key);
		if (record === undefined) {
			log.missed.push({ run: run.key, key });
			continue;
		}
		const child = children[run.key]!;
		for (const finding of record.payload.findings as Finding[])
			await upsertFinding(tx, input.root, finding, revision);
		const entry = await tx.appendEntry(child, { kind: "melian.imported-record", data: { record: record.id } });
		await tx.createSubmission({
			conversationId: child,
			requestId: `lens:${run.key}:0`,
			type: "input",
			status: "done",
			entry: entry.id,
			answer: entry.id,
		});
		log.used.push(run.key);
	}
}

// The lens extension with its task's spawn phase wrapped: the spawn commit also seeds every run a record matches.
export function seededLensExtension(imported: readonly Imported[], log: SeedLog) {
	const records = new Map(imported.filter((record) => record.kind === "lens").map((record) => [record.key, record]));
	const tasks = lensExtension.tasks!.map((task) => {
		const definition = (task as unknown as { definition: Parameters<typeof defineTask>[0] }).definition;
		if (definition.name !== "melian.lenses") return task;
		const phases = definition.phases as Record<
			string,
			(task: unknown, runtime: unknown, context: unknown) => Promise<void>
		>;
		return defineTask({
			...definition,
			phases: {
				...definition.phases,
				spawn: async (stored: unknown, runtime: unknown, ctx: unknown) => {
					const wrapped = new Proxy(runtime as object, {
						get(target, property, receiver) {
							const value = Reflect.get(target, property, receiver);
							if (property !== "commit") return typeof value === "function" ? value.bind(target) : value;
							return (change: (tx: Tx, current: unknown) => unknown, commitContext: unknown) =>
								(value as (...args: unknown[]) => unknown).call(
									target,
									async (tx: Tx, current: unknown) => {
										const next = (await change(tx, current)) as
											| { checkpoint?: { phase?: string; children?: Record<string, ConversationId> } }
											| undefined;
										const { checkpoint } = next ?? {};
										if (checkpoint?.phase === "review")
											await seedRuns(
												tx,
												(stored as { input: StoredInput }).input,
												checkpoint.children!,
												records,
												log,
											);
										return next;
									},
									commitContext,
								);
						},
					});
					await phases.spawn!(stored, wrapped, ctx);
				},
			},
		} as Parameters<typeof defineTask>[0]);
	});
	return defineExtension({ ...lensExtension, tasks } as Parameters<typeof defineExtension>[0]);
}
