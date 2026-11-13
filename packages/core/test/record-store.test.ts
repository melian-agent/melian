import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DirectoryRecordStore,
	MemoryRecordSpace,
	MemoryRecordStore,
	type RecordCell,
	type RecordEnvelope,
	RecordError,
	type RecordStore,
	SharedRecord,
} from "@melian-agent/core";
import {
	directoryRecordStoreFixture,
	memoryRecordStoreFixture,
	type RecordStoreFixture,
	recordStoreConformance,
} from "@melian-agent/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rejection, removeDirectory, temporaryDirectory } from "./fixtures/repo.ts";

const changeset = "pull-0123456789abcdef";

describe.each([
	["memory", memoryRecordStoreFixture()],
	["directory", directoryRecordStoreFixture()],
])("the record store conformance suite on the %s adapter", (_name, fixture) => {
	it.each(recordStoreConformance.map((each) => [each.name, each] as const))("%s", async (_case, each) => {
		await each.run(fixture);
	});
});

// Each adapter here breaks one promise of the port. The suite proves that promise only if its case then fails.
class Broken implements RecordStore {
	readonly inner: RecordStore;
	readonly breaks: Partial<RecordStore>;

	constructor(inner: RecordStore, breaks: (inner: RecordStore) => Partial<RecordStore>) {
		this.inner = inner;
		this.breaks = breaks(inner);
	}

	add(records: RecordEnvelope[]): Promise<void> {
		return (this.breaks.add ?? this.inner.add.bind(this.inner))(records);
	}
	list(name: string): Promise<RecordEnvelope[]> {
		return (this.breaks.list ?? this.inner.list.bind(this.inner))(name);
	}
	readCell(name: string): Promise<RecordCell> {
		return (this.breaks.readCell ?? this.inner.readCell.bind(this.inner))(name);
	}
	writeCell(name: string, expected: string | undefined, value: string): Promise<boolean> {
		return (this.breaks.writeCell ?? this.inner.writeCell.bind(this.inner))(name, expected, value);
	}
	dispose(name: string): Promise<void> {
		return (this.breaks.dispose ?? this.inner.dispose.bind(this.inner))(name);
	}
	close(): Promise<void> {
		return this.inner.close();
	}
}

function brokenFixture(breaks: (inner: RecordStore) => Partial<RecordStore>): RecordStoreFixture {
	const healthy = memoryRecordStoreFixture();
	return async () => {
		const subject = await healthy();
		return { ...subject, open: async () => new Broken(await subject.open(), breaks) };
	};
}

const cutOffAnswer = <T>(answer: T, code = "unreachable") =>
	async function (this: void, call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (error instanceof RecordError && error.code === code) return answer;
			throw error;
		}
	};

let stale: RecordEnvelope[] | undefined;
let staleCell: RecordCell | undefined;

