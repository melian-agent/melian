import { describe, expect, it } from "vitest";
import { lensCopies, type ReusableOutcome, type ReusableRun } from "../src/lens-reuse.ts";

const never = () => false;

const done = (extra: Partial<ReusableOutcome> = {}): ReusableOutcome => ({
	status: "done",
	model: "anthropic/claude-a",
	...extra,
});

const careful: ReusableRun = { key: "a@1@careful", request: "r-careful" };
const quick: ReusableRun = { key: "a@1@quick", request: "r-quick", escalation: { next: careful } };
const other: ReusableRun = { key: "b@1@careful", request: "r-other" };

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
		expect(copies[renamed.key]).toMatchObject({ nonce: "n4" });
		expect(copies[other.key]).toMatchObject({ nonce: "n9" });
	});

	it("keeps a copy of an imported lens an import, naming its record and no task or nonce", () => {
		const outcome = done({ imported: "record-1" });
		const copies = lensCopies(
			{
				task: 9,
				nonce: "n9",
				lenses: [careful],
				result: { [careful.key]: outcome },
				reused: { [careful.key]: { record: "record-1" } },
			},
			[careful],
			never,
		);
		expect(copies).toEqual({
			[careful.key]: { record: "record-1", outcomes: { [careful.key]: { ...outcome, reused: 9 } } },
		});
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

	it("copies nothing for a run with no request key, as an older task's runs have", () => {
		const { request: _, ...unkeyed } = careful;
		expect(
			lensCopies({ task: 3, nonce: "n3", lenses: [unkeyed], result: { [careful.key]: done() } }, [unkeyed], never),
		).toEqual({});
	});

	it.each([
		["a failed run", { status: "failed" }],
		["a run whose budget ended", { budgetEnded: "tokens" }],
		["a capped run", { capped: 8 }],
	])("never copies %s", (_, extra) => {
		const result = { [careful.key]: done(extra as Partial<ReusableOutcome>) };
		expect(lensCopies({ task: 3, nonce: "n3", lenses: [careful], result }, [careful], never)).toEqual({});
	});

	it("never copies a run that ended on a model the plan now refuses", () => {
		const result = { [careful.key]: done() };
		const refused = (key: string, model: string) => key === careful.key && model === "anthropic/claude-a";
		expect(lensCopies({ task: 3, nonce: "n3", lenses: [careful], result }, [careful], refused)).toEqual({});
		expect(
			lensCopies({ task: 3, nonce: "n3", lenses: [careful], result }, [careful], (key) => key !== careful.key),
		).not.toEqual({});
	});

	it("copies a run with no model recorded, since nothing names one to refuse", () => {
		const { model: _, ...unnamed } = done();
		expect(
			Object.keys(
				lensCopies(
					{ task: 3, nonce: "n3", lenses: [careful], result: { [careful.key]: unnamed } },
					[careful],
					() => true,
				),
			),
		).toEqual([careful.key]);
	});

	it("never copies a probing run", () => {
		const probing = { ...careful, probe: { route: [] } };
		expect(
			lensCopies({ task: 3, nonce: "n3", lenses: [probing], result: { [careful.key]: done() } }, [probing], never),
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

	it("never copies a quick run whose escalated run probes", () => {
		const probing = { ...quick, escalation: { next: { ...careful, probe: { route: [] } } } };
		const result = { [quick.key]: done({ escalation: { to: careful.key } }), [careful.key]: done() };
		expect(lensCopies({ task: 3, nonce: "n3", lenses: [probing], result }, [probing], never)).toEqual({});
	});

	it("never copies a quick run that escalated to a run other than the one it names", () => {
		const result = { [quick.key]: done({ escalation: { to: "a@1@thorough" } }), "a@1@thorough": done() };
		expect(lensCopies({ task: 3, nonce: "n3", lenses: [quick], result }, [quick], never)).toEqual({});
		const { escalation: _, ...alone } = quick;
		expect(lensCopies({ task: 3, nonce: "n3", lenses: [alone], result }, [alone], never)).toEqual({});
	});
});
