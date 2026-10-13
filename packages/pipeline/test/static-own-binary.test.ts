import type * as nodeModule from "node:module";
import { defaultConfig } from "@melian-agent/core";
import { backgroundContext as context, createNodeExecutionEnv, runStaticTool } from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sandbox } from "../src/sandbox.ts";
import { commit, createRepository, fakeTool, lines, removeRepository } from "./fixtures/repo.ts";
import { unconfinedSandbox } from "./fixtures/sandbox.ts";

// Melian without a Biome or tsc of its own: its packages do not resolve.
const absent = vi.hoisted(() => ({ own: false }));
vi.mock("node:module", async (importOriginal) => {
	const original = await importOriginal<typeof nodeModule>();
	return {
		...original,
		createRequire: (from: string | URL) => {
			const require = original.createRequire(from);
			const resolve = (name: string) => {
				if (absent.own && /^(@biomejs\/biome|typescript)\//.test(name))
					throw new Error(`Cannot find module '${name}'`);
				return require.resolve(name);
			};
			return Object.assign(require, { resolve });
		},
	};
});

let repo: string;
beforeEach(() => {
	repo = createRepository();
	absent.own = true;
});
afterEach(() => {
	absent.own = false;
	vi.restoreAllMocks();
	removeRepository(repo);
});

it.each(["biome", "tsc"] as const)(
	"skips %s on a host with no sandbox when Melian has none of its own, and never starts the checkout's",
	{ timeout: 60_000 },
	async (tool) => {
		const head = commit(repo, {
			".gitignore": lines("node_modules"),
			"tsconfig.json": "{}",
			"src/a.ts": lines("export const a = 1;"),
		});
		fakeTool(repo, tool, 'echo "Version: 9.9.9"');
		const env = createNodeExecutionEnv(repo);
		const execute = vi.spyOn(env, "exec");
		vi.spyOn(Sandbox, "detect").mockResolvedValue(undefined);
		expect(
			await runStaticTool(
				{ env, repoRoot: repo, commit: head, tool, settings: defaultConfig.static[tool] },
				context,
			),
		).toEqual({
			status: "skipped",
			reason: `${tool} runs from a checkout only inside a sandbox, and Melian has no ${tool} of its own to run: this host offers no sandbox`,
		});
		expect(execute.mock.calls.filter(([command]) => command.includes("--version"))).toEqual([]);
		// Inside a sandbox the checkout's own tool is what runs, Melian's or no.
		vi.spyOn(Sandbox, "detect").mockResolvedValue(unconfinedSandbox);
		const confined = await runStaticTool(
			{ env, repoRoot: repo, commit: head, tool, settings: defaultConfig.static[tool] },
			context,
		).catch((error: Error) => error.message);
		expect(execute.mock.calls.filter(([command]) => command.includes("--version"))).toHaveLength(1);
		expect(JSON.stringify(confined)).not.toContain("only inside a sandbox");
	},
);
