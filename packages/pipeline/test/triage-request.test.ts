import { triageQuestionSet } from "@melian-agent/core";
import { keyCoverage } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";
import { triageRequest } from "../src/triage-request.ts";

type Sample = {
	decider: { name: string; version?: string };
	questionSet: { name: string; version: string };
	questions: { id: string; text: string; options: string[] }[];
	diff: string;
	cut: boolean;
	nonce: string;
};

const sample: Sample = {
	decider: { name: "fallback", version: "v1" },
	questionSet: { ...triageQuestionSet },
	questions: [{ id: "correctness", text: "How closely should correctness look?", options: ["quick", "careful"] }],
	diff: "+const total = price * count;",
	cut: false,
	nonce: "a".repeat(24),
};

function build(input: Sample) {
	return triageRequest({
		decider: input.decider,
		questionSet: input.questionSet,
		questions: input.questions,
		change: (nonce) => ({ text: `<untrusted-${nonce}>${input.diff}</untrusted-${nonce}>`, cut: input.cut }),
		nonce: input.nonce,
	});
}

describe("triageRequest", () => {
	it("keys every input but the nonce", () => {
		expect(keyCoverage(build, sample, { excluded: ["nonce"] })).toEqual([]);
	});

	it("keys a decider with no version apart from one with a version", () => {
		const unversioned = build({ ...sample, decider: { name: "fallback" } });
		expect(unversioned.request).not.toHaveProperty("deciderVersion");
		expect(unversioned.key).not.toBe(build(sample).key);
	});

	it("shows the decider the change under the review's nonce, and keys it under the fixed one", () => {
		const asked = build(sample);
		const fixed = "0".repeat(24);
		expect(asked.unkeyed.nonce).toEqual({
			questionSet: sample.questionSet,
			questions: sample.questions,
			state: expect.stringContaining(`<untrusted-${sample.nonce}>${sample.diff}</untrusted-${sample.nonce}>`),
		});
		expect(asked.unkeyed.nonce.state).not.toContain(fixed);
		expect(asked.request).toEqual({
			decider: "fallback",
			deciderVersion: "v1",
			questionSet: sample.questionSet,
			questions: sample.questions,
			state: asked.unkeyed.nonce.state.replaceAll(sample.nonce, fixed),
			inputCut: false,
		});
		expect(asked.producer).toBe("triage");
	});

	it("records that the change was cut", () => {
		expect(build({ ...sample, cut: true }).request.inputCut).toBe(true);
	});
});
