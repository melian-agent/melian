import { ComparisonAdjudication } from "@melian-agent/core";
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

describe("comparison report arguments", () => {
	const id = "a".repeat(16);

	it.each([
		[["--since", "2026-01-31"], { since: "2026-01-31" }],
		[["--since", "2026-01-01T00:00:00+10:00"], { since: "2026-01-01T00:00:00+10:00" }],
		[["--last", "5"], { last: 5 }],
		[[], {}],
	])("passes the stats filter %j", async (args, options) => {
		const io = output();
		const stats = vi.spyOn(comparison, "comparisonStats").mockResolvedValue(0);
		try {
			expect(await main(["compare", "stats", ...args], io)).toBe(0);
			expect(stats).toHaveBeenCalledExactlyOnceWith(io, options);
		} finally {
			stats.mockRestore();
		}
	});

	it.each([
		[["stats", "--since", "2026"], "--since takes an ISO date"],
		[["stats", "--since", "2026-1-5"], "--since takes an ISO date"],
		[["stats", "--since", "2026-02-31"], "--since takes an ISO date"],
		[["stats", "--since", "2026-02-31T00:00:00Z"], "--since takes an ISO date"],
		[["stats", "--since", "2026-04-31T12:00:00+10:00"], "--since takes an ISO date"],
		[["stats", "--since", "yesterday"], "--since takes an ISO date"],
		[["stats", "--since", "Jan 1 2026 PST"], "--since takes an ISO date"],
		[["stats", "--last", "0"], "--last takes a positive integer"],
		[["stats", "--last", "99999999999999999999"], "--last takes a positive integer"],
		[["stats", "--since", "2026-01-01", "--last", "1"], "--since or --last, not both"],
		[["stats", "#7"], "compare stats takes no target"],
		[["backlog", "#7"], "compare backlog takes no target"],
		[["adjudicate", "#7"], "compare adjudicate takes a range or pull request and a finding ID"],
		[["adjudicate", "#7", id, "extra"], "compare adjudicate takes a range or pull request and a finding ID"],
		[["adjudicate", "#7", "xyz", "--verdict", "valid"], "a finding ID is 16 hex digits"],
		[["adjudicate", "#7", id], "adjudication needs valid fields"],
	])("refuses %j", async (args, message) => {
		const io = output();
		expect(await main(["compare", ...args], io)).toBe(64);
		expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining(message));
	});

	it("passes the backlog format and the export options through", async () => {
		const io = output();
		const backlog = vi.spyOn(comparison, "comparisonBacklog").mockResolvedValue(0);
		const exported = vi.spyOn(comparison, "exportComparison").mockResolvedValue(0);
		try {
			await main(["compare", "backlog", "--markdown"], io);
			await main(["compare", "backlog"], io);
			expect(backlog.mock.calls).toEqual([
				[io, true],
				[io, false],
			]);
			await main(["compare", "export", "#7", "--json", "--out", "record.json"], io);
			await main(["compare", "export", "#7"], io);
			expect(exported.mock.calls).toEqual([
				[io, "#7", { json: true, out: "record.json" }],
				[io, "#7", { json: false }],
			]);
		} finally {
			backlog.mockRestore();
			exported.mockRestore();
		}
	});

	it("passes an adjudication's fields through, and lets a failure that is not a refusal escape", async () => {
		const io = output();
		const adjudicate = vi.spyOn(comparison, "adjudicateComparison").mockResolvedValue(0);
		try {
			await main(["compare", "adjudicate", "#7", id, "--verdict", "valid", "--reason", "no-owner"], io);
			expect(adjudicate).toHaveBeenCalledExactlyOnceWith(io, "#7", id, {
				verdict: "valid",
				by: "CLI",
				at: expect.any(String),
				reason: "no-owner",
			});
			const failure = new TypeError("not a refusal");
			const create = vi.spyOn(ComparisonAdjudication, "create").mockImplementation(() => {
				throw failure;
			});
			try {
				expect(await main(["compare", "adjudicate", "#7", id, "--verdict", "valid"], io)).toBe(1);
				expect(io.stderr).toHaveBeenCalledWith("melian: not a refusal\n");
			} finally {
				create.mockRestore();
			}
		} finally {
			adjudicate.mockRestore();
		}
	});
});
