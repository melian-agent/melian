import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { render as originalRender } from "../goldens/design-bound-on-wrong-measure/base/src/bound-on-wrong-measure.ts";
import { render as badRender } from "../goldens/design-bound-on-wrong-measure/head/src/bound-on-wrong-measure.ts";
import { render as TwinBaseRender } from "../goldens/design-bound-on-wrong-measure-clean/base/src/bound-on-wrong-measure.ts";
import { render as cleanRender } from "../goldens/design-bound-on-wrong-measure-clean/head/src/bound-on-wrong-measure.ts";
import { stamp as originalStamp } from "../goldens/design-contradicts-documented-decision/base/src/timestamps.ts";
import { stamp as badStamp } from "../goldens/design-contradicts-documented-decision/head/src/timestamps.ts";
import { stamp as twinBaseStamp } from "../goldens/design-contradicts-documented-decision-clean/base/src/timestamps.ts";
import {
	stamp as cleanStamp,
	stamps,
} from "../goldens/design-contradicts-documented-decision-clean/head/src/timestamps.ts";
import { renderNotes as originalNotes } from "../goldens/design-contradicts-documented-decision-noise/base/src/comment.ts";
import { renderNotes as badNotes } from "../goldens/design-contradicts-documented-decision-noise/head/src/comment.ts";
import { renderNotes as twinBaseNotes } from "../goldens/design-contradicts-documented-decision-noise-clean/base/src/comment.ts";
import { renderNotes as cleanNotes } from "../goldens/design-contradicts-documented-decision-noise-clean/head/src/comment.ts";
import { readHeader } from "../goldens/design-reimplements-an-authority/head/src/note.ts";
import { seconds } from "../goldens/design-reimplements-an-authority-no-dependency-clean/head/src/remind.ts";
import { readHeader as excusedReadHeader } from "../goldens/design-reimplements-an-authority-unsupported-gap/head/src/note.ts";
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

const major = Number(process.versions.node.split(".")[0]);

describe("design rule fixtures", () => {
	const events = [new Date("2026-10-30T21:00:00Z"), new Date("2026-10-31T22:00:00Z")];
	it.each([originalStamp, twinBaseStamp, cleanStamp])("stamps UTC ISO 8601 that sorts as text", (stamp) => {
		expect(events.map(stamp)).toEqual(["2026-10-30T21:00:00.000Z", "2026-10-31T22:00:00.000Z"]);
	});
	it("stamps a list through the UTC stamp", () => {
		expect(stamps(events)).toEqual(["2026-10-30T21:00:00.000Z", "2026-10-31T22:00:00.000Z"]);
	});
	it("demonstrates that Sydney local time sorts the earlier event second", () => {
		const stamped = events.map(badStamp);
		expect(stamped).toEqual(["31/10/2026, 8:00:00 am", "01/11/2026, 9:00:00 am"]);
		expect([...stamped].sort()).toEqual(["01/11/2026, 9:00:00 am", "31/10/2026, 8:00:00 am"]);
	});
	const runs = Array.from({ length: 8 }, (_, index) => ({ name: `lens${index}`, notes: ["callers unavailable"] }));
	it.each([originalNotes, twinBaseNotes])("states a shared note once", (renderNotes) => {
		expect(renderNotes(runs)).toEqual(["- callers unavailable"]);
	});
	it("states a shared note once, naming the lenses that share it", () => {
		expect(cleanNotes(runs.slice(0, 2))).toEqual(["- callers unavailable (lens0, lens1)"]);
	});
	it("demonstrates that a shared note prints once per lens", () => {
		expect(badNotes(runs)).toHaveLength(8);
	});
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
	it.each([readHeader, excusedReadHeader])(
		"demonstrates that the hand-written header parser keeps quotation marks and reads a list as text",
		(readHeader) => {
			const note = '---\ntitle: "Plans: 2027"\ntags: [work, home]\n---\nBody\n';
			expect(readHeader(note)).toEqual({ title: '"Plans: 2027"', tags: "[work, home]" });
			expect(readHeader("---\ntitle: Plans\n---\n")).toEqual({ title: "Plans" });
		},
	);
	it("parses a delay in each unit and refuses any other text", () => {
		expect([seconds("90s"), seconds("5m"), seconds("2h"), seconds("1d")]).toEqual([90, 300, 7200, 86_400]);
		for (const invalid of ["", "5", "m", "5w", "5 m", "1.5h"]) {
			expect(() => seconds(invalid)).toThrow(`invalid duration: ${invalid}`);
		}
	});
	it("answers the Node range by hand at the bound and one below, and refuses what it cannot read", {
		timeout: 60_000,
	}, () => {
		const module = new URL(
			"../goldens/design-reimplements-an-authority-clean/head/scripts/node-range.mjs",
			import.meta.url,
		);
		const accepted: [string, string][] = [
			[">=22", "v22.0.0"],
			[">=22", "v23.4.5"],
			[">=9999", "v9999.999999.999999"],
		];
		const refusedVersions = [
			"v21.99.99",
			"v22.0.0-rc.1",
			"v23.0.0-nightly20260101",
			"22.0.0",
			"v22.0",
			"v22",
			"",
			"v022.0.0",
			"v22.00.0",
			"v22.0.01",
			"v10000.0.0",
			"v22.1000000.0",
			"v22.0.1000000",
		];
		const refusedRanges = ["^22", ">=22.1", ">22", "22", "", null, ">=022", ">=0", ">=10000"];
		const cases: [string | null, string][] = [
			...accepted,
			...refusedVersions.map((version): [string, string] => [">=22", version]),
			...refusedRanges.map((range): [string | null, string] => [range, "v22.0.0"]),
		];
		const probe = `import { supported } from ${JSON.stringify(module.href)};
			const cases = JSON.parse(process.argv[1]);
			console.log(JSON.stringify(cases.map(([range, version]) => supported(range ?? undefined, version))));`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe, JSON.stringify(cases)], {
			encoding: "utf8",
		});
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual([true, true, true, ...Array.from({ length: 22 }, () => false)]);
	});
	it.each([
		{ node: `>=${major}`, status: 0 },
		{ node: `>=${major + 1}`, status: 1 },
	])("runs the preinstall check and exits $status for $node", { timeout: 60_000 }, (each) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "melian-check-node-")));
		try {
			const scripts = "../goldens/design-reimplements-an-authority-clean/head/scripts";
			cpSync(fileURLToPath(new URL(scripts, import.meta.url)), join(root, "scripts"), { recursive: true });
			writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { node: each.node } }));
			const result = spawnSync(process.execPath, [join(root, "scripts", "check-node.mjs")], { encoding: "utf8" });
			expect(result.status).toBe(each.status);
			expect(result.stderr).toBe(
				each.status === 0 ? "" : `notes-cli needs Node ${each.node}, and this is ${process.version}\n`,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
