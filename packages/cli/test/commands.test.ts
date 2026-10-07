import { afterEach, describe, expect, it, vi } from "vitest";
import { gitAuthor } from "../src/commands.ts";
import * as repository from "../src/repository.ts";

afterEach(() => vi.restoreAllMocks());

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
