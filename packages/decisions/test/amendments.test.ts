import { readFileSync } from "node:fs";
import { DecisionFile, DecisionFiles } from "@melian-agent/decisions";
import { describe, expect, it } from "vitest";

const old = "docs/decisions/old.md";
const fresh = "docs/decisions/new.md";

describe("decision amendments", () => {
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
