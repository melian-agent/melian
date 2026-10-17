import { Adjudication, defaultConfig, Finding } from "@melian-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitAuthor, ReviewOutcome } from "../src/commands.ts";
import * as repository from "../src/repository.ts";

afterEach(() => vi.restoreAllMocks());

it("renders no attestation without dismissals and names absent legacy metadata", () => {
	const empty = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig }).adjudicate();
	expect(new ReviewOutcome(empty).renderDismissals()).toBe("");
	const legacy = Finding.create({
		rule: "unsafe",
		file: "src/a.ts",
		startLine: 1,
		snippet: "unsafe()",
		occurrence: 0,
		cause: "introduced",
		severity: "P2",
		status: "dismissed",
		source: { check: "static.example" },
		message: "Unsafe",
		explanation: { what: "Unsafe", whyHere: "New", whatToDo: "Validate" },
	});
	const verdict = new Adjudication({
		findings: [legacy],
		manifest: [],
		checks: [],
		config: defaultConfig,
	}).adjudicate();
	expect(new ReviewOutcome(verdict).renderDismissals()).toBe(
		`Attested dismissals:\n  ${legacy.id} unsafe in src/a.ts: by unknown at unknown: No reason stored.\n`,
	);
});

describe("git author errors", () => {
	it("names dismissal by default when git has no author", async () => {
		const git = vi.spyOn(repository, "git").mockRejectedValue(new Error("identity unavailable"));

		await expect(gitAuthor("/unused")).rejects.toMatchObject({
			name: "CliError",
			message:
				"Melian records who dismissed a finding as the git author, and git has none: identity unavailable; set user.name and user.email",
		});
		expect(git).toHaveBeenCalledExactlyOnceWith("/unused", ["var", "GIT_AUTHOR_IDENT"]);
	});

	it("names the hand match when git has no author", async () => {
		vi.spyOn(repository, "git").mockRejectedValue(new Error("identity unavailable"));

		await expect(gitAuthor("/unused", "matched a finding by hand")).rejects.toMatchObject({
			name: "CliError",
			message:
				"Melian records who matched a finding by hand as the git author, and git has none: identity unavailable; set user.name and user.email",
		});
	});
});