const breakages: [string, string, (inner: RecordStore) => Partial<RecordStore>][] = [
	[
		"add keeps a repeated record twice",
		"add: the same bytes added twice are one record, and a repeat completes a batch",
		(inner) => {
			const extra: RecordEnvelope[] = [];
			return {
				add: async (records) => {
					await inner.add(records);
					extra.push(...records);
				},
				list: async (name) => [...(await inner.list(name)), ...extra.filter((each) => each.changeset === name)],
			};
		},
	],
	[
		"add keeps one record per slot",
		"add: two records in one slot are both kept",
		(inner) => {
			const slots = new Set<string>();
			return {
				add: async (records) => {
					for (const record of records) {
						const slot = `${record.kind} ${record.key}`;
						if (slots.has(slot)) continue;
						slots.add(slot);
						await inner.add([record]);
					}
				},
			};
		},
	],
	[
		"add lands the valid records of a batch before it refuses an invalid one",
		"add: refuses an invalid record before any of its batch lands",
		(inner) => ({
			add: async (records) => {
				for (const record of records) await inner.add([record]);
			},
		}),
	],
	[
		"list answers from the copy it read first",
		"list: returns every record whose add returned before it, on any handle, and only its changeset's",
		(inner) => ({
			list: async (name) => {
				stale ??= await inner.list(name);
				return stale;
			},
		}),
	],
	[
		"list answers nothing when cut off",
		"list: fails when the store cannot answer it fresh",
		(inner) => ({ list: (name) => cutOffAnswer<RecordEnvelope[]>([])(() => inner.list(name)) }),
	],
	[
		"list fails cut off with a plain error that carries the code",
		"list: fails when the store cannot answer it fresh",
		(inner) => ({
			list: (name) =>
				inner.list(name).catch((error: unknown) => {
					throw Object.assign(new Error("cut off"), { code: (error as RecordError).code });
				}),
		}),
	],
	[
		"list fails cut off with a RecordError of another code",
		"list: fails when the store cannot answer it fresh",
		(inner) => ({
			list: (name) =>
				inner.list(name).catch(() => {
					throw new RecordError("closed", "cut off");
				}),
		}),
	],
	[
		"readCell answers from the copy it read first",
		"readCell: returns the last value a writeCell stored, on any handle",
		(inner) => ({
			readCell: async (name) => {
				const fresh = await inner.readCell(name);
				if (fresh.value !== undefined) staleCell ??= fresh;
				return staleCell ?? fresh;
			},
		}),
	],
	[
		"readCell answers an empty cell when cut off",
		"readCell: fails when the store cannot answer it fresh",
		(inner) => ({ readCell: (name) => cutOffAnswer<RecordCell>({})(() => inner.readCell(name)) }),
	],
	[
		"add swallows a store it cannot reach",
		"add and writeCell: fail when the store cannot be reached",
		(inner) => ({ add: (records) => cutOffAnswer<void>(undefined)(() => inner.add(records)) }),
	],
	[
		"writeCell reports a lost write when cut off",
		"add and writeCell: fail when the store cannot be reached",
		(inner) => ({
			writeCell: (name, expected, value) => cutOffAnswer(false)(() => inner.writeCell(name, expected, value)),
		}),
	],
	[
		"writeCell ignores the expected version",
		"writeCell: succeeds only while the version is still the expected one",
		(inner) => ({
			writeCell: async (name, _expected, value) =>
				inner.writeCell(name, (await inner.readCell(name)).version, value),
		}),
	],
	...(
		[
			"writeCell: every successful write changes the version, the same value included",
			"writeCell: refuses a version whose value went away and came back",
		] as const
	).map(
		(name) =>
			[
				`the version is a hash of the value, under ${name}`,
				name,
				(inner: RecordStore) => ({
					readCell: async (cell: string) => {
						const read = await inner.readCell(cell);
						return read.value === undefined ? read : { value: read.value, version: hash(read.value) };
					},
					writeCell: async (cell: string, expected: string | undefined, value: string) => {
						const read = await inner.readCell(cell);
						const current = read.value === undefined ? undefined : hash(read.value);
						return current === expected && inner.writeCell(cell, read.version, value);
					},
				}),
			] as [string, string, (inner: RecordStore) => Partial<RecordStore>],
	),
	[
		"writeCell compares and sets in two steps",
		"writeCell: of two writers racing from one version, exactly one wins",
		(inner) => ({
			writeCell: async (name, expected, value) => {
				const { version } = await inner.readCell(name);
				if (version !== expected) return false;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return inner.writeCell(name, (await inner.readCell(name)).version, value);
			},
		}),
	],
	[
		"writeCell lets a caller write the disposal mark",
		"writeCell: refuses the disposal mark, which only dispose writes",
		(inner) => ({
			writeCell: async (name, expected, value) => {
				if (value !== '{"disposed":true}') return inner.writeCell(name, expected, value);
				await inner.dispose(name);
				return true;
			},
		}),
	],
	[
		"writeCell stores a lone surrogate it cannot keep",
		"writeCell: refuses a value no adapter could store unchanged",
		(inner) => ({
			writeCell: (name, expected, value) => inner.writeCell(name, expected, value.toWellFormed()),
		}),
	],
	[
		"dispose removes the records and leaves no mark",
		"dispose: marks the cell, removes the records for good, and leaves other changesets",
		(inner) => {
			const gone = new Set<string>();
			return {
				dispose: async (name) => {
					gone.add(name);
				},
				list: async (name) => (gone.has(name) ? [] : inner.list(name)),
			};
		},
	],
	[
		"list answers past an entry it did not write",
		"list and add refuse an entry the store did not write, and write nothing through it",
		(inner) => ({ list: (name) => cutOffAnswer<RecordEnvelope[]>([], "unknownFile")(() => inner.list(name)) }),
	],
	[
		"add skips past an entry it did not write",
		"list and add refuse an entry the store did not write, and write nothing through it",
		(inner) => ({ add: (records) => cutOffAnswer<void>(undefined, "unknownFile")(() => inner.add(records)) }),
	],
	[
		"a changeset name reaches the adapter unchecked",
		"every call refuses a changeset name no envelope could hold, and takes a dotted one",
		() => ({ list: async () => [] }),
	],
];

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("each conformance case fails against an adapter that breaks its promise", () => {
	beforeEach(() => {
		stale = undefined;
		staleCell = undefined;
	});

	it("names a case of the suite for every breakage, and a breakage for every case", () => {
		const names = recordStoreConformance.map((each) => each.name);
		for (const [, name] of breakages) expect(names).toContain(name);
		expect(new Set(breakages.map(([, name]) => name))).toEqual(new Set(names));
	});

	it.each(breakages)("%s", async (_breakage, name, breaks) => {
		const target = recordStoreConformance.find((each) => each.name === name);
		expect(target).toBeDefined();
		await expect(target?.run(memoryRecordStoreFixture())).resolves.toBeUndefined();
		await expect(target?.run(brokenFixture(breaks))).rejects.toThrow();
	});
});

