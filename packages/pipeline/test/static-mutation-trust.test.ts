import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { mutationSkips } from "@melian-agent/core";
import { expect, it, vi } from "vitest";

it("requires writer trust at the exported boundary with fake worktree and sandbox controls", async () => {
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
	const detect = vi.fn(() => ({}));
	class FakeRun {
		inWorktree = worktree;
	}
	const run = runInNewContext(`${stripTypeScriptTypes(body.replace("export ", ""))}\nrunStaticTool`, {
		Run: FakeRun,
		Sandbox: { detect },
		mutationSkips,
	}) as (
		input: { tool: string; trustedWriter?: boolean },
		context: object,
	) => Promise<{ status: string; cause?: string }>;
	for (const trustedWriter of [undefined, false])
		expect(await run({ tool: "mutation", trustedWriter }, {})).toMatchObject({
			status: "skipped",
			cause: "untrustedWriter",
		});
	expect(worktree).not.toHaveBeenCalled();
	expect(detect).not.toHaveBeenCalled();
	expect(await run({ tool: "mutation", trustedWriter: true }, {})).toEqual({ status: "ran" });
	expect(detect).toHaveBeenCalledOnce();
	expect(await run({ tool: "biome" }, {})).toEqual({ status: "ran" });
	expect(detect).toHaveBeenCalledOnce();
});
