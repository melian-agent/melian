import { createHash } from "node:crypto";
import { canonicalJson, type RecordEnvelope, RecordError, SharedRecord } from "@melian-agent/core";
import { testPayloads } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";

const hex = (character: string) => character.repeat(64);
const commit = (character: string) => character.repeat(40);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const signature = Buffer.alloc(64, 7).toString("base64");

const parse = (value: unknown) => SharedRecord.parse(value, testPayloads);
const read = (bytes: string, id: string) => SharedRecord.read(bytes, id, testPayloads);

function envelope(fields: Partial<RecordEnvelope> = {}): RecordEnvelope {
	return { v: 1, changeset: "pull-0123456789abcdef", kind: "check", key: "static.biome", payload: {}, ...fields };
}

function refusal(value: unknown): RecordError {
	try {
		parse(value);
	} catch (error) {
		expect(error).toBeInstanceOf(RecordError);
		return error as RecordError;
	}
	throw new Error("expected the envelope to be refused");
}

describe("canonicalJson", () => {
	it("sorts keys by UTF-16 code units, as RFC 8785 does", () => {
		const astral = String.fromCharCode(0xd83d, 0xde00);
		const keys = ["\u20ac", "\r", "\ufb33", "1", astral, "\u0080", "\u00f6"];
		const value = Object.fromEntries(keys.map((key, index) => [key, index]));
		expect(canonicalJson(value)).toBe(`{"\\r":1,"1":3,"\u0080":5,"\u00f6":6,"\u20ac":0,"${astral}":4,"\ufb33":2}`);
	});

	it("writes strings, literals and nesting as JSON.stringify does, with no whitespace", () => {
		const value = { b: [null, true, false, 'a"\\\n\u000f\u2028'], a: { d: 0, c: -12 } };
		expect(canonicalJson(value)).toBe(
			`{"a":{"c":-12,"d":0},"b":[null,true,false,${JSON.stringify('a"\\\n\u000f\u2028')}]}`,
		);
	});

	it("writes negative zero as 0", () => {
		expect(canonicalJson(-0)).toBe("0");
	});

	it.each([
		["a fraction", 1.5],
		["an unsafe integer", 2 ** 53],
		["the largest safe integer plus one, negated", -(2 ** 53)],
		["NaN", Number.NaN],
		["infinity", Number.POSITIVE_INFINITY],
		["undefined", undefined],
		["a bigint", 1n],
		["a function", () => 1],
		["a date", new Date(0)],
		["a map", new Map()],
		["a lone high surrogate", String.fromCharCode(0xd800)],
		["a lone low surrogate", `a${String.fromCharCode(0xdc00)}`],
		["an undefined field", { a: undefined }],
		["an undefined element", [undefined]],
		["a hole", new Array(2).fill(1, 1)],
		["a key with a lone surrogate", { [String.fromCharCode(0xd800)]: 1 }],
	])("refuses %s", (_name, value) => {
		expect(() => canonicalJson(value)).toThrow(RecordError);
	});

	it("takes the largest safe integers", () => {
		expect(canonicalJson([2 ** 53 - 1, -(2 ** 53 - 1)])).toBe("[9007199254740991,-9007199254740991]");
	});

	it("takes a well-formed surrogate pair", () => {
		const pair = String.fromCharCode(0xd800, 0xdc00);
		expect(canonicalJson(pair)).toBe(JSON.stringify(pair));
	});

	it("refuses an object with a prototype other than Object's or none", () => {
		expect(canonicalJson(Object.create(null))).toBe("{}");
		class Point {
			x = 1;
		}
		expect(() => canonicalJson(new Point())).toThrow(RecordError);
	});
});

