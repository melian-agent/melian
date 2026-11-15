import { expect, it } from "vitest";
import { gitIn } from "../../core/test/fixtures/repo.ts";
import { Remote } from "./fixtures/state.ts";

it("turns off git's automatic maintenance in the remote and every clone, which would outlive the test", () => {
	const remote = new Remote();
	try {
		const clone = remote.clone();
		expect(gitIn(remote.bare, "config", "--get", "receive.autogc")).toBe("false");
		expect(gitIn(remote.bare, "config", "--get", "maintenance.auto")).toBe("false");
		expect(gitIn(clone.repoRoot, "config", "--get", "maintenance.auto")).toBe("false");
	} finally {
		remote.close();
	}
});
