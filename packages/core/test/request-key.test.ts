import { createHash } from "node:crypto";
import { canonicalJson, KeyedRequest, RecordError, requestExclusions, requestJson } from "@melian-agent/core";
import { keyCoverage } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type Input = { base: string; head: string; budget: number; quick: boolean; files: string[]; nonce: string };

const sample: Input = {
	base: "a".repeat(40),
	head: "b".repeat(40),
	budget: 8,
	quick: true,
	files: ["x.ts"],
	nonce: "n1",
};

const build = (input: Input) =>
	KeyedRequest.of(
		"lens",
		{ base: input.base, head: input.head, budget: input.budget, quick: input.quick, files: input.files },
		{ nonce: input.nonce },
	);

describe("KeyedRequest", () => {
	it("keys the canonical bytes of the producer and the request", () => {
		const keyed = KeyedRequest.of("check", { b: 1, a: [true, null] });
		expect(keyed.key).toBe(sha256(canonicalJson({ producer: "check", request: { a: [true, null], b: 1 } })));
		expect(keyed.key).toBe(sha256('{"producer":"check","request":{"a":[true,null],"b":1}}'));
	});

	it("gives two producers asked the same thing two keys", () => {
		expect(KeyedRequest.of("lens", { a: 1 }).key).not.toBe(KeyedRequest.of("verification", { a: 1 }).key);
	});

	it("matches a request asked again, whatever the unkeyed input, and nothing else", () => {
		const first = KeyedRequest.of("lens", { a: 1 }, { nonce: "one" });
		expect(first.matches(KeyedRequest.of("lens", { a: 1 }, { nonce: "two" }))).toBe(true);
		expect(first.matches(KeyedRequest.of("lens", { a: 2 }, { nonce: "one" }))).toBe(false);
	});

	it("hands the producer the request and the unkeyed input it keyed", () => {
		const request = { files: ["x.ts"] };
		const keyed = KeyedRequest.of("lens", request, { nonce: "n", language: "en-AU" });
		expect(keyed.producer).toBe("lens");
		expect(keyed.request).toEqual({ files: ["x.ts"] });
		expect(keyed.unkeyed).toEqual({ nonce: "n", language: "en-AU" });
		request.files.push("y.ts");
		expect(keyed.request).toEqual({ files: ["x.ts"] });
		expect(KeyedRequest.of("lens", { a: 1 }).unkeyed).toEqual({});
	});

	it("leaves out only the fields the exclusion table names", () => {
		expect(Object.keys(requestExclusions)).toEqual(["nonce", "language", "bestEffort", "chosenBy"]);
		for (const name of Object.keys(requestExclusions)) {
			expect(() => KeyedRequest.of("lens", {}, { [name]: 1 })).not.toThrow();
		}
		const refusal = (() => {
			try {
				KeyedRequest.of("lens", {}, { model: "x" } as never);
			} catch (error) {
				return error as RecordError;
			}
		})();
		expect(refusal).toBeInstanceOf(RecordError);
		expect(refusal?.code).toBe("invalidRecord");
		expect(refusal?.message).toBe(
			"a request's key may leave out only nonce, language, bestEffort, chosenBy, not model",
		);
	});

	it("refuses a producer name that is not lower-case dotted words", () => {
		for (const name of ["", "Lens", "lens.", ".lens", "lens run", "1lens"]) {
			expect(() => KeyedRequest.of(name, {}), name).toThrow(RecordError);
			expect(() => KeyedRequest.of(name, {}), name).toThrow(
				expect.objectContaining({ code: "invalidRecord", message: "a producer's name is lower-case dotted words" }),
			);
		}
		for (const name of ["lens", "static.biome", "check-run.v2"]) {
			expect(() => KeyedRequest.of(name, {}), name).not.toThrow();
		}
	});

	it("refuses a request canonical JSON cannot write one way", () => {
		expect(() => KeyedRequest.of("lens", { threshold: 0.5 })).toThrow(RecordError);
		expect(() => KeyedRequest.of("lens", { at: new Date(0) } as never)).toThrow(RecordError);
	});
});

