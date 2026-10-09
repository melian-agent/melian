import { describe, expect, it } from "vitest";
import { render as originalRender } from "../goldens/design-bound-on-wrong-measure/base/src/bound-on-wrong-measure.ts";
import { render as badRender } from "../goldens/design-bound-on-wrong-measure/head/src/bound-on-wrong-measure.ts";
import { render as TwinBaseRender } from "../goldens/design-bound-on-wrong-measure-clean/base/src/bound-on-wrong-measure.ts";
import { render as cleanRender } from "../goldens/design-bound-on-wrong-measure-clean/head/src/bound-on-wrong-measure.ts";
import { resume as originalResume } from "../goldens/design-resumed-identity/base/src/resumed-identity.ts";
import { resume as badResume } from "../goldens/design-resumed-identity/head/src/resumed-identity.ts";
import { resume as TwinBaseResume } from "../goldens/design-resumed-identity-clean/base/src/resumed-identity.ts";
import { resume as cleanResume } from "../goldens/design-resumed-identity-clean/head/src/resumed-identity.ts";
import { CoverageStore as OriginalStore } from "../goldens/design-single-slot-overwrite/base/src/single-slot-overwrite.ts";
import { CoverageStore as BadStore } from "../goldens/design-single-slot-overwrite/head/src/single-slot-overwrite.ts";
import { CoverageStore as TwinBaseStore } from "../goldens/design-single-slot-overwrite-clean/base/src/single-slot-overwrite.ts";
import { CoverageStore as CleanStore } from "../goldens/design-single-slot-overwrite-clean/head/src/single-slot-overwrite.ts";
import { instructions as originalInstructions } from "../goldens/design-trust-by-label/base/src/trust-by-label.ts";
import { instructions as badInstructions } from "../goldens/design-trust-by-label/head/src/trust-by-label.ts";
import { instructions as TwinBaseInstructions } from "../goldens/design-trust-by-label-clean/base/src/trust-by-label.ts";
import { instructions as cleanInstructions } from "../goldens/design-trust-by-label-clean/head/src/trust-by-label.ts";

describe("design rule fixtures", () => {
	it.each([originalInstructions, TwinBaseInstructions, cleanInstructions])(
		"trusts matching provenance and quotes mismatched provenance",
		(instructions) => {
			expect(instructions({ kind: "revision", commit: "A", text: "standard" }, "A")).toBe("standard");
			expect(instructions({ kind: "revision", commit: "B", text: "standard" }, "A")).toBe("[untrusted] standard");
		},
	);
	it("demonstrates that a revision label admits mismatched standards", () => {
		expect(badInstructions({ kind: "revision", commit: "B", text: "standard" }, "A")).toBe("standard");
		expect(badInstructions({ kind: "flat", commit: "B", text: "standard" }, "A")).toBe("[untrusted] standard");
	});
	it.each([originalRender, TwinBaseRender, cleanRender])(
		"bounds the rendered body at 1024 bytes and one past",
		(render) => {
			expect(Buffer.byteLength(render([{ path: "x", text: "x".repeat(1017) }]))).toBe(1024);
			expect(() => render([{ path: "x", text: "x".repeat(1018) }])).toThrow("too large");
			expect(() => render(Array.from({ length: 100 }, () => ({ path: "x".repeat(20), text: "" })))).toThrow(
				"too large",
			);
		},
	);
	it("demonstrates that the content bound ignores headings and paths", () => {
		expect(Buffer.byteLength(badRender([{ path: "x", text: "x".repeat(1024) }]))).toBe(1031);
		expect(() => badRender([{ path: "x", text: "x".repeat(1025) }])).toThrow("too large");
		expect(
			Buffer.byteLength(badRender(Array.from({ length: 100 }, () => ({ path: "x".repeat(20), text: "" })))),
		).toBe(2600);
	});
	it.each([originalResume, TwinBaseResume, cleanResume])("supersedes each changed identity input", (resume) => {
		const stored = { head: "H", identity: { login: "alice", permission: "write" } };
		expect(resume(stored, "H", stored.identity)).toEqual(stored);
		for (const current of [
			{ login: "bob", permission: "write" },
			{ login: "alice", permission: "read" },
		]) {
			expect(resume(stored, "H", current)).toEqual({ head: "H", identity: current });
		}
		expect(resume(stored, "J", stored.identity)).toEqual({ head: "J", identity: stored.identity });
	});
	it("demonstrates stale identity with an unchanged head", () => {
		const stored = { head: "H", identity: { login: "alice", permission: "write" } };
		const current = { login: "bob", permission: "read" };
		expect(badResume(stored, "H", current)).toEqual(stored);
		expect(badResume(stored, "J", current)).toEqual({ head: "J", identity: current });
	});
	it.each([OriginalStore, TwinBaseStore, CleanStore])(
		"keeps the first coverage after another revision writes",
		(Store) => {
			const store = new Store();
			const first = store.write("G", "A", "first");
			const second = store.write("G", "B", "second");
			expect(store.read(first)).toBe("first");
			expect(store.read(second)).toBe("second");
		},
	);
	it("demonstrates overwrite through the earlier durable key", () => {
		const store = new BadStore();
		const first = store.write("G", "A", "first");
		store.write("G", "B", "second");
		expect(store.read(first)).toBe("second");
	});
});
