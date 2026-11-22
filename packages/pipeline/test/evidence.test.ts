import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Adjudication, defaultConfig, ExternalFinding, Finding, type StoredFinding } from "@melian-agent/core";
import {
	createMemoryStorage,
	type EntryRecord,
	type EvidenceConversation,
	type EvidencePointer,
	EvidenceStore,
	evidenceLimits,
	MissEvidence,
	Round,
	type Stage,
	type Storage,
} from "@melian-agent/pipeline";
import { afterEach, describe, expect, it } from "vitest";

const changeset = `range-${"a".repeat(16)}`;
const round = `${changeset}.r1`;
const cleanup: string[] = [];

afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(): string {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "melian-evidence-")));
	cleanup.push(path);
	return path;
}

function stage(conversation: number): Stage {
	return {
		id: `conversation:${conversation}`,
		name: "melian.lens",
		subject: "correctness@1@careful",
		task: 7,
		conversation,
		outcome: "completed",
		timing: "available",
		reused: false,
		resumed: false,
	};
}

function entry(conversation: number, id: number, text = `entry ${id}`, kind = "message"): EntryRecord {
	return { id, conversationId: conversation, kind, data: { text } } as unknown as EntryRecord;
}

// A conversation of entries of these kinds and texts, as a lens's opens: the prompt, the instructions, then replies.
function spoken(id: number, ...entries: (readonly [kind: string, text: string])[]): EvidenceConversation {
	return { stage: stage(id), entries: entries.map(([kind, text], index) => entry(id, index + 1, text, kind)) };
}

function conversation(id: number, ...texts: string[]): EvidenceConversation {
	return { stage: stage(id), entries: texts.map((text, index) => entry(id, index + 1, text)) };
}

function evidence(external: string, ...stages: EvidenceConversation[]): MissEvidence {
	const pointer: EvidencePointer = {
		version: 1,
		changeset,
		round,
		external,
		base: "b".repeat(40),
		head: "c".repeat(40),
		policy: `revision:${"b".repeat(40)}`,
		lensFiles: [],
		stages: [],
	};
	return MissEvidence.from(pointer, stages);
}

const first = "1".repeat(16);
const second = "2".repeat(16);

function files(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((each) => !each.isDirectory())
		.map((each) => join(each.parentPath, each.name).slice(directory.length + 1))
		.sort();
}

function stored(state: string, conversationId: number): { text: string; value: unknown } {
	const text = gunzipSync(
		readFileSync(join(state, "evidence", changeset, "r1", "stages", `conversation-${conversationId}.json.gz`)),
	).toString("utf8");
	return { text, value: JSON.parse(text) };
}