describe("keyCoverage", () => {
	it("passes a builder whose key follows every input but the exclusions", () => {
		expect(keyCoverage(build, sample, { excluded: ["nonce"] })).toEqual([]);
	});

	it("names an input the key does not follow", () => {
		const dropsBudget = (input: Input) => build({ ...input, budget: 8 });
		expect(keyCoverage(dropsBudget, sample, { excluded: ["nonce"] })).toEqual([
			"budget reaches the builder, but changing it left the key alone",
		]);
	});

	it("names an exclusion the key follows, and one that names nothing", () => {
		expect(keyCoverage(build, sample, { excluded: ["head", "missing"] })).toEqual([
			"missing is excluded but names nothing in the sample",
			"head is excluded, but changing it changed the key",
			"nonce reaches the builder, but changing it left the key alone",
		]);
	});

	it("covers everything under an excluded path", () => {
		const nested = (input: { keyed: number; state: { nonce: string; seed: number } }) =>
			KeyedRequest.of("triage", { keyed: input.keyed }, { nonce: input.state });
		expect(keyCoverage(nested, { keyed: 1, state: { nonce: "n", seed: 2 } }, { excluded: ["state"] })).toEqual([]);
		expect(keyCoverage(nested, { keyed: 1, state: { nonce: "n", seed: 2 } }, { excluded: ["state.nonce"] })).toEqual([
			"state.seed reaches the builder, but changing it left the key alone",
		]);
		expect(keyCoverage(nested, { keyed: 1, state: { nonce: "n", seed: 2 } }, { excluded: ["stat"] })).toEqual([
			"stat is excluded but names nothing in the sample",
			"state.nonce reaches the builder, but changing it left the key alone",
			"state.seed reaches the builder, but changing it left the key alone",
		]);
	});

	it("changes every kind of leaf, an array's items included", () => {
		const seen: unknown[] = [];
		const spy = (input: { s: string; n: number; b: boolean; z: null; list: number[] }) => {
			seen.push(structuredClone(input));
			return KeyedRequest.of("check", input);
		};
		expect(keyCoverage(spy, { s: "a", n: 1, b: false, z: null, list: [7] })).toEqual([]);
		expect(seen.slice(2)).toEqual([
			{ s: "a~", n: 1, b: false, z: null, list: [7] },
			{ s: "a", n: 2, b: false, z: null, list: [7] },
			{ s: "a", n: 1, b: true, z: null, list: [7] },
			{ s: "a", n: 1, b: false, z: "~", list: [7] },
			{ s: "a", n: 1, b: false, z: null, list: [8] },
		]);
	});

	it("leaves the sample as it was", () => {
		const input = structuredClone(sample);
		keyCoverage(build, input, { excluded: ["nonce"] });
		expect(input).toEqual(sample);
	});

	it("reports an empty list or object, and a class instance it cannot change", () => {
		const anything = (input: unknown) => KeyedRequest.of("check", { text: JSON.stringify(input) ?? "" });
		expect(keyCoverage(anything, { list: [], map: {}, at: new Date(0) })).toEqual([
			"list holds an empty list, which the helper cannot change; give vary a value",
			"map holds an empty object, which the helper cannot change; give vary a value",
			"at holds a Date instance, which the helper cannot change; give vary a value",
		]);
		expect(keyCoverage(anything, { list: [] }, { vary: () => ["x"] })).toEqual([]);
	});

	it("takes a valid change from vary, and reports one the builder refuses", () => {
		const commits = (input: { head: string }) => {
			if (!/^[0-9a-f]{40}$/.test(input.head)) throw new Error("not a commit");
			return KeyedRequest.of("check", input);
		};
		expect(keyCoverage(commits, { head: "a".repeat(40) })).toEqual([
			"head: the builder refused the changed value (not a commit); give vary one it takes",
		]);
		expect(keyCoverage(commits, { head: "a".repeat(40) }, { vary: () => "c".repeat(40) })).toEqual([]);
		expect(keyCoverage(commits, { head: "a".repeat(40) }, { vary: (_path, value) => value })).toEqual([
			"head was varied to the value it holds",
		]);
	});

	it("reports a field left undefined and a function, which it cannot change", () => {
		const anything = (input: unknown) => KeyedRequest.of("check", { text: String(Object.keys(input as object)) });
		expect(keyCoverage(anything, { gone: undefined, call: () => 1 })).toEqual([
			"gone holds undefined, which the helper cannot change; give vary a value",
			"call holds function, which the helper cannot change; give vary a value",
		]);
	});

	it("walks into an object with no prototype, and names an instance whose class has no name", () => {
		const anything = (input: { map: { k: number } }) => KeyedRequest.of("check", { k: input.map.k });
		const bare = Object.assign(Object.create(null) as { k: number }, { k: 1 });
		expect(keyCoverage(anything, { map: bare })).toEqual([]);
		const orphan = (input: unknown) => KeyedRequest.of("check", { text: typeof input });
		expect(keyCoverage(orphan, { at: Object.create(Object.create(null)) })).toEqual([
			"at holds a class instance, which the helper cannot change; give vary a value",
		]);
	});

	it("changes one item of a list and keeps the others", () => {
		const second = (input: { list: string[] }) =>
			KeyedRequest.of("check", { second: input.list[1] ?? "" }, { nonce: input.list[0] });
		expect(keyCoverage(second, { list: ["a", "b"] }, { excluded: ["list.0"] })).toEqual([]);
	});

	it("names the input itself when the sample is one value", () => {
		const one = (input: unknown) => {
			if (input !== "a" && input !== undefined) throw new Error("only a");
			return KeyedRequest.of("check", { input: String(input) });
		};
		expect(keyCoverage(one, undefined)).toEqual([
			"the input holds undefined, which the helper cannot change; give vary a value",
		]);
		expect(keyCoverage(one, "a")).toEqual([
			"the input: the builder refused the changed value (only a); give vary one it takes",
		]);
		expect(keyCoverage(one, "a", { vary: (_path, value) => value })).toEqual([
			"the input was varied to the value it holds",
		]);
	});

	it("names a key that differs between two builds of one input", () => {
		let count = 0;
		const drifting = (input: { a: number }) => KeyedRequest.of("check", { ...input, count: count++ });
		expect(keyCoverage(drifting, { a: 1 })[0]).toBe("the key differs between two builds of the same input");
	});
});

