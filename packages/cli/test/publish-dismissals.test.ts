import { rmSync } from "node:fs";
import { Adjudication, Changeset, defaultConfig, Finding } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	createRegistry,
	openHarness,
	openSqliteStorage,
	revisionKey,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../../pipeline/src/adjudication.ts";
import { baseAndHead, isolatedGitEnv } from "../../pipeline/test/fixtures/repo.ts";
import { publish } from "../src/commands.ts";
import { storagePath } from "../src/repository.ts";
import * as targets from "../src/target.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it.each([false, true])("prints every carried dismissal it attests, with installation token: %s", async (failUser) => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	const repo = baseAndHead({ "src/a.ts": "old\n" }, { "src/a.ts": "new\n" });
	try {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const state = pullRequestState();
		moveTo(state, changeset);
		state.failUser = failUser;
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		vi.spyOn(targets, "gitHubFor").mockResolvedValue(provider);
		vi.spyOn(targets, "pullRequestChangeset").mockResolvedValue(changeset);
		vi.spyOn(targets, "currentBase").mockResolvedValue(changeset.revision.base);
		const fake = createFakeModels();
		const env = { ...process.env, MELIAN_TEST_SCRIPT: undefined };
		const path = await storagePath(repo, changeset.id, env, false);
		const harness = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry: createRegistry(),
		});
		const created = Finding.create({
			rule: "unsafe",
			file: "src/a.ts",
			startLine: 1,
			snippet: "new",
			occurrence: 0,
			severity: "P2",
			cause: "introduced",
			message: "Unsafe input",
			source: { check: "static.example" },
			status: "dismissed",
			explanation: { what: "Unsafe", whyHere: "New", whatToDo: "Validate" },
		});
		const dismissed = Finding.from({
			...created.toJSON(),
			properties: {
				...created.properties,
				dismissal: {
					by: "Maintainer <private@example.invalid>",
					at: "2026-10-17T00:00:00Z",
					reason: "Reviewed\u001b[31m input.",
				},
			},
		});
		try {
			const root = await harness.root(context, { agent: { model: fake.ref() } });
			await root.commit(async (tx) => {
				const doc = await tx.doc(VerdictDocument, root.id);
				const key = revisionKey(changeset.revision);
				doc.verdicts[key] = new Adjudication({
					findings: [dismissed],
					manifest: [],
					checks: [],
					config: defaultConfig,
				})
					.adjudicate()
					.toJSON();
				doc.provenance = {
					[key]: {
						kind: "pull-request",
						manifest: [],
						lenses: [],
						repository: { owner: state.owner, name: state.repo },
						pullRequest: 7,
						base: changeset.revision.base,
						head: changeset.revision.head,
						policy: `revision:${changeset.revision.base}`,
					},
				};
			}, context);
		} finally {
			await harness.close(context);
		}
		const output: string[] = [];
		const io = { cwd: repo, env, stdout: (text: string) => output.push(text), stderr: () => {}, color: false };
		expect(await publish(io, "#7")).toBe(0);
		expect(output.join("")).toContain("Attested dismissals:");
		for (const expected of [
			dismissed.id,
			"unsafe",
			"src/a.ts",
			"Maintainer <private@example.invalid>",
			"2026-10-17T00:00:00Z",
			"Reviewed\\u001b[31m input.",
		])
			expect(output.join("")).toContain(expected);
		expect(output.join("")).not.toContain("\u001b");
		expect(output.join("")).toContain("Status success: 0 findings, 1 dismissed");
		output.length = 0;
		expect(await publish(io, "#7")).toBe(0);
		expect(output.join("")).toContain(dismissed.id);
		expect(state.reviews).toHaveLength(1);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
