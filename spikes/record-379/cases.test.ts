// Issue #379: the shared record decision's sections 8 and 9, case by case. Run from the checkout, with MELIAN_STATE_DIR
// unset: node --experimental-strip-types --no-warnings --conditions=@melian-agent/source --test spikes/record-379/cases.test.ts
// Each test asserts what the code does. Where that differs from what the decision states, the test's name says so with
// "FINDING", and the report gives both.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findingId, Revision } from "@melian-agent/core";
import { lensKey } from "../record-372/seed.ts";
import { canonical, recordId, Signer } from "../record-373/record.ts";
import { acceptCheck, type Envelope, gate, policyAt, standing, trusted, verificationKey } from "./gate.ts";
import { dismiss, exportAt, git, lifecycleOf, openSession, reviewHead, storedVerdict, user } from "./scenario.ts";
import { computeVerdict } from "./verdict.ts";

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const store = (records: Envelope[]) => ({ list: async () => records });
const everything = () => true;

const firstHead = user("\treturn user.manager.name;");
const brokenHead = user("\treturn user.manager!.name;");
const other = "export const other = 1;\n";

// One reviewed and exported head under `policy`, for the gate's cases.
async function reviewedOnce(policy: (host: { id: string; key: string }) => string = () => "trust:\n  writers: true\n") {
	const session = await openSession(policy);
	const reviewed = await reviewHead(session, { "src/user.ts": firstHead }, "head");
	await exportAt(session, reviewed);
	return { session, reviewed };
}

describe("case 1: a dismissed affected finding, its proof checked against a later revision's hunks", () => {
	it("FINDING: the spike's computed verdict never reopens it, and with the hunks from git it equals the stored one", async () => {
		const session = await openSession();
		try {
			const first = await reviewHead(session, { "src/user.ts": firstHead }, "first");
			const [finding] = Object.values((await storedVerdict(session, first.revision)).findings).flat();
			assert.equal(finding!.properties.cause, "affected");
			session.records.add(await dismiss(session, first, finding!.properties.id));
			const second = await reviewHead(session, { "src/user.ts": brokenHead }, "breaks the proving hunk");
			await exportAt(session, second);
			const stored = await storedVerdict(session, second.revision);
			assert.equal((await lifecycleOf(session, finding!.properties.id)).status !== "dismissed", true);
			const blind = await computeVerdict(session.records.list(), everything, second.revision, session.repo, {
				reopen: true,
			});
			const fromGit = await computeVerdict(session.records.list(), everything, second.revision, session.repo, {
				reopen: true,
				hunks: (at) => session.hunks.get(at) ?? [],
			});
			assert.equal(same(blind!.verdict, stored), false, "without hunks the dismissal outlives its proof");
			assert.equal(blind!.verdict.dismissed.length, 1);
			assert.equal(
				same(fromGit!.verdict, stored),
				true,
				"with the hunks git gives, it reopens as the stored one does",
			);
		} finally {
			await session.close();
		}
	});
});

describe("case 2: a dismissal, a revision that keeps its trigger, one that breaks it, and one that restores it", () => {
	it("FINDING: computed and stored agree at every revision only when the computation keeps the reopen's history", async () => {
		const session = await openSession();
		try {
			const first = await reviewHead(session, { "src/user.ts": firstHead }, "first");
			const [finding] = Object.values((await storedVerdict(session, first.revision)).findings).flat();
			const id = finding!.properties.id;
			session.records.add(await dismiss(session, first, id));
			const heads = [
				await reviewHead(session, { "src/other.ts": other }, "keeps the trigger"),
				await reviewHead(session, { "src/user.ts": brokenHead }, "breaks it"),
				await reviewHead(session, { "src/user.ts": firstHead }, "restores the first head's content"),
			];
			const outcomes = [];
			for (const head of heads) {
				await exportAt(session, head);
				const stored = await storedVerdict(session, head.revision);
				const computed = await computeVerdict(session.records.list(), everything, head.revision, session.repo, {
					reopen: true,
					hunks: (at) => session.hunks.get(at) ?? [],
				});
				// The decision's words, read at this revision alone: does this revision's hunk still prove the dismissal?
				const proof = (
					session.records.list().find((record) => record.kind === "dismissal")!.payload as {
						trigger: { proof: { file: string; hash: string }[] };
					}
				).trigger.proof;
				const hunks = session.hunks.get(head.revision) ?? [];
				const standsHere = proof.every((each) =>
					hunks.some((hunk) => hunk.file === each.file && hunk.hash === each.hash),
				);
				outcomes.push({
					stored: stored.dismissed.some((each) => each.properties.id === id),
					computed: computed!.verdict.dismissed.some((each) => each.properties.id === id),
					standsHere,
					equal: same(computed!.verdict, stored),
				});
			}
			assert.deepEqual(
				outcomes.map(({ stored, computed, standsHere }) => ({ stored, computed, standsHere })),
				[
					{ stored: true, computed: true, standsHere: true },
					{ stored: false, computed: false, standsHere: false },
					// The restored head proves the dismissal again, read alone; the lifecycle keeps it reopened.
					{ stored: false, computed: false, standsHere: true },
				],
			);
			assert.deepEqual(
				outcomes.map(({ equal }) => equal),
				[true, true, true],
			);
		} finally {
			await session.close();
		}
	});
});

