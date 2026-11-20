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
import {
	type EntryRecord,
	type EvidenceConversation,
	type EvidencePointer,
	EvidenceStore,
	evidenceLimits,
	MissEvidence,
	type Stage,
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

function entry(conversation: number, id: number, text = `entry ${id}`): EntryRecord {
	return { id, conversationId: conversation, kind: "message", data: { text } } as unknown as EntryRecord;
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
		["changeset", { changeset: "range-xyz" }],
		["round", { round: `${changeset}.r0` }],
		["round of another changeset", { round: `range-${"b".repeat(16)}.r1` }],
		["external ID", { external: "../../escape" }],
	])("refuses an unsafe %s before it reaches a path", async (_, change) => {
		const state = scratch();
		const pointer = { ...evidence(first).pointer, ...change };
		await expect(
			EvidenceStore.open(state).write(MissEvidence.from(pointer, [conversation(1, "prompt")])),
		).rejects.toMatchObject({ code: "unsafeName" });
		expect(existsSync(join(state, "evidence"))).toBe(false);
	});

	it("refuses a stage ID that is not a conversation's", async () => {
		const state = scratch();
		const bad = { ...conversation(1, "prompt"), stage: { ...stage(1), id: "conversation:../1" } };
		await expect(EvidenceStore.open(state).write(evidence(first, bad))).rejects.toMatchObject({
			code: "unsafeName",
		});
		expect(existsSync(join(state, "evidence"))).toBe(false);
	});

	describe("the 16 MiB stage bound", () => {
		// A conversation whose stage file is `limit + extra` bytes before compression, with a filler entry in its middle.
		function sized(extra: number): EvidenceConversation {
			const at = (filler: string) => conversation(1, "the prompt", filler, "the last reply");
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

		it("keeps the first entry and the last that fit, one byte past the bound, and counts the rest", async () => {
			const state = scratch();
			await EvidenceStore.open(state, { budget: 2 * evidenceLimits.stage }).write(evidence(first, sized(1)));
			const { text, value } = stored(state, 1);
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(evidenceLimits.stage);
			const whole = sized(1);
			expect(value).toEqual({
				version: 1,
				stage: whole.stage,
				entries: [whole.entries[0], whole.entries[2]],
				dropped: 1,
			});
		});

		it("keeps no entry when the first alone passes the bound", async () => {
			const state = scratch();
			const huge = conversation(1, "x".repeat(evidenceLimits.stage), "a reply");
			await EvidenceStore.open(state, { budget: 2 * evidenceLimits.stage }).write(evidence(first, huge));
			expect(stored(state, 1).value).toEqual({ version: 1, stage: huge.stage, entries: [], dropped: 2 });
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
			await expect(refusal).rejects.toThrow(join(state, "evidence"));
			await expect(refusal).rejects.toThrow("melian store prune");
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
