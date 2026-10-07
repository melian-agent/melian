import { describe, expect, it, vi } from "vitest";
import type { Io } from "../src/commands.ts";
import * as comparison from "../src/compare.ts";
import { main } from "../src/main.ts";

function output() {
	return { cwd: "/unused", env: {}, color: false, stdout: vi.fn(), stderr: vi.fn() } satisfies Io;
}

describe("comparison arguments", () => {
	it.each([
		[["main...feature"], []],
		[["#7"], [{ kind: "github", login: "coderabbitai[bot]" }]],
		[["#7", "--from", "github:octocat"], [{ kind: "github", login: "octocat" }]],
		[["#7", "--from", "file:review.json"], [{ kind: "file", path: "review.json" }]],
		[
			["main...feature", "--from", "file:a.json", "--from", "file:b.json"],
			[
				{ kind: "file", path: "a.json" },
				{ kind: "file", path: "b.json" },
			],
		],
	])("passes the target and all sources: %j", async (args, sources) => {
		const io = output();
		const compare = vi.spyOn(comparison, "compare").mockResolvedValue(0);
		try {
			expect(await main(["compare", ...(args as string[])], io)).toBe(0);
			expect(compare).toHaveBeenCalledExactlyOnceWith(io, args[0], sources);
		} finally {
			compare.mockRestore();
		}
	});

	it.each(["match", "unmatch"])("passes a hand %s with both finding IDs", async (action) => {
		const io = output();
		const match = vi.spyOn(comparison, "matchByHand").mockResolvedValue(0);
		try {
			expect(await main(["compare", action, "#7", "a".repeat(16), "b".repeat(16)], io)).toBe(0);
			expect(match).toHaveBeenCalledExactlyOnceWith(
				io,
				"#7",
				{ external: "a".repeat(16), melian: "b".repeat(16) },
				action === "match",
			);
		} finally {
			match.mockRestore();
		}
	});

	it.each([
		[[], "compare takes one range or pull request"],
		[["match", "#7", "a".repeat(16)], "an external ID, and a Melian ID"],
		[["unmatch", "#7", "a".repeat(16), "b".repeat(16), "extra"], "an external ID, and a Melian ID"],
		[["match", "#7", "bad", "b".repeat(16)], "bad is not a finding ID"],
		[["unmatch", "#7", "a".repeat(16), "bad"], "bad is not a finding ID"],
		[["main...feature", "--from", "github"], 'name it as "#12"'],
		[["#7", "--from", "github:"], "--from takes github"],
		[["#7", "--from", "file:"], "--from takes github"],
	])("refuses invalid arguments: %j", async (args, message) => {
		const io = output();
		expect(await main(["compare", ...args], io)).toBe(64);
		expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining(message));
	});

	it.each([new Error("bad\u001b[2J"), "bad\u001b[2J"])(
		"prints a rejected value as visible text: %j",
		async (failure) => {
			const io = output();
			const compare = vi.spyOn(comparison, "compare").mockRejectedValue(failure);
			try {
				expect(await main(["compare", "main...feature"], io)).toBe(1);
				expect(io.stderr).toHaveBeenCalledExactlyOnceWith("melian: bad\\u001b[2J\n");
			} finally {
				compare.mockRestore();
			}
		},
	);
});

describe("a failure with a numeric code", () => {
	it("reports a child-process exit status as a message, not a crash", async () => {
		const io = output();
		const compare = vi.spyOn(comparison, "compare").mockRejectedValue(Object.assign(new Error("git exited"), { code: 128 }));
		try {
			expect(await main(["compare", "main...feature"], io)).toBe(1);
			expect(io.stderr).toHaveBeenCalledExactlyOnceWith("melian: git exited\n");
		} finally {
			compare.mockRestore();
		}
	});
});