describe("case 3: the gate with each input missing in turn", () => {
	it("passes with every input present", async () => {
		const { session, reviewed } = await reviewedOnce();
		try {
			const result = await gate({
				store: store(session.records.list()),
				changeset: reviewed.changeset,
				revision: reviewed.revision,
				repo: session.repo,
				base: reviewed.base,
			});
			assert.equal(result.exit, 0, result.reason);
		} finally {
			await session.close();
		}
	});

	it("fails closed with no round for the revision", async () => {
		const { session, reviewed } = await reviewedOnce();
		try {
			const records = session.records.list().filter((record) => record.kind !== "round");
			const result = await gate({
				store: store(records),
				changeset: reviewed.changeset,
				revision: reviewed.revision,
				repo: session.repo,
				base: reviewed.base,
			});
			assert.deepEqual([result.exit, result.reason], [1, "no round for the revision"]);
		} finally {
			await session.close();
		}
	});

	it("fails closed on a round for the same head and another base", async () => {
		const { session, reviewed } = await reviewedOnce();
		try {
			const otherBase = Revision.key({ base: "f".repeat(40), head: reviewed.at.head });
			const result = await gate({
				store: store(session.records.list()),
				changeset: reviewed.changeset,
				revision: otherBase,
				repo: session.repo,
				base: reviewed.base,
			});
			assert.deepEqual([result.exit, result.reason], [1, "no round for the revision"]);
		} finally {
			await session.close();
		}
	});

	it("fails closed when the closing record names an absent record", async () => {
		const { session, reviewed } = await reviewedOnce();
		try {
			const sighting = session.records.list().find((record) => record.kind === "sighting")!;
			const records = session.records.list().filter((record) => recordId(record) !== recordId(sighting));
			const result = await gate({
				store: store(records),
				changeset: reviewed.changeset,
				revision: reviewed.revision,
				repo: session.repo,
				base: reviewed.base,
			});
			assert.deepEqual([result.exit, result.reason], [1, "verdict not-reviewed"]);
		} finally {
			await session.close();
		}
	});

	it("FINDING: fails closed when the base's melian.yaml cannot be read only because this script chose to", async () => {
		const session = await openSession();
		try {
			const reviewed = await reviewHead(session, { "src/user.ts": firstHead }, "head");
			await exportAt(session, reviewed);
			assert.throws(() => policyAt(session.repo, reviewed.base));
			const result = await gate({
				store: store(session.records.list()),
				changeset: reviewed.changeset,
				revision: reviewed.revision,
				repo: session.repo,
				base: reviewed.base,
			});
			assert.deepEqual([result.exit, result.reason], [1, "the base commit's melian.yaml cannot be read"]);
		} finally {
			await session.close();
		}
	});

	it("fails closed when the store cannot be listed", async () => {
		const { session, reviewed } = await reviewedOnce();
		try {
			const unreachable = { list: async () => Promise.reject(new Error("fetch failed")) };
			const result = await gate({
				store: unreachable,
				changeset: reviewed.changeset,
				revision: reviewed.revision,
				repo: session.repo,
				base: reviewed.base,
			});
			assert.deepEqual([result.exit, result.reason], [1, "the store cannot be listed: fetch failed"]);
		} finally {
			await session.close();
		}
	});
});

