import { expect, it } from "vitest";
import { Remote } from "./fixtures/remote.ts";

it("turns off git's automatic maintenance in the remote every handle pushes into, which would outlive the test", async () => {
	const remote = await Remote.create();
	try {
		expect(remote.git(["config", "--get", "receive.autogc"])).toBe("false");
		expect(remote.git(["config", "--get", "maintenance.auto"])).toBe("false");
	} finally {
		await remote.close();
	}
});
