import { join } from "node:path";
import { Changeset, Revision } from "@melian-agent/core";
import {
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewIndex } from "../../pipeline/src/review-index.ts";
import {
	commit,
	createRepository,
	gitIn,
	isolatedGitEnv,
	removeRepository,
} from "../../pipeline/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import { storagePath } from "../src/repository.ts";

let repo: string;
afterEach(() => {
	vi.unstubAllEnvs();
	if (repo) removeRepository(repo);
});

// A review handed bare records proves no static finding, so a refactor must never route the CLI's review that way.
it("hands the adjudication the check run the CLI's review ran", { timeout: 120_000 }, async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = createRepository();
	commit(repo, {
		"melian.yaml": "tiers:\n  full: [static.tsc]\n",
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
		"src/a.ts": "export const a: number = 1;\n",
	});
	gitIn(repo, "checkout", "-b", "feature");
	commit(repo, { "src/a.ts": "export const a: number = 2;\n" });
	const errors: string[] = [];
	const io: Io = {
		cwd: repo,
		env: {
			MELIAN_STATE_DIR: join(repo, "state"),
			XDG_CONFIG_HOME: join(repo, "config"),
			PI_CODING_AGENT_DIR: join(repo, "pi"),
		},
		stdout: () => {},
		stderr: (text) => errors.push(text),
		color: false,
	};

	expect(await main(["review", "main...feature"], io), errors.join("")).toBe(0);

	const changeset = await Changeset.resolve(repo, "main...feature");
	const fake = createFakeModels();
	const harness = await openHarness(await openSqliteStorage(await storagePath(repo, changeset.id, io.env, false)), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	try {
		const root = await harness.root(context);
		const index = await harness.snapshot(ReviewIndex, root.id, context);
		const entry = index?.reviews[Revision.key(changeset.revision)]?.adjudication;
		expect(entry).toBeDefined();
		expect(JSON.parse(entry!.input).run).toEqual({
			identity: expect.objectContaining({
				base: changeset.revision.base,
				head: changeset.revision.head,
				tier: "full",
			}),
			request: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
	} finally {
		await harness.close(context);
	}
});