describe("case 4: a stale list, with an older round present and the newest absent", () => {
	it("FINDING: the gate passes on the older round, though the newest supersedes it and does not pass", async () => {
		const { session, reviewed } = await reviewedOnce();
		try {
			const older = session.records.list();
			const round = older.find((record) => record.kind === "round")!;
			// The newest round of the same revision: one more check, failed, so it reads as not reviewed.
			const failed = session.host.sign({
				v: 1,
				changeset: reviewed.changeset,
				kind: "check",
				key: `${reviewed.revision} static.tsc`,
				payload: { name: "static.tsc", status: "failed", reason: "tsc crashed" },
			});
			const payload = round.payload as { manifest: string[]; rests: { kind: string; key: string; id: string }[] };
			const { signer: _, signature: __, ...unsigned } = round;
			const newest = {
				...session.host.sign({
					...unsigned,
					payload: {
						...payload,
						manifest: [...payload.manifest, "static.tsc"],
						rests: [...payload.rests, { kind: "check", key: failed.key, id: recordId(failed) }],
					} as never,
				}),
				supersedes: [recordId(round)],
			};
			const args = {
				changeset: reviewed.changeset,
				revision: reviewed.revision,
				repo: session.repo,
				base: reviewed.base,
			};
			const whole = await gate({ store: store([...older, failed, newest as Envelope]), ...args });
			const stale = await gate({ store: store(older), ...args });
			assert.deepEqual([whole.exit, whole.reason], [1, "verdict not-reviewed"]);
			assert.deepEqual([stale.exit, stale.reason], [0, "verdict findings"]);
		} finally {
			await session.close();
		}
	});
});

describe("case 5: a check record from a host with another tool version", () => {
	const record = (version?: string) =>
		({
			v: 1,
			changeset: "pull-0123456789abcdef",
			kind: "check",
			key: "static.tsc policy 1a2b",
			payload: {
				record: { name: "static.tsc", status: "ran", ...(version === undefined ? {} : { version }) },
				findings: [],
			},
			signer: "",
			signature: "",
		}) as Envelope;

	it("is refused when the payload's version differs from this host's", () => {
		assert.deepEqual(acceptCheck(record("5.6.3"), { key: "static.tsc policy 1a2b", toolVersion: "5.7.2" }), {
			accepted: false,
			why: "the record ran 5.6.3, this host runs 5.7.2",
		});
	});

	it("FINDING: is accepted with no comparison when the record names no version, as a skipped or failed check's does", () => {
		assert.equal(acceptCheck(record(), { key: "static.tsc policy 1a2b", toolVersion: "5.7.2" }).accepted, true);
	});
});

describe("case 6: a lens record whose policy fingerprint matches and whose instructions, band or escalation differ", () => {
	const run = {
		key: "correctness@3@careful",
		name: "correctness",
		version: "3",
		level: "careful",
		route: [{ provider: "openai-codex", modelId: "gpt-5.6-sol" }],
		thinking: "high",
		instructionFingerprint: "aaaa",
		band: "standard",
		escalation: { cap: "at its ceiling" },
		budget: { findings: 8 },
		severities: {},
		rules: [],
		tools: [],
		coverage: {},
	};
	const own = lensKey(run as never, undefined);

	for (const [name, changed] of [
		["instruction hash", { instructionFingerprint: "bbbb" }],
		["band", { band: "wide" }],
		[
			"escalation",
			{ escalation: { next: { ...run, key: "correctness@3@deep", level: "deep", escalation: undefined } } },
		],
	] as const)
		it(`is not used when its ${name} differs`, () => {
			const theirs = lensKey({ ...run, ...changed } as never, undefined);
			assert.equal(theirs.endsWith(own.split(" policy ")[1]!), true, "the policy fingerprint matches");
			assert.notEqual(theirs, own);
		});

	it("FINDING: an older host that records no instruction hash gives the same key for other instructions", () => {
		const { instructionFingerprint: _, ...older } = run;
		assert.equal(lensKey(older as never, undefined), lensKey({ ...older } as never, undefined));
		assert.notEqual(lensKey(older as never, undefined), own);
	});
});