describe("the conformance suite's own bookkeeping", () => {
	it.each(recordStoreConformance.map((each) => [each.name, each] as const))(
		"%s closes every store it opens",
		async (_name, each) => {
			const healthy = memoryRecordStoreFixture();
			let opened = 0;
			let closed = 0;
			await each.run(async () => {
				const subject = await healthy();
				opened++;
				return {
					...subject,
					close: async () => {
						closed++;
						await subject.close();
					},
				};
			});
			expect([opened, closed]).toEqual([1, 1]);
		},
	);
});

describe("MemoryRecordStore", () => {
	it("hands out copies, so a caller's edit never reaches the store", async () => {
		const store = new MemoryRecordStore();
		const envelope: RecordEnvelope = { v: 1, changeset, kind: "check", key: "k", payload: { n: 1 } };
		await store.add([envelope]);
		(envelope.payload as { n: number }).n = 2;
		const [listed] = await store.list(changeset);
		(listed?.payload as { n: number }).n = 3;
		expect((await store.list(changeset))[0]?.payload).toEqual({ n: 1 });
	});

	it("refuses every call once closed", async () => {
		const store = new MemoryRecordStore();
		await store.close();
		const error = await rejection(store.list(changeset), RecordError);
		expect(error.code).toBe("closed");
		expect(error.message).toBe("the record store is closed");
	});

	it("says why it refuses", async () => {
		const space = new MemoryRecordSpace();
		const store = new MemoryRecordStore(space);
		const message = async (call: Promise<unknown>) => (await rejection(call, RecordError)).message;
		expect(await message(store.list("../x"))).toBe('"../x" is not a changeset name');
		expect(await message(store.writeCell(changeset, undefined, '{"disposed":true}'))).toBe(
			"only dispose writes the disposal mark",
		);
		expect(await message(store.writeCell(changeset, undefined, String.fromCharCode(0xdc00)))).toBe(
			"a cell holds no lone surrogate",
		);
		await store.dispose(changeset);
		expect(await message(store.add([{ v: 1, changeset, kind: "check", key: "k", payload: {} }]))).toBe(
			`changeset ${changeset} is disposed`,
		);
		space.disconnect();
		expect(await message(store.list(changeset))).toBe("the memory record space is disconnected");
	});
});

