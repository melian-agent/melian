import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RecordStoreFixture, recordStoreConformance, testPayloads } from "@melian-agent/core/testing";
import { describe, it } from "vitest";
import { Remote } from "./fixtures/remote.ts";

// Every handle on one bare repository, each with a state directory of its own as a second host's clone has. `cutOff`
// removes the remote, and `plant` commits a link from a kind's folder to a directory outside the store.
const fixture: RecordStoreFixture = async () => {
	const remote = await Remote.create();
	const outside = await mkdtemp(join(tmpdir(), "melian-state-git-outside-"));
	return {
		open: (payloads = testPayloads) => remote.open({ payloads }),
		cutOff: () => rm(remote.path, { recursive: true, force: true }),
		plant: async (changeset, kind) => {
			remote.plant({ [`changesets/${changeset}/${kind}`]: { bytes: outside, mode: "120000" } });
			return async () => (await readdir(outside)).length > 0;
		},
		close: async () => {
			await remote.close();
			await rm(outside, { recursive: true, force: true });
		},
	};
};

describe("the git record store", { timeout: 60_000 }, () => {
	for (const conformance of recordStoreConformance) it(conformance.name, () => conformance.run(fixture));
});