describe("case 7: lens records from one host and verification records from another, whose claims differ", () => {
	const input = {
		file: "src/user.ts",
		line: 7,
		rule: "null-dereference",
		snippet: "return user.manager.name;",
		occurrence: 0,
		explanation: { what: "w", why: "y", fix: "f" },
		failureScenario: "s",
	};

	it("does not use a verification whose claim IDs differ", () => {
		const theirs = verificationKey(["aaaa", "bbbb"], "verifier@4");
		assert.notEqual(theirs, verificationKey(["aaaa"], "verifier@4"));
	});

	it("FINDING: uses a verification of the other host's sighting when only its severity and text differ, since a claim ID covers neither", () => {
		// findingId's whole input: file, rule, snippet, occurrence and discriminator. Severity and text are not in it, so
		// two hosts' sightings of one location and rule share a claim ID whatever they say.
		const id = findingId({
			file: input.file,
			rule: input.rule,
			snippet: input.snippet,
			occurrence: input.occurrence,
		});
		assert.equal(id, findingId({ ...input }));
		assert.equal(verificationKey([id], "verifier@4"), verificationKey([findingId({ ...input })], "verifier@4"));
	});
});

describe("case 8: a record from a fork's head, written by a writer rather than the trusted host", () => {
	it("does not count where the base pins the host key, and the host's own record does", async () => {
		const { session, reviewed } = await reviewedOnce(
			(host) => `trust:\n  writers: true\n  host: { id: ${host.id}, key: ${host.key} }\n`,
		);
		try {
			const policy = policyAt(session.repo, reviewed.base);
			const writer = Signer.generate();
			const round = session.records.list().find((record) => record.kind === "round")!;
			const { signer: _, signature: __, ...unsigned } = round;
			assert.equal(trusted(policy, true)(round), true);
			assert.equal(trusted(policy, true)(writer.sign(unsigned)), false);
		} finally {
			await session.close();
		}
	});

	it("FINDING: where the base pins no key, as every repository with trust.writers true has none, the gate cannot tell the host's record from a writer's, so a fork's pull request never passes", async () => {
		const { session, reviewed } = await reviewedOnce();
		try {
			const args = {
				changeset: reviewed.changeset,
				revision: reviewed.revision,
				repo: session.repo,
				base: reviewed.base,
			};
			assert.equal((await gate({ store: store(session.records.list()), ...args })).exit, 0);
			assert.deepEqual(await gate({ store: store(session.records.list()), ...args, fork: true }), {
				exit: 1,
				reason: "no round for the revision",
			});
		} finally {
			await session.close();
		}
	});
});

describe("case 9: trust.writers false", () => {
	const strict = (host: { id: string; key: string }) =>
		`trust:\n  writers: false\n  host: { id: ${host.id}, key: ${host.key} }\n`;

	it("counts the pinned host's record, and refuses one unsigned, one by an unpinned key, and one by a key only the head pins", async () => {
		const { session, reviewed } = await reviewedOnce(strict);
		try {
			const accept = trusted(policyAt(session.repo, reviewed.base), false);
			const round = session.records.list().find((record) => record.kind === "round")!;
			const { signer: _, signature: __, ...unsigned } = round;
			const stranger = Signer.generate();
			// The head pins the stranger's key in its own melian.yaml; the gate reads the base's.
			git(session.repo, "checkout", "--quiet", "feature");
			const strangerKey = stranger.publicKey.export({ format: "jwk" }).x!;
			const headPolicy = `trust:\n  writers: false\n  host: { id: ${stranger.id}, key: ${strangerKey} }\n`;
			writeFileSync(join(session.repo, "melian.yaml"), headPolicy);
			git(session.repo, "commit", "--quiet", "--all", "-m", "the head pins another key");
			assert.equal(trusted(policyAt(session.repo, "feature"), false)(stranger.sign(unsigned)), true);
			assert.deepEqual(
				[
					accept(round),
					accept(unsigned as Envelope),
					accept(Signer.generate().sign(unsigned)),
					accept(stranger.sign(unsigned)),
				],
				[true, false, false, false],
			);
			const args = {
				changeset: reviewed.changeset,
				revision: reviewed.revision,
				repo: session.repo,
				base: reviewed.base,
			};
			assert.equal((await gate({ store: store(session.records.list()), ...args })).exit, 0);
			const unsignedAll = session.records.list().map(({ signer: _s, signature: _g, ...rest }) => rest as Envelope);
			assert.deepEqual(await gate({ store: store(unsignedAll), ...args }), {
				exit: 1,
				reason: "no round for the revision",
			});
		} finally {
			await session.close();
		}
	});
});

