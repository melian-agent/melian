import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { marker, ownComment } from "./round.mjs";

const script = fileURLToPath(new URL("./round-own-comment.mjs", import.meta.url));
const bot = "github-actions[bot]";
const line = (id, login, body) => JSON.stringify({ id, login, body });
const scratch = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ownComment", () => {
	it("finds the comment this run's job posted, by its marker and its author", () => {
		const comments = [
			line(1, "redbeard", `${marker("7")}\nquoted by a person`),
			line(2, bot, `${marker("70")}\nanother run`),
			line(3, bot, `${marker("6")}\nan earlier run`),
			line(4, bot, `before ${marker("7")}\nnot opening with it`),
			line(5, bot, `${marker("7")}\nthis run`),
			line(6, bot, `${marker("7")}\na later duplicate`),
			"  ",
			"",
		].join("\n");
		expect(ownComment(comments, { runId: "7", author: bot })).toBe(5);
	});

	it("finds nothing when this run has not posted", () => {
		expect(ownComment(line(1, bot, `${marker("6")}\n`), { runId: "7", author: bot })).toBeUndefined();
		expect(ownComment("", { runId: "7", author: bot })).toBeUndefined();
		expect(ownComment(line(1, bot, null), { runId: "7", author: bot })).toBeUndefined();
	});

	it("refuses a run with no ID, rather than match every run's unknown marker", () => {
		for (const runId of ["", "x", undefined]) {
			expect(() => ownComment(line(1, bot, `${marker(runId)}\n`), { runId, author: bot })).toThrow(
				/^the run has no ID to find its comment by$/,
			);
		}
	});

	it("refuses a line that is not a comment, rather than pass over it", () => {
		expect(() => ownComment(`not json\n${line(5, bot, `${marker("7")}\n`)}`, { runId: "7", author: bot })).toThrow(
			/^a comment could not be read$/,
		);
	});
});

describe("the command", () => {
	const run = (comments, ...args) => {
		const dir = mkdtempSync(join(tmpdir(), "round-own-comment-"));
		scratch.push(dir);
		writeFileSync(join(dir, "comments.jsonl"), comments);
		return spawnSync(process.execPath, [script, join(dir, "comments.jsonl"), ...args], { encoding: "utf8" });
	};

	it("prints the comment's ID, or nothing when this run posted none", () => {
		const found = run(line(42, bot, `${marker("7")}\n`), "7", bot);
		expect([found.status, found.stdout, found.stderr]).toEqual([0, "42", ""]);
		const none = run("", "7", bot);
		expect([none.status, none.stdout, none.stderr]).toEqual([0, "", ""]);
	});

	it("exits 1 when the comments cannot be read, and refuses to run without its author", () => {
		const broken = run("not json", "7", bot);
		expect([broken.status, broken.stdout, broken.stderr]).toEqual([1, "", "a comment could not be read\n"]);
		const short = run("", "7");
		expect([short.status, short.stdout, short.stderr]).toEqual([
			64,
			"",
			"usage: node scripts/round-own-comment.mjs <comments.jsonl> <run ID> <author>\n",
		]);
	});
});
