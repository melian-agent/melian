import { readFileSync } from "node:fs";
import { DecisionFile, DecisionFiles } from "@melian-agent/decisions";
import { describe, expect, it } from "vitest";
import { MarkdownDocument } from "../src/markdown.ts";

const old = "docs/decisions/old.md";
const fresh = "docs/decisions/new.md";

describe("decision amendments", () => {
	it("keeps the Markdown supersedes query limited to whole-retirement declarations", () => {
		const document = MarkdownDocument.parse("Supersedes: old.md\n\nAmends: other.md, routing.");
		expect(document.supersedes(fresh)).toEqual([old]);
	});
	it.each(["Supersedes", "Amends"])("distinguishes %s from context and absence sentinels", (kind) => {
		const property = kind === "Supersedes" ? "supersedes" : "amends";
		expect(DecisionFile.parse(fresh, "Context: [Old](old.md)")[property]).toEqual([]);
		expect(DecisionFile.parse(fresh, "Context: [Old](old.md)").declarations).toEqual([]);
		expect(DecisionFile.parse(fresh, `${kind}: none [Old](old.md)`)[property]).toEqual([]);
		expect(DecisionFile.parse(fresh, `${kind}: no decision file; old.md`)[property]).toEqual([]);
	});
	it.each(["Supersedes", "Amends"])("limits %s edges to the first sentence", (kind) => {
		const text = `${kind}: [Old](old.md), for routing only. The preference in [Context](context.md) remains.`;
		const decision = DecisionFile.parse(fresh, text);
		expect(decision[kind === "Supersedes" ? "supersedes" : "amends"]).toEqual([old]);
		expect(DecisionFile.parse(fresh, `${kind}: [Old](old.md). [Context](first.md)`).declarations[0]!.text).toBe(
			DecisionFile.parse(fresh, `${kind}: [Old](old.md). [Context](second.md)`).declarations[0]!.text,
		);
		expect(
			DecisionFile.parse(fresh, `${kind}: [Old](old.md). [Context](context.md)`)[
				kind === "Supersedes" ? "supersedes" : "amends"
			],
		).toEqual([old]);
		expect(
			DecisionFile.parse(fresh, `${kind}: old.md. Context context.md remains.`)[
				kind === "Supersedes" ? "supersedes" : "amends"
			],
		).toEqual([old]);
	});

	it("keeps verification-pass active in the subscription-verifier golden", () => {
		const path = "docs/decisions/2026-10-08-verifier-on-codex-subscription.md";
		const content = readFileSync(new URL("golden/verifier-on-codex-subscription.md", import.meta.url), "utf8");
		const declaration = DecisionFile.parse(path, content);
		expect(declaration.supersedes).toEqual(["docs/decisions/2026-10-07-committed-routes.md"]);
		const index = DecisionFiles.from([
			declaration,
			DecisionFile.parse("docs/decisions/2026-10-07-committed-routes.md", "# Routes"),
			DecisionFile.parse("docs/decisions/2026-10-04-verification-pass.md", "# Verification"),
		]).render();
		expect(index).toContain("[ACTIVE] docs/decisions/2026-10-04-verification-pass.md — Verification");
	});

	it("keeps an amended target active and names the conflict authority", () => {
		const amendment = DecisionFile.parse(fresh, "# New\n\nAmends: [Old](old.md), for routing only.");
		expect(amendment.supersedes).toEqual([]);
		expect(amendment.amends).toEqual([old]);
		const index = DecisionFiles.from([DecisionFile.parse(old, "# Old"), amendment]).render();
		expect(index).toContain(`[ACTIVE; amended by ${fresh}] ${old} — Old`);
		expect(index).toContain(`[ACTIVE] ${fresh} — New`);
		expect(index).toContain("Read both files; where they conflict, the amendment wins.");
	});

	it("retains every amendment on a shared target", () => {
		const other = "docs/decisions/other.md";
		const index = DecisionFiles.from([
			DecisionFile.parse(old, "# Old"),
			DecisionFile.parse(fresh, "Amends: old.md, routing."),
			DecisionFile.parse(other, "Amends: old.md, retries."),
		]).render();
		expect(index).toContain(`[ACTIVE; amended by ${fresh}, ${other}] ${old} — Old`);
	});

	it("names a whole-retirement successor once when it also declares an amendment", () => {
		const index = DecisionFiles.from([
			DecisionFile.parse(old, "# Old"),
			DecisionFile.parse(fresh, "Supersedes: old.md\n\nAmends: old.md, routing."),
		]).render();
		expect(index).toContain(`[INACTIVE; superseded by ${fresh}] ${old} — Old`);
	});

	it("counts amendment labels and precedence text within the 64 KiB bound", () => {
		const index = (title: string) =>
			DecisionFiles.from([
				DecisionFile.parse(old, `# ${title}`),
				DecisionFile.parse(fresh, "Amends: old.md, routing."),
			]);
		const padding = 65536 - Buffer.byteLength(index("X").render());
		expect(Buffer.byteLength(index(`X${"x".repeat(padding)}`).render())).toBe(65536);
		expect(() => index(`X${"x".repeat(padding + 1)}`).render()).toThrow("exceeds");
	});

	it.each(["Amends", "Supersedes"])("validates missing %s targets and mixed cycles", (kind) => {
		expect(() => DecisionFiles.from([DecisionFile.parse(fresh, `${kind}: old.md`)])).toThrow("absent");
		expect(() =>
			DecisionFiles.from([
				DecisionFile.parse(fresh, `${kind}: old.md`),
				DecisionFile.parse(old, "Amends: new.md, routing."),
			]),
		).toThrow("cycle");
	});

	it("uses the existing Markdown grammar for amendment declarations", () => {
		const parsed = DecisionFile.parse(
			fresh,
			[
				"# New",
				"",
				"Amends&#58; [**Old**][target], routing.",
				"",
				"Amends: none. [Context](absent.md)",
				"",
				"> Amends: quoted.md",
				"",
				"- Amends: listed.md",
				"",
				"`Amends: code.md`",
				"",
				"~~~md",
				"Amends: fenced.md",
				"~~~",
				"",
				"[target]: old.md",
			].join("\n"),
		);
		expect(parsed.amends).toEqual([old]);
	});
});