describe("cases of my own", () => {
	it("FINDING: a writer's round that supersedes a blocking round makes the gate pass, and only 'writers are trusted' stops it", async () => {
		const { session, reviewed } = await reviewedOnce();
		try {
			const records = session.records.list();
			const round = records.find((record) => record.kind === "round")!;
			const payload = round.payload as { manifest: string[]; rests: { kind: string; key: string; id: string }[] };
			const failed = session.host.sign({
				v: 1,
				changeset: reviewed.changeset,
				kind: "check",
				key: `${reviewed.revision} static.tsc`,
				payload: { name: "static.tsc", status: "failed", reason: "tsc crashed" },
			});
			const { signer: _, signature: __, ...unsigned } = round;
			const blocking = {
				...session.host.sign({
					...unsigned,
					payload: {
						...payload,
						manifest: [...payload.manifest, "static.tsc"],
						rests: [...payload.rests, { kind: "check", key: failed.key, id: recordId(failed) }],
					} as never,
				}),
				supersedes: [recordId(round)],
			} as Envelope;
			const writer = Signer.generate();
			const passing = { ...writer.sign(unsigned), supersedes: [recordId(blocking)] } as Envelope;
			const args = {
				changeset: reviewed.changeset,
				revision: reviewed.revision,
				repo: session.repo,
				base: reviewed.base,
			};
			assert.equal((await gate({ store: store([...records, failed, blocking]), ...args })).exit, 1);
			assert.equal((await gate({ store: store([...records, failed, blocking, passing]), ...args })).exit, 0);
		} finally {
			await session.close();
		}
	});

	it("FINDING: a superseded record's own supersedes still applies, so superseding a lens rerun brings back neither run", () => {
		const a = {
			v: 1,
			changeset: "pull-0123456789abcdef",
			kind: "lens",
			key: "k",
			payload: { run: 1 },
			signer: "",
			signature: "",
		} as Envelope;
		const b = { ...a, payload: { run: 2 }, supersedes: [recordId(a)] } as Envelope;
		const c = { ...a, payload: { note: "withdraws the rerun" }, supersedes: [recordId(b)] } as Envelope;
		assert.deepEqual(
			standing([a, b, c]).map((record) => record.payload as object),
			[{ note: "withdraws the rerun" }],
		);
	});

	it("needs no rule against a cycle of supersedes: an ID covers the supersedes field, so no two records can name each other", () => {
		const a = {
			v: 1,
			changeset: "pull-0123456789abcdef",
			kind: "lens",
			key: "k",
			payload: {},
			signer: "",
			signature: "",
		} as Envelope;
		const b = { ...a, supersedes: [recordId(a)] } as Envelope;
		assert.notEqual(recordId({ ...a, supersedes: [recordId(b)] }), recordId(a));
	});

	it("FINDING: two rounds that both stand, one passing and one not reviewed, take the worse, so a writer can block by adding a second round", async () => {
		const { session, reviewed } = await reviewedOnce();
		try {
			const records = session.records.list();
			const round = records.find((record) => record.kind === "round")!;
			const payload = round.payload as { manifest: string[] };
			const { signer: _, signature: __, ...unsigned } = round;
			const second = Signer.generate().sign({
				...unsigned,
				payload: { ...payload, manifest: [...payload.manifest, "static.tsc"] } as never,
			});
			const args = {
				changeset: reviewed.changeset,
				revision: reviewed.revision,
				repo: session.repo,
				base: reviewed.base,
			};
			assert.deepEqual([(await gate({ store: store([...records, second]), ...args })).exit], [1]);
		} finally {
			await session.close();
		}
	});
});
