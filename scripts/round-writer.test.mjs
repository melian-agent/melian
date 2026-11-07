import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { headWriter } from "./round.mjs";

const script = fileURLToPath(new URL("./round-writer.mjs", import.meta.url));
const sha = "1".repeat(40);
const other = "2".repeat(40);
const head = { sha, branch: "feature" };
const push = (actor, overrides = {}) => JSON.stringify({ actor, head: sha, ref: "refs/heads/feature", ...overrides });
const scratch = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("headWriter", () => {
	it("names the pusher of the first event for exactly this commit on exactly this branch", () => {
		const events = [
			push("someone-else", { head: other }),
			"  ",
			"",
			push("on-another-branch", { ref: "refs/heads/other" }),
			push("newest-pusher"),
			push("older-pusher"),
		].join("\n");
		expect(headWriter(events, head)).toBe("newest-pusher");
	});

	it("passes over an event for this commit on a branch whose name only starts the same", () => {
		const events = [push("prefix", { ref: "refs/heads/feature-2" }), push("dependabot[bot]")].join("\n");
		expect(headWriter(events, head)).toBe("dependabot[bot]");
	});

	it("refuses a head no push event names, whoever wrote the pull request, rather than trust its author", () => {
		const missing =
			/^no push event names this head on this branch; GitHub's events feed can lag by hours and keeps only the latest 300, so start the round again later$/;
		expect(() => headWriter(`${push("someone-else", { head: other })}\n`, head)).toThrow(missing);
		expect(() => headWriter("", head)).toThrow(missing);
	});

	it("refuses a matching event that names no pushing identity, rather than fall back", () => {
		for (const actor of ["", null, undefined, 7]) {
			expect(() => headWriter(push(actor), head)).toThrow(/^the head's push event names no pushing identity$/);
		}
	});

	it("refuses a line that is not a push event, rather than pass over it", () => {
		expect(() => headWriter(`not json\n${push("pusher")}`, head)).toThrow(/^a push event could not be read$/);
	});
});

describe("the command", () => {
	const run = (events, ...args) => {
		const dir = mkdtempSync(join(tmpdir(), "round-writer-"));
		scratch.push(dir);
		writeFileSync(join(dir, "pushes.jsonl"), events);
		return spawnSync(process.execPath, [script, join(dir, "pushes.jsonl"), ...args], { encoding: "utf8" });
	};

	it("prints the login alone", () => {
		const ran = run(`${push("pusher")}\n`, sha, "feature");
		expect([ran.status, ran.stdout, ran.stderr]).toEqual([0, "pusher", ""]);
	});

	it("exits 1 with nothing on standard output when the events cannot say", () => {
		const ran = run(push(""), sha, "feature");
		expect([ran.status, ran.stdout, ran.stderr]).toEqual([
			1,
			"",
			"the head's push event names no pushing identity\n",
		]);
	});

	it("refuses to run without the head's branch", () => {
		const ran = run("", sha);
		expect([ran.status, ran.stdout, ran.stderr]).toEqual([
			64,
			"",
			"usage: node scripts/round-writer.mjs <events.jsonl> <head SHA> <head branch>\n",
		]);
	});
});