describe("requestJson", () => {
	it("drops a field left undefined, at any depth, and keeps null", () => {
		expect(requestJson({ a: undefined, b: { c: undefined, d: null }, e: [{ f: undefined }] })).toStrictEqual({
			b: { d: null },
			e: [{}],
		});
	});

	it("keeps a safe integer and writes any other finite number as its decimal text", () => {
		expect(requestJson({ whole: 7, fraction: 0.75, large: 2 ** 53, small: -(2 ** 53) + 1 })).toEqual({
			whole: 7,
			fraction: "0.75",
			large: "9007199254740992",
			small: -(2 ** 53) + 1,
		});
	});

	it("gives a fraction and its decimal text one key, which canonical JSON alone refuses", () => {
		expect(() => canonicalJson({ recall: 0.75 })).toThrow(RecordError);
		expect(KeyedRequest.of("check", requestJson({ recall: 0.75 })).key).toBe(
			KeyedRequest.of("check", { recall: "0.75" }).key,
		);
	});

	it("refuses a number no request can hold", () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
			expect(() => requestJson({ nested: [value] })).toThrow(/finite numbers/);
	});

	it("leaves strings, booleans and null as they are", () => {
		expect(requestJson(["x", true, false, null])).toEqual(["x", true, false, null]);
	});
});
