import { describe, expect, it } from "vitest";
import { lensCopies, type ReusableOutcome } from "../src/lens-reuse.ts";

type Run = { readonly key: string; readonly request?: string; readonly escalation?: { readonly next?: Run } };
type Outcome = ReusableOutcome & { readonly model?: string };

// The review decides which runs may stand; here, every done one.
const never = (_run: Run, outcome: Outcome | undefined) => outcome?.status === "done";

const done = (extra: Partial<Outcome> = {}): Outcome => ({ status: "done", model: "anthropic/claude-a", ...extra });

const careful: Run = { key: "a@1@careful", request: "r-careful" };
const quick: Run = { key: "a@1@quick", request: "r-quick", escalation: { next: careful } };
const other: Run = { key: "b@1@careful", request: "r-other" };

describe("lensCopies", () => {
	it("copies a lens whose request matches a finished run, naming the task that asked it", () => {
		const outcome = done();
		const copies = lensCopies(
			{ task: 7, nonce: "n7", lenses: [careful, other], result: { [careful.key]: outcome, [other.key]: done() } },
			[careful, { ...other, request: "r-other-changed" }],
			never,
		);
		expect(copies).toEqual({
			[careful.key]: { task: 7, nonce: "n7", outcomes: { [careful.key]: { ...outcome, reused: 7 } } },
		});
	});

	it("keeps the task a copied outcome first came from", () => {
		const copies = lensCopies(
			{ task: 9, nonce: "n9", lenses: [careful], result: { [careful.key]: done({ reused: 4 }) } },
			[careful],
			never,
		);
		expect(copies[careful.key]?.outcomes[careful.key]?.reused).toBe(4);
	});

	it("keeps the nonce of the task a copied lens first came from, which its conversation was rendered under", () => {
		const renamed = { ...careful, key: "a@2@careful" };
		const copies = lensCopies(
			{
				task: 9,
				nonce: "n9",
				lenses: [careful, other],
				result: { [careful.key]: done({ reused: 4 }), [other.key]: done() },
				reused: { [careful.key]: { nonce: "n4" } },
			},
			[renamed, other],
			never,
		);
		expect([copies[renamed.key]?.nonce, copies[other.key]?.nonce]).toEqual(["n4", "n9"]);
	});

	it("matches by the request's key, not the lens's", () => {
		const renamed = { ...careful, key: "a@2@careful" };
		const copies = lensCopies(
			{ task: 3, nonce: "n3", lenses: [careful], result: { [careful.key]: done() } },
			[renamed],
			never,
		);
		expect(Object.keys(copies)).toEqual([renamed.key]);
		expect(Object.keys(copies[renamed.key]!.outcomes)).toEqual([careful.key]);
	});

	it("copies only a run the review says may stand, and only with the run it escalated to standing too", () => {
		const result = { [quick.key]: done({ escalation: { to: careful.key } }), [careful.key]: done() };
		const asked: string[] = [];
		const stands = (run: Run) => {
			asked.push(run.key);
			return run.key !== careful.key;
		};
		expect(lensCopies({ task: 3, nonce: "n3", lenses: [quick], result }, [quick], stands)).toEqual({});
		expect(asked).toEqual([quick.key, careful.key]);
		expect(lensCopies({ task: 3, nonce: "n3", lenses: [careful], result }, [careful], () => false)).toEqual({});
	});

	it("copies nothing for a run with no request key, as an older task's runs have", () => {
		const { request: _, ...unkeyed } = careful;
		expect(
			lensCopies({ task: 3, nonce: "n3", lenses: [unkeyed], result: { [careful.key]: done() } }, [unkeyed], never),
		).toEqual({});
	});

	it("copies a quick run that did not escalate on its own", () => {
		const copies = lensCopies(
			{ task: 3, nonce: "n3", lenses: [quick], result: { [quick.key]: done() } },
			[quick],
			never,
		);
		expect(Object.keys(copies[quick.key]!.outcomes)).toEqual([quick.key]);
	});

	it("copies a quick run with the run it escalated to", () => {
		const result = { [quick.key]: done({ escalation: { to: careful.key } }), [careful.key]: done() };
		const copies = lensCopies({ task: 3, nonce: "n3", lenses: [quick], result }, [quick], never);
		expect(copies[quick.key]).toEqual({
			task: 3,
			nonce: "n3",
			outcomes: {
				[quick.key]: { ...result[quick.key], reused: 3 },
				[careful.key]: { ...result[careful.key], reused: 3 },
			},
		});
	});

	it.each([
		["did not finish", { [careful.key]: done({ status: "failed" }) }],
		["is missing", {}],
	])("never copies a quick run whose escalated run %s", (_, rest) => {
		const result = { [quick.key]: done({ escalation: { to: careful.key } }), ...rest };
		expect(lensCopies({ task: 3, nonce: "n3", lenses: [quick], result }, [quick], never)).toEqual({});
	});

	it("never copies a quick run that escalated to a run other than the one it names", () => {
		const result = { [quick.key]: done({ escalation: { to: "a@1@thorough" } }), "a@1@thorough": done() };
		expect(lensCopies({ task: 3, nonce: "n3", lenses: [quick], result }, [quick], never)).toEqual({});
		const { escalation: _, ...alone } = quick;
		expect(lensCopies({ task: 3, nonce: "n3", lenses: [alone], result }, [alone], never)).toEqual({});
	});
});
