import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { commentRecord } from "./round.mjs";

const script = fileURLToPath(new URL("./round-record.mjs", import.meta.url));
// GitHub's answer to the post of a round's comment, as recorded from run 43558730566 on pull request 422.
const recorded = readFileSync(
	fileURLToPath(new URL("./fixtures/round-comment-check/comment-melian-status-bot.json", import.meta.url)),
	"utf8",
);
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const answer = (fields) =>
	JSON.stringify({
		body: "<!-- melian-round run:9 nonce:0123456789abcdef0123456789abcdef -->\nMelian round",
		html_url: "https://github.com/o/r/pull/7#issuecomment-56",
		issue_url: "https://api.github.com/repos/o/r/issues/7",
		...fields,
	});
const scratch = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("commentRecord", () => {
	it("records the run, the pull request and the hash of the body GitHub stored, linked to the comment", () => {
		const { body, html_url } = JSON.parse(recorded);
		expect(commentRecord(recorded, { runId: "43558730566", pull: "422" })).toEqual({
			state: "success",
			context: "melian/round-comment",
			description: `run 43558730566 pull 422 body sha256 ${sha256(body)}`,
			target_url: html_url,
		});
	});

	it("hashes the body byte for byte, so a changed line ending or a trailing space is a different body", () => {
		const hash = (body) => commentRecord(answer({ body }), { runId: "9", pull: "7" }).description.slice(-64);
		expect(hash("a\nb")).toBe(sha256("a\nb"));
		expect(hash("a\r\nb")).toBe(sha256("a\r\nb"));
		expect(hash("a\nb ")).toBe(sha256("a\nb "));
		expect(hash("é")).toBe(sha256("é"));
		expect(hash("")).toBe(sha256(""));
	});

	it("refuses a run or a pull request with no number, rather than record a body under a wrong one", () => {
		for (const runId of ["", "0", "07", "x", "7x", "x7", undefined]) {
			expect(() => commentRecord(answer({}), { runId, pull: "7" }), String(runId)).toThrow(
				/^the run has no ID to record the comment under$/,
			);
		}
		for (const pull of ["", "0", "07", "x", "7x", "x7", undefined]) {
			expect(() => commentRecord(answer({}), { runId: "9", pull }), String(pull)).toThrow(
				/^the round has no pull request to record the comment under$/,
			);
		}
	});

	it("refuses an answer it cannot read, or one with no body or address", () => {
		for (const posted of ["", "not json", "null", "[]"]) {
			expect(() => commentRecord(posted, { runId: "9", pull: "7" }), posted).toThrow(
				/^GitHub's answer to the comment (could not be read|holds no body or address)$/,
			);
		}
		expect(() => commentRecord("not json", { runId: "9", pull: "7" })).toThrow(
			/^GitHub's answer to the comment could not be read$/,
		);
		for (const fields of [{ body: null }, { body: 1 }, { html_url: null }, { html_url: 1 }]) {
			expect(() => commentRecord(answer(fields), { runId: "9", pull: "7" }), JSON.stringify(fields)).toThrow(
				/^GitHub's answer to the comment holds no body or address$/,
			);
		}
	});

	it("refuses a comment GitHub placed on another pull request", () => {
		for (const issue_url of [
			"https://api.github.com/repos/o/r/issues/17",
			"https://api.github.com/repos/o/r/issues/70",
			"https://api.github.com/repos/o/r/issues/8",
			null,
		]) {
			expect(() => commentRecord(answer({ issue_url }), { runId: "9", pull: "7" }), String(issue_url)).toThrow(
				/^GitHub's answer puts the comment on another pull request than 7$/,
			);
		}
	});

	it("fits a status description at 140 characters, and refuses one past it", () => {
		// "run ", " pull " and " body sha256 " take 23 characters and the hash 64, so 53 are left for the two numbers.
		const fits = commentRecord(answer({ issue_url: "https://api.github.com/repos/o/r/issues/1" }), {
			runId: "9".repeat(52),
			pull: "1",
		});
		expect(fits.description).toHaveLength(140);
		expect(() =>
			commentRecord(answer({ issue_url: "https://api.github.com/repos/o/r/issues/1" }), {
				runId: "9".repeat(53),
				pull: "1",
			}),
		).toThrow(/^the record would not fit a status description$/);
	});
});

describe("the command", () => {
	const run = (posted, ...args) => {
		const dir = mkdtempSync(join(tmpdir(), "round-record-"));
		scratch.push(dir);
		writeFileSync(join(dir, "posted.json"), posted);
		return spawnSync(process.execPath, [script, join(dir, "posted.json"), ...args], { encoding: "utf8" });
	};

	it("prints the status to post", () => {
		const ran = run(answer({ body: "x" }), "9", "7");
		expect([ran.status, JSON.parse(ran.stdout), ran.stderr]).toEqual([
			0,
			{
				state: "success",
				context: "melian/round-comment",
				description: `run 9 pull 7 body sha256 ${sha256("x")}`,
				target_url: "https://github.com/o/r/pull/7#issuecomment-56",
			},
			"",
		]);
	});

	it("exits 1 when GitHub's answer cannot be read, and refuses to run without the pull request", () => {
		const broken = run("", "9", "7");
		expect([broken.status, broken.stdout, broken.stderr]).toEqual([
			1,
			"",
			"GitHub's answer to the comment could not be read\n",
		]);
		const short = run(answer({}), "9");
		expect([short.status, short.stdout, short.stderr]).toEqual([
			64,
			"",
			"usage: node scripts/round-record.mjs <posted.json> <run ID> <pull request number>\n",
		]);
	});
});