describe("EvidenceStore", () => {
	it("writes a stage once for two misses of one round, and a pointer for each", async () => {
		const state = scratch();
		const store = EvidenceStore.open(state);
		const shared = conversation(2, "prompt", "reply");
		const one = await store.write(evidence(first, conversation(1, "prompt"), shared));
		const before = statSync(join(state, "evidence", changeset, "r1", "stages", "conversation-2.json.gz")).ino;
		const two = await store.write(evidence(second, shared, conversation(3, "prompt")));

		expect(one.written.map((path) => path.slice(state.length + 1))).toEqual([
			`evidence/${changeset}/r1/stages/conversation-1.json.gz`,
			`evidence/${changeset}/r1/stages/conversation-2.json.gz`,
		]);
		expect(two.written.map((path) => path.slice(state.length + 1))).toEqual([
			`evidence/${changeset}/r1/stages/conversation-3.json.gz`,
		]);
		expect(statSync(join(state, "evidence", changeset, "r1", "stages", "conversation-2.json.gz")).ino).toBe(before);
		expect(files(join(state, "evidence"))).toEqual([
			`${changeset}/r1/misses/${first}.json`,
			`${changeset}/r1/misses/${second}.json`,
			`${changeset}/r1/stages/conversation-1.json.gz`,
			`${changeset}/r1/stages/conversation-2.json.gz`,
			`${changeset}/r1/stages/conversation-3.json.gz`,
		]);
		const read = await EvidenceStore.open(state).read(changeset, round, second);
		expect(read).toEqual({
			pointer: { ...evidence(second, shared, conversation(3, "prompt")).pointer },
			stages: [
				{ version: 1, ...shared, dropped: 0 },
				{ version: 1, ...conversation(3, "prompt"), dropped: 0 },
			],
		});
		expect(read!.pointer.stages).toEqual(["conversation:2", "conversation:3"]);
		expect(await store.read(changeset, round, "3".repeat(16))).toBeUndefined();
	});

	it("writes files at mode 0600 and directories at 0700", async () => {
		const state = scratch();
		const store = EvidenceStore.open(state);
		await store.write(evidence(first, conversation(1, "prompt")));
		const evidenceDirectory = join(state, "evidence");
		for (const path of ["", changeset, `${changeset}/r1`, `${changeset}/r1/stages`, `${changeset}/r1/misses`])
			expect(statSync(join(evidenceDirectory, path)).mode & 0o777).toBe(0o700);
		for (const path of files(evidenceDirectory))
			expect(statSync(join(evidenceDirectory, path)).mode & 0o777).toBe(0o600);
	});

	// A read walks to the pointer first, so a link on the stages side is met only once a pointer names a stage.
	it.each([
		["evidence", "evidence", true],
		["the changeset", `evidence/${changeset}`, true],
		["the round", `evidence/${changeset}/r1`, true],
		["the stages directory", `evidence/${changeset}/r1/stages`, false],
		["the misses directory", `evidence/${changeset}/r1/misses`, true],
		["the stage file", `evidence/${changeset}/r1/stages/conversation-1.json.gz`, false],
		["the pointer", `evidence/${changeset}/r1/misses/${first}.json`, true],
	])("refuses a link at %s, and writes nothing through it", async (_, link, onPointerPath) => {
		const state = scratch();
		const elsewhere = scratch();
		const parts = link.split("/");
		mkdirSync(join(state, ...parts.slice(0, -1)), { recursive: true });
		symlinkSync(
			link.endsWith(".gz") || link.endsWith(".json") ? join(elsewhere, "file") : elsewhere,
			join(state, link),
		);
		const store = EvidenceStore.open(state);

		await expect(store.write(evidence(first, conversation(1, "prompt")))).rejects.toMatchObject({ code: "link" });
		if (onPointerPath) await expect(store.read(changeset, round, first)).rejects.toMatchObject({ code: "link" });
		else expect(await store.read(changeset, round, first)).toBeUndefined();

		expect(readdirSync(elsewhere)).toEqual([]);
		expect(files(state).filter((path) => !path.startsWith(link))).toEqual([]);
	});

	it("leaves no file behind when a write fails part-way", async () => {
		const state = scratch();
		const blocked = join(state, "evidence", changeset, "r1", "stages", "conversation-2.json.gz");
		mkdirSync(blocked, { recursive: true });
		writeFileSync(join(blocked, "occupied"), "");
		const store = EvidenceStore.open(state);

		await expect(
			store.write(evidence(first, conversation(1, "prompt"), conversation(2, "prompt"))),
		).rejects.toThrow();

		expect(files(join(state, "evidence"))).toEqual([`${changeset}/r1/stages/conversation-2.json.gz/occupied`]);
		expect(existsSync(join(state, "evidence", changeset, "r1", "misses"))).toBe(false);
	});

	it.each([
		["changeset", { changeset: "range-xyz", round: "range-xyz.r1" }],
		["round", { round: `${changeset}.r0` }],
		["round with a prefix", { round: `${changeset}.xr1` }],
		["round with a suffix", { round: `${changeset}.r1x` }],
		["round of another changeset", { round: `range-${"b".repeat(16)}.r1` }],
		["external ID", { external: "../../escape" }],
		["external ID with a prefix", { external: `x${first}` }],
		["external ID with a suffix", { external: `${first}x` }],
	])("refuses an unsafe %s before it reaches a path", async (_, change) => {
		const state = scratch();
		const pointer = { ...evidence(first).pointer, ...change };
		await expect(
			EvidenceStore.open(state).write(MissEvidence.from(pointer, [conversation(1, "prompt")])),
		).rejects.toMatchObject({ code: "unsafeName" });
		expect(existsSync(join(state, "evidence"))).toBe(false);
	});

	it.each(["conversation:../1", "xconversation:1", "conversation:1x"])(
		"refuses the stage ID %s, which is not a conversation's",
		async (id) => {
			const state = scratch();
			const bad = { ...conversation(1, "prompt"), stage: { ...stage(1), id } };
			await expect(EvidenceStore.open(state).write(evidence(first, bad))).rejects.toMatchObject({
				code: "unsafeName",
			});
			expect(existsSync(join(state, "evidence"))).toBe(false);
		},
	);

	it.each(["r12", `k${"0123456789abcdef"}`])("keeps the evidence of round %s in its own directory", async (local) => {
		const state = scratch();
		const named = MissEvidence.from({ ...evidence(first).pointer, round: `${changeset}.${local}` }, [
			conversation(1, "prompt"),
		]);
		await EvidenceStore.open(state).write(named);
		expect(files(join(state, "evidence", changeset))).toEqual([
			`${local}/misses/${first}.json`,
			`${local}/stages/conversation-1.json.gz`,
		]);
		expect((await EvidenceStore.open(state).read(changeset, `${changeset}.${local}`, first))?.pointer).toEqual(
			named.pointer,
		);
	});

	it("removes the directories it made when a write fails, and keeps the ones it found", async () => {
		const state = scratch();
		mkdirSync(join(state, "evidence"));
		// A conversation number this long makes the temporary file's name longer than a file system allows.
		const long = { ...conversation(2, "prompt"), stage: { ...stage(2), id: `conversation:${"9".repeat(240)}` } };

		await expect(EvidenceStore.open(state).write(evidence(first, conversation(1, "prompt"), long))).rejects.toThrow();

		expect(readdirSync(join(state, "evidence"))).toEqual([]);
	});

	// A lens file's toJSON runs once every stage path is checked and before any is made: another writer's moment.
	function racing(act: (state: string) => void): { state: string; evidence: MissEvidence } {
		const state = scratch();
		const lensFile = { lens: "correctness@1", file: "LENS.md", blob: "d".repeat(40) };
		const file = {
			...lensFile,
			toJSON: () => {
				act(state);
				return lensFile;
			},
		};
		return {
			state,
			evidence: MissEvidence.from({ ...evidence(first).pointer, lensFiles: [file] }, [conversation(1, "p")]),
		};
	}

	it("refuses a stages directory another writer made a link after the check", async () => {
		const elsewhere = scratch();
		const { state, evidence: raced } = racing((at) => {
			mkdirSync(join(at, "evidence", changeset, "r1"), { recursive: true });
			symlinkSync(elsewhere, join(at, "evidence", changeset, "r1", "stages"));
		});
		await expect(EvidenceStore.open(state).write(raced)).rejects.toMatchObject({ code: "link" });
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	it("refuses a stages directory another writer made a file after the check", async () => {
		const { state, evidence: raced } = racing((at) => {
			mkdirSync(join(at, "evidence", changeset, "r1"), { recursive: true });
			writeFileSync(join(at, "evidence", changeset, "r1", "stages"), "");
		});
		await expect(EvidenceStore.open(state).write(raced)).rejects.toMatchObject({ code: "unreadable" });
	});

	it("refuses a stage file another writer made a link after the check", async () => {
		const elsewhere = scratch();
		const { state, evidence: raced } = racing((at) => {
			mkdirSync(join(at, "evidence", changeset, "r1", "stages"), { recursive: true });
			symlinkSync(
				join(elsewhere, "file"),
				join(at, "evidence", changeset, "r1", "stages", "conversation-1.json.gz"),
			);
		});
		await expect(EvidenceStore.open(state).write(raced)).rejects.toMatchObject({ code: "link" });
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	describe("reading back", () => {
		const pointerAt = (state: string, local: string, id: string) =>
			join(state, "evidence", changeset, local, "misses", `${id}.json`);

		async function written(): Promise<string> {
			const state = scratch();
			await EvidenceStore.open(state).write(evidence(first, conversation(1, "prompt")));
			return state;
		}

		it("refuses a pointer that names another miss", async () => {
			const state = await written();
			writeFileSync(pointerAt(state, "r1", second), readFileSync(pointerAt(state, "r1", first)));
			await expect(EvidenceStore.open(state).read(changeset, round, second)).rejects.toMatchObject({
				code: "unreadable",
				message: expect.stringContaining("is not this miss's evidence"),
			});
		});

		it("refuses a pointer that names another round", async () => {
			const state = await written();
			mkdirSync(join(state, "evidence", changeset, "r2", "misses"), { recursive: true });
			writeFileSync(pointerAt(state, "r2", first), readFileSync(pointerAt(state, "r1", first)));
			await expect(EvidenceStore.open(state).read(changeset, `${changeset}.r2`, first)).rejects.toMatchObject({
				code: "unreadable",
				message: expect.stringContaining("is not this miss's evidence"),
			});
		});

		it("refuses a pointer of another version", async () => {
			const state = await written();
			const pointer = JSON.parse(readFileSync(pointerAt(state, "r1", first), "utf8")) as EvidencePointer;
			writeFileSync(pointerAt(state, "r1", first), JSON.stringify({ ...pointer, version: 2 }));
			await expect(EvidenceStore.open(state).read(changeset, round, first)).rejects.toMatchObject({
				code: "unreadable",
				message: expect.stringContaining("is not this miss's evidence"),
			});
		});

		it("refuses a pointer whose stage file is missing", async () => {
			const state = await written();
			rmSync(join(state, "evidence", changeset, "r1", "stages", "conversation-1.json.gz"));
			await expect(EvidenceStore.open(state).read(changeset, round, first)).rejects.toMatchObject({
				code: "unreadable",
			});
		});

		it("passes on an error other than a missing path, in a read and in its size", async () => {
			const parent = scratch();
			const state = join(parent, "state");
			writeFileSync(state, "");
			const store = EvidenceStore.open(state);
			await expect(store.read(changeset, round, first)).rejects.toMatchObject({ code: "ENOTDIR" });
			await expect(store.size()).rejects.toMatchObject({ code: "ENOTDIR" });
		});

		it("sizes every file at every depth, and no link", async () => {
			const state = await written();
			writeFileSync(join(state, "evidence", "stray"), "12345");
			writeFileSync(join(state, "evidence", changeset, "r1", "note"), "123");
			symlinkSync(join(state, "evidence", "stray"), join(state, "evidence", "linked"));
			const total = files(join(state, "evidence"))
				.filter((path) => path !== "linked")
				.reduce((sum, path) => sum + statSync(join(state, "evidence", path)).size, 0);
			expect(await EvidenceStore.open(state).size()).toBe(total);
		});
	});

	describe("the 16 MiB stage bound", () => {
		// A conversation whose stage file is `limit + extra` bytes before compression, with a filler reply after its
		// prompt and instructions.
		function sized(extra: number): EvidenceConversation {
			// Six entries, so a byte count of dropped entries with the wrong sign is a digit longer.
			const at = (filler: string) =>
				spoken(
					1,
					["pi.user", "the prompt"],
					["pi.system", "the brief"],
					["pi.assistant", filler],
					["pi.tool-result", "a"],
					["pi.assistant", "b"],
					["pi.assistant", "the last reply"],
				);
			const empty = Buffer.byteLength(JSON.stringify({ version: 1, ...at(""), dropped: 0 }));
			return at("x".repeat(evidenceLimits.stage - empty + extra));
		}

		it("keeps every entry of a conversation at the bound", async () => {
			const state = scratch();
			await EvidenceStore.open(state, { budget: 2 * evidenceLimits.stage }).write(evidence(first, sized(0)));
			const { text, value } = stored(state, 1);
			expect(Buffer.byteLength(text)).toBe(evidenceLimits.stage);
			expect(value).toEqual({ version: 1, ...sized(0), dropped: 0 });
		});

		it("keeps the prompt, the instructions and the last that fit, one byte past the bound, and counts the rest", async () => {
			const state = scratch();
			await EvidenceStore.open(state, { budget: 2 * evidenceLimits.stage }).write(evidence(first, sized(1)));
			const { text, value } = stored(state, 1);
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(evidenceLimits.stage);
			const whole = sized(1);
			expect(value).toEqual({
				version: 1,
				stage: whole.stage,
				entries: [...whole.entries.slice(0, 2), ...whole.entries.slice(3)],
				dropped: 1,
			});
		});

		it("keeps a lens's instructions ahead of twenty large tool results", async () => {
			const state = scratch();
			const results = Array.from({ length: 20 }, () => ["pi.tool-result", "x".repeat(1024 ** 2)] as const);
			const long = spoken(
				1,
				["pi.user", "the prompt"],
				["pi.system", "the brief"],
				["pi.assistant", "the calls"],
				...results,
			);
			await EvidenceStore.open(state, { budget: 2 * evidenceLimits.stage }).write(evidence(first, long));
			expect(stored(state, 1).value).toEqual({
				version: 1,
				stage: long.stage,
				entries: [...long.entries.slice(0, 2), ...long.entries.slice(8)],
				dropped: 6,
			});
		});

		it("keeps the leading entries that fit from the first, then the last that fit, when they alone pass the bound", async () => {
			const state = scratch();
			const huge = spoken(
				1,
				["pi.user", "the prompt"],
				["pi.system", "x".repeat(evidenceLimits.stage)],
				["pi.assistant", "a reply"],
			);
			await EvidenceStore.open(state, { budget: 2 * evidenceLimits.stage }).write(evidence(first, huge));
			expect(stored(state, 1).value).toEqual({
				version: 1,
				stage: huge.stage,
				entries: [huge.entries[0], huge.entries[2]],
				dropped: 1,
			});
		});

		it("keeps no entry when a leading entry fills the bound and nothing follows the leading entries", async () => {
			const state = scratch();
			const huge = spoken(1, ["pi.user", "x".repeat(evidenceLimits.stage)], ["pi.system", "the brief"]);
			await EvidenceStore.open(state, { budget: 2 * evidenceLimits.stage }).write(evidence(first, huge));
			expect(stored(state, 1).value).toEqual({ version: 1, stage: huge.stage, entries: [], dropped: 2 });
		});

		// A conversation with no reply, whose stage file is `limit + extra` bytes before compression.
		function unanswered(extra: number): EvidenceConversation {
			const at = (filler: string) => conversation(1, "the prompt", filler, "the brief");
			const empty = Buffer.byteLength(JSON.stringify({ version: 1, ...at(""), dropped: 0 }));
			return at("x".repeat(evidenceLimits.stage - empty + extra));
		}

		it("keeps every leading entry of a conversation with no reply at the bound", async () => {
			const state = scratch();
			await EvidenceStore.open(state, { budget: 2 * evidenceLimits.stage }).write(evidence(first, unanswered(0)));
			const { text, value } = stored(state, 1);
			expect(Buffer.byteLength(text)).toBe(evidenceLimits.stage);
			expect(value).toEqual({ version: 1, ...unanswered(0), dropped: 0 });
		});

		it("keeps the leading entries that fit from the first, one byte past the bound, with no reply", async () => {
			const state = scratch();
			await EvidenceStore.open(state, { budget: 2 * evidenceLimits.stage }).write(evidence(first, unanswered(1)));
			const whole = unanswered(1);
			expect(stored(state, 1).value).toEqual({
				version: 1,
				stage: whole.stage,
				entries: whole.entries.slice(0, 2),
				dropped: 1,
			});
		});

		it("counts every entry of a conversation with no reply as leading", async () => {
			const state = scratch();
			const huge = conversation(1, "the prompt", "x".repeat(evidenceLimits.stage), "the brief");
			await EvidenceStore.open(state, { budget: 2 * evidenceLimits.stage }).write(evidence(first, huge));
			expect(stored(state, 1).value).toEqual({
				version: 1,
				stage: huge.stage,
				entries: [huge.entries[0]],
				dropped: 2,
			});
		});
	});

	describe("the budget", () => {
		const one = () => evidence(first, conversation(1, "prompt", "reply"));
		const two = () => evidence(second, conversation(2, "prompt", "another reply"));

		async function measured(): Promise<{ afterOne: number; afterTwo: number }> {
			const state = scratch();
			const store = EvidenceStore.open(state);
			await store.write(one());
			const afterOne = await store.size();
			await store.write(two());
			return { afterOne, afterTwo: await store.size() };
		}

		it("accepts a write that fills the budget exactly, counting what the directory holds", async () => {
			const { afterTwo } = await measured();
			const state = scratch();
			const store = EvidenceStore.open(state, { budget: afterTwo });
			await store.write(one());
			await store.write(two());
			expect(await store.size()).toBe(afterTwo);
			await store.write(two());
			expect(await store.size()).toBe(afterTwo);
		});

		it("refuses a write one byte past the budget, naming the directory and prune, and writes none of it", async () => {
			const { afterOne, afterTwo } = await measured();
			const state = scratch();
			const store = EvidenceStore.open(state, { budget: afterTwo - 1 });
			await store.write(one());
			const refusal = store.write(two());
			await expect(refusal).rejects.toMatchObject({ code: "budget" });
			await expect(refusal).rejects.toThrow(`${join(state, "evidence", changeset)}/ `);
			await expect(refusal).rejects.toThrow(
				"melian store prune keeps evidence, and lists what is more than 90 days old",
			);
			await expect(refusal).rejects.toThrow(
				"Raise evidence.budget in your configuration until issue #633 (https://github.com/melian-agent/melian/issues/633) lets prune remove it.",
			);
			await expect(refusal).rejects.toThrow("This refusal wrote no file and lost no evidence already kept");
			await expect(refusal).rejects.not.toThrow("by hand");
			expect(await store.size()).toBe(afterOne);
			expect(files(join(state, "evidence"))).toEqual([
				`${changeset}/r1/misses/${first}.json`,
				`${changeset}/r1/stages/conversation-1.json.gz`,
			]);
		});

		it("refuses the first write past the budget and leaves no directory", async () => {
			const { afterOne } = await measured();
			const state = scratch();
			await expect(EvidenceStore.open(state, { budget: afterOne - 1 }).write(one())).rejects.toMatchObject({
				code: "budget",
			});
			expect(existsSync(join(state, "evidence"))).toBe(false);
		});

		it("defaults to 1 GiB, and sizes a missing directory as empty", async () => {
			const store = EvidenceStore.open(scratch());
			expect(store.budget).toBe(1024 ** 3);
			expect(await store.size()).toBe(0);
		});
	});
});

describe("MissEvidence.stagesAt", () => {
	const site = { file: "src/user.ts", start: 10, end: 12 };
	const coverage = { scope: "", paths: ["src/**"], nearer: [] };

	function reported(
		options: { file?: string; start?: number; end?: number; check?: string; snippet?: string },
		extra: Partial<StoredFinding["properties"]> = {},
	): Finding {
		const made = Finding.create({
			rule: "null-deref",
			file: options.file ?? site.file,
			startLine: options.start ?? 10,
			endLine: options.end ?? options.start ?? 10,
			snippet: options.snippet ?? "user.name",
			occurrence: 0,
			severity: "P1",
			cause: "introduced",
			message: "A null user",
			source: { check: options.check ?? "lens.correctness", version: "1" },
			explanation: { what: "Null", whyHere: "New read", whatToDo: "Check it" },
		}).toJSON();
		return Finding.from({ ...made, properties: { ...made.properties, ...extra } });
	}

	const lens = (conversation: number, overrides: Partial<Stage> = {}): Stage => ({
		...stage(conversation),
		coverage,
		...overrides,
	});
	const verifier = (conversation: number, subject: string): Stage => ({
		...stage(conversation),
		name: "melian.verification.candidate",
		subject,
	});
	const ids = (stages: readonly Stage[]) => stages.map((each) => each.id);

	it("keeps no run for a miss with no site", () => {
		expect(MissEvidence.stagesAt([lens(1)], [reported({})], undefined)).toEqual([]);
	});

	it("keeps each lens run whose coverage holds the file, and no other run", () => {
		const stages = [
			lens(1),
			lens(2, { coverage: { ...coverage, paths: ["docs/**"] } }),
			lens(3, { coverage: undefined }),
			lens(4, { conversation: undefined }),
			lens(5, { name: "melian.check" }),
		];
		expect(ids(MissEvidence.stagesAt(stages, [], site))).toEqual(["conversation:1"]);
	});

	it("keeps a verifier of a lens finding whose lines meet the site's at either end, and none past them", () => {
		const at = (start: number, end: number) => reported({ start, end, snippet: `line ${start}` });
		const meetsEnd = at(12, 14);
		const meetsStart = at(8, 10);
		const before = at(5, 9);
		const after = at(13, 15);
		const stages = [meetsEnd, meetsStart, before, after].map((finding, index) =>
			verifier(index + 1, finding.properties.id),
		);
		expect(ids(MissEvidence.stagesAt(stages, [meetsEnd, meetsStart, before, after], site))).toEqual([
			"conversation:1",
			"conversation:2",
		]);
	});

	it("keeps no verifier of a finding at another file, or of a check's finding", () => {
		const elsewhere = reported({ file: "src/other.ts" });
		const checked = reported({ check: "static.biome", snippet: "other" });
		const stages = [verifier(1, elsewhere.properties.id), verifier(2, checked.properties.id)];
		expect(MissEvidence.stagesAt(stages, [elsewhere, checked], site)).toEqual([]);
	});

	it("keeps a verifier of any claim the site's finding carries, from a lens", () => {
		const finding = reported(
			{},
			{
				alsoReportedAs: [
					{ id: "a".repeat(16), ruleId: "x", check: "lens.tests" },
					{ id: "b".repeat(16), ruleId: "x", check: "static.tsc" },
				],
				otherClaims: [{ id: "c".repeat(16), ruleId: "x", source: { check: "lens.tests", version: "1" } }],
			},
		);
		const stages = [
			verifier(1, `${"9".repeat(16)},${"a".repeat(16)}`),
			verifier(2, "b".repeat(16)),
			verifier(3, "c".repeat(16)),
			verifier(4, "d".repeat(16)),
			{ ...verifier(5, finding.properties.id), name: "melian.verification" },
			{ ...verifier(6, finding.properties.id), conversation: undefined },
		];
		expect(ids(MissEvidence.stagesAt(stages, [finding], site))).toEqual(["conversation:1", "conversation:3"]);
	});
});

describe("MissEvidence", () => {
	const miss = ExternalFinding.create({
		reviewer: { name: "codex" },
		file: "src/user.ts",
		line: 10,
		title: "a miss",
		body: "body",
		source: { kind: "file", path: "codex.json", position: 0 },
	});
	const verdict = () =>
		new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig }).adjudicate();
	const decided = (provenance?: { policy: string }) =>
		new Round(round, {
			base: "b".repeat(40),
			head: "c".repeat(40),
			tasks: [4],
			verdict: verdict().toJSON(),
			...(provenance === undefined ? {} : { provenance }),
		} as Round["stored"]);

	it.each([
		["the round's policy", { policy: `revision:${"d".repeat(40)}` }, `revision:${"d".repeat(40)}`],
		["config, for a round that records no provenance", undefined, "config"],
	])(
		"gathers a pointer to the round's commits with %s, and nothing a clone without its run holds",
		async (_, provenance, policy) => {
			const gathered = await MissEvidence.gather(createMemoryStorage(), {
				round: decided(provenance),
				verdict: verdict(),
				finding: miss,
			});

			expect({ pointer: gathered.pointer, stages: gathered.stages }).toEqual({
				pointer: {
					version: 1,
					changeset,
					round,
					external: miss.id,
					base: "b".repeat(40),
					head: "c".repeat(40),
					policy,
					lensFiles: [],
					stages: [],
				},
				stages: [],
			});
		},
	);

	it("reads every page of a stage's conversation, oldest first, asking only for that conversation", async () => {
		const all = Array.from({ length: 450 }, (_, index) => entry(9, index + 1));
		const asked: unknown[] = [];
		const storage = {
			scanEntries: async (query: unknown, limit: number, cursor: number | undefined) => {
				asked.push(cursor);
				expect({ query, limit }).toEqual({ query: { conversationId: 9, order: "ascending" }, limit: 200 });
				const start = cursor ?? 0;
				const next = start + limit < all.length ? start + limit : undefined;
				return { items: all.slice(start, start + limit), next };
			},
		} as unknown as Storage;

		const read = await MissEvidence.conversation(storage, stage(9));

		expect(read).toEqual({ stage: stage(9), entries: all });
		expect(asked).toEqual([undefined, 200, 400]);
	});

	it("names each lens of its lens runs once, by name and version, and no verifier", () => {
		const verifier = { stage: { ...stage(3), name: "melian.verification.candidate", subject: "a@b@c" }, entries: [] };
		const tests = { stage: { ...stage(4), subject: "tests@2@quick" }, entries: [] };

		expect(evidence(first, conversation(1), conversation(2), verifier, tests).lenses()).toEqual([
			"correctness@1",
			"tests@2",
		]);
	});

	it("takes the lens files it is given in place of the pointer's, as copies", () => {
		const files = [{ lens: "correctness@1", file: ".melian/lenses/correctness/LENS.md", blob: "e".repeat(40) }];
		const kept = evidence(first, conversation(1)).withLensFiles(files);
		files[0]!.blob = "f".repeat(40);

		expect(kept.pointer.lensFiles).toEqual([{ ...files[0], blob: "e".repeat(40) }]);
		expect(kept.pointer.stages).toEqual(["conversation:1"]);
	});
});