describe("DirectoryRecordStore", () => {
	let root: string;
	const envelope: RecordEnvelope = { v: 1, changeset, kind: "check", key: "static.biome", payload: { n: 1 } };
	const record = SharedRecord.parse(envelope);

	beforeEach(() => {
		root = temporaryDirectory();
	});

	afterEach(() => {
		removeDirectory(root);
	});

	it("refuses every call once closed", async () => {
		const store = await DirectoryRecordStore.open(root);
		await store.close();
		const error = await rejection(store.readCell(changeset), RecordError);
		expect(error.code).toBe("closed");
		expect(error.message).toBe("the record store is closed");
	});

	it("files a record at its path, as its canonical bytes", async () => {
		const store = await DirectoryRecordStore.open(root);
		await store.add([envelope]);
		expect(readFileSync(join(root, record.path), "utf8")).toBe(record.bytes);
	});

	it.each([
		[
			"bytes that do not give their own ID",
			(path: string) => writeFileSync(path, record.bytes.replace('"n":1', '"n":2')),
		],
		["bytes that are not canonical", (path: string) => writeFileSync(path, `${record.bytes}\n`)],
		[
			"a record of another changeset",
			(path: string) => {
				const moved = SharedRecord.parse({ ...envelope, changeset: "pull-fedcba9876543210" });
				writeFileSync(join(path, "..", `${moved.id}.json`), moved.bytes);
			},
		],
		["a stray file beside a record", (path: string) => writeFileSync(join(path, "..", "notes.txt"), "x")],
		["a stray file in a kind", (path: string) => writeFileSync(join(path, "..", "..", "stray.json"), "x")],
		["a stray file in a changeset", (path: string) => writeFileSync(join(path, "..", "..", "..", "stray.json"), "x")],
		[
			"a symbolic link in place of a record",
			(path: string) => {
				renameSync(path, join(root, "real.json"));
				symlinkSync(join(root, "real.json"), path);
			},
		],
		[
			"a stray file in the cell",
			() => {
				const cell = join(root, "changesets", changeset, ".cell");
				mkdirSync(cell, { recursive: true });
				writeFileSync(join(cell, "notes.txt"), "x");
			},
		],
	])("refuses a listing that holds %s, naming the file", async (_name, tamper) => {
		const store = await DirectoryRecordStore.open(root);
		await store.add([envelope]);
		tamper(join(root, record.path));
		const error = await rejection(store.list(changeset), RecordError);
		expect(error.code).toBe("unknownFile");
		expect(error.path).toMatch(new RegExp(`^${root}/changesets/`));
	});

	it("is not blocked by a temporary file a writer that died left behind", async () => {
		const store = await DirectoryRecordStore.open(root);
		expect(await store.writeCell(changeset, undefined, "lease A")).toBe(true);
		writeFileSync(join(root, "tmp", "left-by-a-dead-writer"), "x");
		const { version } = await store.readCell(changeset);
		expect(await store.writeCell(changeset, version, "lease B")).toBe(true);
		await store.add([envelope]);
		expect(await store.list(changeset)).toEqual([envelope]);
	});

	it("lists nothing for a disposed changeset, though a record a dying add left lands after the mark", async () => {
		const store = await DirectoryRecordStore.open(root);
		await store.dispose(changeset);
		mkdirSync(join(root, record.path, ".."), { recursive: true });
		writeFileSync(join(root, record.path), record.bytes);
		expect(await store.list(changeset)).toEqual([]);
		expect((await rejection(store.add([envelope]), RecordError)).code).toBe("disposed");
		await store.dispose(changeset);
		expect(readdirSync(join(root, "changesets", changeset))).toEqual([".cell"]);
	});

	it("keeps its records, its cell's version and a disposal across a reopen", async () => {
		const first = await DirectoryRecordStore.open(root);
		await first.add([envelope]);
		await first.writeCell(changeset, undefined, "lease A");
		await first.writeCell(changeset, "1", "lease B");
		await first.dispose("pull-fedcba9876543210");
		await first.close();
		const second = await DirectoryRecordStore.open(root);
		expect(await second.list(changeset)).toEqual([envelope]);
		expect(await second.readCell(changeset)).toEqual({ value: "lease B", version: "2" });
		expect(await second.writeCell(changeset, "1", "lease C")).toBe(false);
		const disposed = { ...envelope, changeset: "pull-fedcba9876543210" };
		expect((await rejection(second.add([disposed]), RecordError)).code).toBe("disposed");
	});

	describe("follows no symbolic link out of the store", () => {
		let outside: string;

		beforeEach(() => {
			outside = temporaryDirectory();
		});

		afterEach(() => {
			removeDirectory(outside);
		});

		it.each([
			["the changeset's directory", () => join(root, "changesets", changeset)],
			["a kind's directory", () => join(root, "changesets", changeset, "check")],
			["a slot's directory", () => join(root, record.path, "..")],
		])("refuses to add through a link at %s", async (_name, at) => {
			const store = await DirectoryRecordStore.open(root);
			mkdirSync(join(at(), ".."), { recursive: true });
			symlinkSync(outside, at());
			const error = await rejection(store.add([envelope]), RecordError);
			expect(error.code).toBe("unknownFile");
			expect(error.path).toBe(at());
			expect(readdirSync(outside)).toEqual([]);
		});

		it("refuses a link at the cell's directory", async () => {
			const store = await DirectoryRecordStore.open(root);
			mkdirSync(join(root, "changesets", changeset));
			symlinkSync(outside, join(root, "changesets", changeset, ".cell"));
			expect((await rejection(store.writeCell(changeset, undefined, "lease"), RecordError)).code).toBe(
				"unknownFile",
			);
			expect((await rejection(store.readCell(changeset), RecordError)).code).toBe("unknownFile");
			expect(readdirSync(outside)).toEqual([]);
		});

		it.each(["changesets", "tmp"])("fails unreachable, writing nothing, when %s is a link", async (name) => {
			const store = await DirectoryRecordStore.open(root);
			removeDirectory(join(root, name));
			symlinkSync(outside, join(root, name));
			const error = await rejection(store.add([envelope]), RecordError);
			expect(error.code).toBe("unreachable");
			expect(error.path).toBe(join(root, name));
			expect(readdirSync(outside)).toEqual([]);
		});
	});

	it("reads an empty cell directory as no cell", async () => {
		const store = await DirectoryRecordStore.open(root);
		mkdirSync(join(root, "changesets", changeset, ".cell"), { recursive: true });
		expect(await store.readCell(changeset)).toEqual({});
		expect(await store.writeCell(changeset, undefined, "lease")).toBe(true);
	});

	it("leaves no temporary file behind a cell write, won or lost", async () => {
		const store = await DirectoryRecordStore.open(root);
		expect(await store.writeCell(changeset, undefined, "lease")).toBe(true);
		writeFileSync(join(root, "changesets", changeset, ".cell", "2"), "taken");
		expect(await store.writeCell(changeset, "1", "lease B")).toBe(false);
		expect(readdirSync(join(root, "tmp"))).toEqual([]);
	});

	it("makes nothing for an add to a disposed changeset", async () => {
		const store = await DirectoryRecordStore.open(root);
		await store.dispose(changeset);
		expect((await rejection(store.add([envelope]), RecordError)).code).toBe("disposed");
		expect(readdirSync(join(root, "changesets", changeset))).toEqual([".cell"]);
		expect(readdirSync(join(root, "tmp"))).toEqual([]);
	});

	it("keeps the cell out of the listing", async () => {
		const store = await DirectoryRecordStore.open(root);
		await store.writeCell(changeset, undefined, "lease");
		expect(await store.list(changeset)).toEqual([]);
		expect(readdirSync(join(root, "changesets", changeset))).toEqual([".cell"]);
	});

	it("fails rather than answer nothing from a store whose directory has gone", async () => {
		const store = await DirectoryRecordStore.open(root);
		await store.add([envelope]);
		removeDirectory(join(root, "changesets"));
		expect((await rejection(store.list(changeset), RecordError)).code).toBe("unreachable");
	});

	it("fails rather than answer nothing when changesets is a file", async () => {
		const store = await DirectoryRecordStore.open(root);
		removeDirectory(join(root, "changesets"));
		writeFileSync(join(root, "changesets"), "x");
		const error = await rejection(store.readCell(changeset), RecordError);
		expect(error.code).toBe("unreachable");
		expect(error.message).toBe(`${join(root, "changesets")} cannot be read or written`);
		expect(error.path).toBe(join(root, "changesets"));
	});

	it("names the file it refuses, and why, in its error", async () => {
		const store = await DirectoryRecordStore.open(root);
		await store.add([envelope]);
		const path = join(root, record.path);
		writeFileSync(path, record.bytes.replace('"n":1', '"n":2'));
		const error = await rejection(store.list(changeset), RecordError);
		expect(error.message).toBe(`${path} is no record or cell this store wrote`);
		expect(error.path).toBe(path);
		expect((error.cause as RecordError).code).toBe("idMismatch");
	});

	it("refuses a record file whose bytes are not UTF-8, though their lossy decoding gives its name", async () => {
		const store = await DirectoryRecordStore.open(root);
		const lossy = SharedRecord.parse({ ...envelope, key: "\ufffd" });
		const bytes = Buffer.from(lossy.bytes, "utf8");
		const at = bytes.indexOf(Buffer.from("\ufffd", "utf8"));
		const invalid = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 3)]);
		mkdirSync(join(root, lossy.path, ".."), { recursive: true });
		writeFileSync(join(root, lossy.path), invalid);
		const error = await rejection(store.list(changeset), RecordError);
		expect(error.code).toBe("unknownFile");
		expect(error.path).toBe(join(root, lossy.path));
	});

	it.each([
		["no extension", (id: string) => id],
		["a second extension", (id: string) => `${id}.json.bak`],
	])("refuses a record file with %s", async (_name, name) => {
		const store = await DirectoryRecordStore.open(root);
		await store.add([envelope]);
		const path = join(root, record.path);
		renameSync(path, join(path, "..", name(record.id)));
		expect((await rejection(store.list(changeset), RecordError)).code).toBe("unknownFile");
	});

	it("refuses a record filed under another key's slot", async () => {
		const store = await DirectoryRecordStore.open(root);
		await store.add([envelope]);
		const path = join(root, record.path);
		const slot = join(path, "..", "..", "0".repeat(64));
		mkdirSync(slot);
		renameSync(path, join(slot, `${record.id}.json`));
		expect((await rejection(store.list(changeset), RecordError)).code).toBe("unknownFile");
	});

	it.each([
		["a file", (path: string) => writeFileSync(path, "x")],
		[
			"a symbolic link to a directory",
			(path: string) => {
				mkdirSync(`${path}.real`);
				symlinkSync(`${path}.real`, path);
			},
		],
	])("refuses a changeset directory that is %s", async (_name, make) => {
		const store = await DirectoryRecordStore.open(root);
		const path = join(root, "changesets", changeset);
		make(path);
		const error = await rejection(store.list(changeset), RecordError);
		expect(error.code).toBe("unknownFile");
		expect(error.path).toBe(path);
		expect((await rejection(store.readCell(changeset), RecordError)).code).toBe("unknownFile");
	});

	it.each(["0", "01", "1.json", "x1", "1x", " 1"])("refuses a cell file named %j", async (name) => {
		const store = await DirectoryRecordStore.open(root);
		await store.writeCell(changeset, undefined, "lease");
		const cell = join(root, "changesets", changeset, ".cell");
		writeFileSync(join(cell, name), "x");
		const error = await rejection(store.readCell(changeset), RecordError);
		expect(error.code).toBe("unknownFile");
		expect(error.path).toBe(join(cell, name));
		expect((await rejection(store.list(changeset), RecordError)).code).toBe("unknownFile");
	});

	it("refuses a directory in the cell", async () => {
		const store = await DirectoryRecordStore.open(root);
		await store.writeCell(changeset, undefined, "lease");
		mkdirSync(join(root, "changesets", changeset, ".cell", "2"));
		expect((await rejection(store.readCell(changeset), RecordError)).code).toBe("unknownFile");
	});

	it("refuses a cell that is a file", async () => {
		const store = await DirectoryRecordStore.open(root);
		mkdirSync(join(root, "changesets", changeset));
		writeFileSync(join(root, "changesets", changeset, ".cell"), "x");
		const error = await rejection(store.readCell(changeset), RecordError);
		expect(error.code).toBe("unknownFile");
		expect(error.path).toBe(join(root, "changesets", changeset, ".cell"));
	});

	it("refuses a cell value that is not UTF-8", async () => {
		const store = await DirectoryRecordStore.open(root);
		await store.writeCell(changeset, undefined, "lease");
		writeFileSync(join(root, "changesets", changeset, ".cell", "1"), Buffer.from([0xff]));
		expect((await rejection(store.readCell(changeset), RecordError)).code).toBe("unknownFile");
	});

	it("keeps a cell value that starts with a byte order mark", async () => {
		const store = await DirectoryRecordStore.open(root);
		expect(await store.writeCell(changeset, undefined, "\ufefflease")).toBe(true);
		expect((await store.readCell(changeset)).value).toBe("\ufefflease");
		expect(await store.writeCell(changeset, "1", '\ufeff{"disposed":true}')).toBe(true);
		await store.add([envelope]);
		expect(await store.list(changeset)).toEqual([envelope]);
	});

	it("refuses a record file whose bytes start with a byte order mark", async () => {
		const store = await DirectoryRecordStore.open(root);
		await store.add([envelope]);
		writeFileSync(join(root, record.path), `\ufeff${record.bytes}`);
		expect((await rejection(store.list(changeset), RecordError)).code).toBe("unknownFile");
	});

	it("reads the highest version by number, past nine", async () => {
		const store = await DirectoryRecordStore.open(root);
		for (let write = 1; write <= 11; write++) {
			const { version } = await store.readCell(changeset);
			expect(await store.writeCell(changeset, version, `lease ${write}`)).toBe(true);
		}
		expect(await store.readCell(changeset)).toEqual({ value: "lease 11", version: "11" });
	});

	it("fails unreachable, not with a raw error, when it cannot write its temporary file", async () => {
		const store = await DirectoryRecordStore.open(root);
		removeDirectory(join(root, "tmp"));
		expect((await rejection(store.writeCell(changeset, undefined, "lease"), RecordError)).code).toBe("unreachable");
		expect((await rejection(store.add([envelope]), RecordError)).code).toBe("unreachable");
	});

	it("refuses to add where a file stands in for a record's directory", async () => {
		const store = await DirectoryRecordStore.open(root);
		mkdirSync(join(root, "changesets", changeset));
		writeFileSync(join(root, "changesets", changeset, "check"), "x");
		const error = await rejection(store.add([envelope]), RecordError);
		expect(error.code).toBe("unknownFile");
		expect(error.path).toBe(join(root, "changesets", changeset, "check"));
	});
});
