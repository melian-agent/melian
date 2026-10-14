import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { mutationSkips } from "@melian-agent/core";
import { expect, it, vi } from "vitest";

it("requires the host's leave at the exported boundary, before any worktree", async () => {
	const source = readFileSync(new URL("../src/static.ts", import.meta.url), "utf8");
	let body = source.slice(
		source.indexOf("export async function runStaticTool("),
		source.indexOf("// Each worktree is locked"),
	);
	const fault = process.env.MELIAN_STATIC_TRUST_FAULT;
	if (fault) {
		const [before, after] = JSON.parse(fault) as [string, string];
		expect(body.split(before)).toHaveLength(2);
		body = body.replace(before, after);
	}
	const worktree = vi.fn(async () => ({ status: "ran" }));
	class FakeRun {
		inWorktree = worktree;
	}
	const run = runInNewContext(`${stripTypeScriptTypes(body.replace("export ", ""))}\nrunStaticTool`, {
		Run: FakeRun,
		mutationSkips,
	}) as (input: { tool: string; headCode?: string }, context: object) => Promise<{ status: string; cause?: string }>;
	expect(await run({ tool: "mutation" }, {})).toEqual({
		status: "skipped",
		cause: "headNotAllowed",
		reason: mutationSkips.headNotAllowed("the caller did not say this head's code may run here"),
	});
	expect(worktree).not.toHaveBeenCalled();
	expect(await run({ tool: "mutation", headCode: "trusted" }, {})).toEqual({ status: "ran" });
	expect(worktree).toHaveBeenCalledTimes(1);
	// Biome and tsc read the head and never run it, so they need no leave.
	expect(await run({ tool: "biome" }, {})).toEqual({ status: "ran" });
});