describe("SharedRecord", () => {
	it("is named by the SHA-256 of its canonical bytes", () => {
		const fields = envelope({ payload: { b: 1, a: [2, 3] } });
		const record = parse(fields);
		expect(record.bytes).toBe(
			'{"changeset":"pull-0123456789abcdef","key":"static.biome","kind":"check","payload":{"a":[2,3],"b":1},"v":1}',
		);
		expect(record.id).toBe(sha256(record.bytes));
		expect(record.toJSON()).toEqual(fields);
	});

	it("gives one ID whatever order the fields were written in", () => {
		const a = parse(envelope({ payload: { b: 1, a: 2 } }));
		const b = parse({
			payload: { a: 2, b: 1 },
			key: "static.biome",
			kind: "check",
			changeset: "pull-0123456789abcdef",
			v: 1,
		});
		expect(b.id).toBe(a.id);
	});

	it("changes its ID when any field changes", () => {
		const base = envelope({
			kind: "post",
			key: "finding",
			supersedes: [hex("a")],
			payload: { reason: "x" },
			signer: "host",
			signature,
		});
		const changed: { [K in keyof RecordEnvelope]-?: RecordEnvelope[K] } = {
			v: 1,
			changeset: "pull-fedcba9876543210",
			revision: `${commit("a")}..${commit("b")}`,
			kind: "status",
			key: "finding-2",
			supersedes: [hex("b")],
			payload: { reason: "y" },
			signer: "other",
			signature: Buffer.alloc(64, 8).toString("base64"),
		};
		const id = parse(base).id;
		const ids = new Set([id]);
		for (const field of Object.keys(changed) as (keyof RecordEnvelope)[]) {
			if (field === "v") continue;
			const variant = { ...base, [field]: changed[field] };
			ids.add(parse(variant).id);
		}
		expect(ids.size).toBe(Object.keys(changed).length);
	});

	it("hashes its key for the path its adapter files it under", () => {
		const record = parse(envelope({ key: "src/a b/\u00fc.ts:12 ../../etc" }));
		expect(record.keyHash).toBe(sha256("src/a b/\u00fc.ts:12 ../../etc"));
		expect(record.path).toBe(`changesets/pull-0123456789abcdef/check/${record.keyHash}/${record.id}.json`);
	});

	it("signs the canonical bytes of the whole envelope without its signature", () => {
		const record = parse(envelope({ signer: "host", signature }));
		expect(record.signedBytes()).toBe(canonicalJson({ ...envelope(), signer: "host" }));
	});

	it("is frozen whole, so no caller can change what its ID names", () => {
		const revision = `${commit("a")}..${commit("b")}`;
		const round = parse(
			envelope({
				kind: "round",
				revision,
				payload: { read: [], walkthrough: { key: "w", id: hex("9") }, replaces: [], before: [] },
			}),
		);
		expect(() => (round.replaces() as string[]).push(hex("1"))).toThrow(TypeError);
		expect(() => {
			(round.payload as { walkthrough: { key: string } }).walkthrough.key = "x";
		}).toThrow(TypeError);
		const post = parse(envelope({ kind: "post", supersedes: [hex("1")] }));
		expect(() => (post.supersedes as string[]).push(hex("2"))).toThrow(TypeError);
		expect(round.replaces()).toEqual([]);
		expect(round.manifest()?.walkthrough).toEqual({ key: "w", id: hex("9") });
	});

	it("gives an unfrozen copy from toJSON", () => {
		const record = parse(envelope({ payload: { n: 1 } }));
		const copy = record.toJSON();
		(copy.payload as { n: number }).n = 2;
		expect(record.payload).toEqual({ n: 1 });
	});

	describe("reading stored bytes", () => {
		it("takes canonical bytes whose hash is the ID they are filed under", () => {
			const record = parse(envelope());
			expect(read(record.bytes, record.id).toJSON()).toEqual(record.toJSON());
		});

		it("refuses bytes that do not give their own ID", () => {
			const record = parse(envelope());
			const error = (() => {
				try {
					read(record.bytes, hex("0"));
				} catch (error) {
					return error as RecordError;
				}
			})();
			expect(error).toBeInstanceOf(RecordError);
			expect(error?.code).toBe("idMismatch");
		});

		it("refuses bytes that parse to the record but are not its canonical form", () => {
			const record = parse(envelope());
			const spaced = JSON.stringify(JSON.parse(record.bytes), null, 1);
			for (const bytes of [spaced, `${record.bytes}\n`]) {
				const error = (() => {
					try {
						read(bytes, sha256(bytes));
					} catch (error) {
						return error as RecordError;
					}
				})();
				expect(error?.code).toBe("notCanonical");
			}
		});

		it("refuses bytes that are not JSON", () => {
			expect(() => read("{", sha256("{"))).toThrow(RecordError);
		});

		it("refuses a duplicated field, which JSON.parse would fold into one", () => {
			const record = parse(envelope());
			const doubled = record.bytes.replace('"v":1', '"v":1,"v":1');
			expect(() => read(doubled, sha256(doubled))).toThrow(RecordError);
		});
	});

	describe("validation", () => {
		it("takes every optional field together", () => {
			const fields = envelope({
				kind: "post",
				revision: `${commit("a")}..${commit("b")}`,
				supersedes: [hex("1"), hex("2")],
				signer: "host",
				signature,
			});
			expect(parse(fields).toJSON()).toEqual(fields);
		});

		it.each([
			["a value that is not an object", "x"],
			["an array", []],
			["null", null],
			["a field the envelope does not hold", { ...envelope(), extra: 1 }],
			["a version other than 1", { ...envelope(), v: 2 }],
			["a missing version", (({ v: _, ...rest }) => rest)(envelope())],
			["a missing payload", (({ payload: _, ...rest }) => rest)(envelope())],
			["an undefined optional field", { ...envelope(), revision: undefined }],
			["an empty key", envelope({ key: "" })],
			["a key that is not a string", { ...envelope(), key: 1 }],
			["a payload with a fraction", envelope({ payload: { amount: 0.5 } })],
		])("refuses %s", (_name, value) => {
			expect(refusal(value).code).toBe("invalidRecord");
		});

		it.each(["a", "a.b", "pull-0123", "a-b.c-d.0"])("takes the changeset %j", (changeset) => {
			expect(parse(envelope({ changeset })).changeset).toBe(changeset);
		});

		it.each(["", "A", "a..b", ".a", "a.", "a_b", "a/b", "a b", 1])("refuses the changeset %j", (changeset) => {
			expect(refusal({ ...envelope(), changeset }).code).toBe("invalidRecord");
		});

		it.each(["", "Check", "che..ck", "check.", "..", 1])("refuses the malformed kind %j", (kind) => {
			expect(refusal({ ...envelope(), kind }).code).toBe("invalidRecord");
		});

		it.each(["checks", "check.static", "che.ck", "constructor", "hasownproperty"])(
			"refuses the unknown kind %j",
			(kind) => {
				expect(refusal(envelope({ kind })).code).toBe("unknownKind");
			},
		);

		it.each([`${commit("a")}..${commit("b")}`, `${"a".repeat(64)}..${"b".repeat(64)}`])(
			"takes the revision %s",
			(revision) => {
				expect(parse(envelope({ revision })).revision).toBe(revision);
			},
		);

		it.each([
			["upper case", `${commit("A")}..${commit("b")}`],
			["a short side", `${"a".repeat(39)}..${commit("b")}`],
			["a long side", `${"a".repeat(41)}..${commit("b")}`],
			["sides of different lengths", `${commit("a")}..${"b".repeat(64)}`],
			["three dots", `${commit("a")}...${commit("b")}`],
			["one side", commit("a")],
			["a non-hex digit", `${commit("g")}..${commit("b")}`],
			["trailing text", `${commit("a")}..${commit("b")}\n`],
		])("refuses a revision with %s", (_name, revision) => {
			expect(refusal(envelope({ revision })).code).toBe("invalidRecord");
		});

		it.each([
			["an empty list", []],
			["an unsorted list", [hex("2"), hex("1")]],
			["a repeated ID", [hex("1"), hex("1")]],
			["a short ID", ["a".repeat(63)]],
			["an upper-case ID", [hex("A")]],
			["a list that is not one", hex("1")],
		])("refuses supersedes with %s", (_name, supersedes) => {
			expect(refusal({ ...envelope({ kind: "post" }), supersedes }).code).toBe("invalidRecord");
		});

		it.each(["dismissal", "post", "status", "ledger-comment", "comparison"])("lets a %s supersede", (kind) => {
			expect(parse(envelope({ kind, supersedes: [hex("1")] })).supersedes).toEqual([hex("1")]);
		});

		it.each(["check", "lens", "verification", "walkthrough", "telemetry", "marker"])(
			"refuses supersedes on a %s",
			(kind) => {
				expect(refusal(envelope({ kind, supersedes: [hex("1")] })).code).toBe("supersedesNotAllowed");
			},
		);

		it("refuses supersedes on a round", () => {
			const round = envelope({
				kind: "round",
				revision: `${commit("a")}..${commit("b")}`,
				payload: { read: [], walkthrough: null, replaces: [], before: [] },
			});
			expect(refusal({ ...round, supersedes: [hex("1")] }).code).toBe("supersedesNotAllowed");
		});

		it("refuses a signer without a signature, and a signature without a signer", () => {
			expect(refusal(envelope({ signer: "host" })).code).toBe("invalidRecord");
			expect(refusal(envelope({ signature })).code).toBe("invalidRecord");
		});

		it.each([
			["63 bytes", Buffer.alloc(63, 1).toString("base64")],
			["65 bytes", Buffer.alloc(65, 1).toString("base64")],
			["no padding", Buffer.alloc(64, 1).toString("base64").replace(/=+$/, "")],
			["base64url", Buffer.alloc(64, 0xff).toString("base64url")],
			["padding bits set", `${Buffer.alloc(64, 0).toString("base64").slice(0, 85)}B==`],
			["a line break", `${signature.slice(0, 40)}\n${signature.slice(40)}`],
		])("refuses a signature of %s", (_name, value) => {
			expect(refusal(envelope({ signer: "host", signature: value })).code).toBe("invalidRecord");
		});

		it("refuses an empty signer", () => {
			expect(refusal(envelope({ signer: "", signature })).code).toBe("invalidRecord");
		});

		it("refuses a dismissal that carries a revision", () => {
			expect(refusal(envelope({ kind: "dismissal", revision: `${commit("a")}..${commit("b")}` })).code).toBe(
				"invalidRecord",
			);
		});

		describe("a round", () => {
			const revision = `${commit("a")}..${commit("b")}`;

			it("names the rounds it replaces", () => {
				const round = parse(
					envelope({
						kind: "round",
						revision,
						payload: { read: [], walkthrough: null, replaces: [hex("1")], before: [] },
					}),
				);
				expect(round.replaces()).toEqual([hex("1")]);
			});

			it.each([
				[
					"no revision",
					envelope({ kind: "round", payload: { read: [], walkthrough: null, replaces: [], before: [] } }),
				],
				["no manifest", envelope({ kind: "round", revision, payload: { replaces: [] } })],
				["a payload that is not an object", envelope({ kind: "round", revision, payload: [] })],
				[
					"an unsorted list",
					envelope({
						kind: "round",
						revision,
						payload: { read: [], walkthrough: null, replaces: [hex("2"), hex("1")], before: [] },
					}),
				],
				[
					"a repeated round",
					envelope({
						kind: "round",
						revision,
						payload: { read: [], walkthrough: null, replaces: [hex("1"), hex("1")], before: [] },
					}),
				],
				[
					"an ID that is not one",
					envelope({
						kind: "round",
						revision,
						payload: { read: [], walkthrough: null, replaces: ["r1"], before: [] },
					}),
				],
			])("is refused with %s", (_name, value) => {
				expect(refusal(value).code).toBe("invalidRecord");
			});

			it("is the only kind that replaces", () => {
				expect(parse(envelope({ payload: { replaces: [hex("1")] } })).replaces()).toEqual([]);
			});
		});
	});

	describe("saying why", () => {
		const revision = `${commit("a")}..${commit("b")}`;

		it.each([
			["a record is a JSON object", "x"],
			["a record holds no field extra", { ...envelope(), extra: 1 }],
			["a record's v is 1", { ...envelope(), v: 2 }],
			["a record's changeset is dot-joined segments of [a-z0-9-]", envelope({ changeset: "A" })],
			["a record's kind is dot-joined segments of [a-z0-9-]", envelope({ kind: "Check" })],
			["no record has the kind checks", envelope({ kind: "checks" })],
			["a record's key is a non-empty string", envelope({ key: "" })],
			["a record has a payload", (({ payload: _, ...rest }) => rest)(envelope())],
			["a record's revision is two full lower-case object IDs joined by ..", envelope({ revision: "x" })],
			["a dismissal carries no revision", envelope({ kind: "dismissal", revision })],
			["supersedes is a list of record IDs", { ...envelope({ kind: "post" }), supersedes: hex("1") }],
			["supersedes holds 64-hex record IDs", envelope({ kind: "post", supersedes: ["x"] })],
			["supersedes is sorted, with no ID twice", envelope({ kind: "post", supersedes: [hex("2"), hex("1")] })],
			["supersedes, when present, names at least one record", envelope({ kind: "post", supersedes: [] })],
			["a check record may not supersede another", envelope({ supersedes: [hex("1")] })],
			["a record's signer and signature appear together or not at all", envelope({ signer: "host" })],
			["a record's signer is a non-empty string", envelope({ signer: "", signature })],
			["a record's signature is 64 bytes in canonical base64", envelope({ signer: "host", signature: "x" })],
			[
				"a round names its revision",
				envelope({ kind: "round", payload: { read: [], walkthrough: null, replaces: [], before: [] } }),
			],
			["a round's payload is an object", envelope({ kind: "round", revision, payload: [] })],
			[
				"a round's payload holds read, walkthrough, replaces, before and nothing else",
				envelope({ kind: "round", revision, payload: {} }),
			],
			["a record's numbers are safe integers, not 1.5", envelope({ payload: 1.5 })],
			["a record's strings hold no lone surrogate", envelope({ payload: String.fromCharCode(0xd800) })],
			["a record's keys hold no lone surrogate", envelope({ payload: { [String.fromCharCode(0xd800)]: 1 } })],
			["a record holds JSON only, not a class instance", envelope({ payload: new Date(0) as never })],
			["a record holds JSON only, not undefined", envelope({ payload: [undefined] as never })],
			["a record holds JSON only, not bigint", envelope({ payload: 1n as never })],
		])("refuses with %j", (message, value) => {
			expect(refusal(value).message).toBe(message);
		});

		it("says why it refuses stored bytes", () => {
			const record = parse(envelope());
			const read = (bytes: string, id: string) => {
				try {
					SharedRecord.read(bytes, id, testPayloads);
				} catch (error) {
					return error as RecordError;
				}
				throw new Error("expected the bytes to be refused");
			};
			const notJson = read("{", sha256("{"));
			expect(notJson.message).toBe("a stored record is not JSON");
			expect(notJson.cause).toBeInstanceOf(SyntaxError);
			expect(read(`${record.bytes} `, sha256(`${record.bytes} `)).message).toBe(
				"a stored record's bytes are not its canonical form",
			);
			expect(read(record.bytes, hex("0")).message).toBe(`a record filed as ${hex("0")} has the ID ${record.id}`);
		});

		it.each([
			["an ID one digit too long", ["a".repeat(65)]],
			["an ID after other text", [`x${hex("a")}`]],
			["an array that coerces to an ID", [[hex("a")]]],
		])("refuses supersedes holding %s", (_name, supersedes) => {
			expect(refusal({ ...envelope({ kind: "post" }), supersedes }).code).toBe("invalidRecord");
		});

		it.each([
			["a revision that is no string but coerces to one", { revision: [`${commit("a")}..${commit("b")}`] }],
			["a signer that is no string", { signer: 1, signature }],
			["a signature that is no string", { signer: "host", signature: 1 }],
			["a round whose payload is null", { kind: "round", revision, payload: null }],
		])("refuses %s as a RecordError", (_name, fields) => {
			expect(refusal({ ...envelope(), ...fields }).code).toBe("invalidRecord");
		});

		it("takes a payload that holds null", () => {
			expect(parse(envelope({ payload: { a: null, b: [null] } })).payload).toEqual({
				a: null,
				b: [null],
			});
		});

		it("names its errors as RecordError, and a stored record that is not JSON as invalidRecord", () => {
			expect(refusal("x").name).toBe("RecordError");
			try {
				read("{", sha256("{"));
			} catch (error) {
				expect((error as RecordError).code).toBe("invalidRecord");
			}
		});

		it("gives a record that names no supersedes an empty list", () => {
			expect(parse(envelope()).supersedes).toEqual([]);
		});
	});
});
