import { keyCoverage } from "@melian-agent/core/testing";
import { describe, expect, it } from "vitest";
import { type WalkthroughRequestInput, walkthroughRequest } from "../src/summarize.ts";

const sample: WalkthroughRequestInput = {
	revision: `${"a".repeat(40)}..${"b".repeat(40)}`,
	prompt: (nonce) => `<untrusted-${nonce} label="file">src/a.ts</untrusted-${nonce}>`,
	model: { provider: "faux", modelId: "scripted" },
	thinking: "low",
	paths: ["src/a.ts"],
	nonce: "n".repeat(24),
};

const vary = (_path: string, value: unknown) =>
	typeof value === "function" ? (nonce: string) => `<untrusted-${nonce}>src/b.ts</untrusted-${nonce}>` : undefined;

describe("walkthroughRequest", () => {
	it("keys every input but the nonce", () => {
		expect(keyCoverage(walkthroughRequest, sample, { vary, excluded: ["nonce"] })).toEqual([]);
	});

	it("keys a request without a thinking level apart from one with it", () => {
		const { thinking: _, ...unset } = sample;
		expect(walkthroughRequest(unset).key).not.toBe(walkthroughRequest(sample).key);
	});

	it("keys the record tool the summariser is given", () => {
		expect(walkthroughRequest(sample).request).toMatchObject({
			tool: {
				name: "record_walkthrough",
				description: "Record the change summary and finish.",
				parameters: expect.objectContaining({ type: "object" }),
			},
		});
	});

	it("attaches a review with a fresh nonce to the same task, and shows it the prompt under that nonce", () => {
		const again = walkthroughRequest({ ...sample, nonce: "m".repeat(24) });
		expect(again.key).toBe(walkthroughRequest(sample).key);
		expect(again.unkeyed).toEqual({
			nonce: `<untrusted-${"m".repeat(24)} label="file">src/a.ts</untrusted-${"m".repeat(24)}>`,
		});
		expect(again.producer).toBe("walkthrough");
	});
});
