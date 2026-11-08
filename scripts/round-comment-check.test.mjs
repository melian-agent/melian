import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fixtures = new URL("./fixtures/round-comment-check/", import.meta.url);
const recorded = (name) => JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));

// The check exactly as AGENTS.md prints it, without the list item's indent.
function check() {
	const text = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
	const block = /\n {2}```bash\n((?: {2}.*\n)+?) {2}```\n/.exec(text.slice(text.indexOf("Before reading one")));
	if (block === null) throw new Error("AGENTS.md holds no comment check");
	return block[1].replaceAll(/^ {2}/gm, "");
}

// A fake gh answers only the check's three requests, by running the check's own --jq over a recorded answer. It answers
// no artefact download, which a cloud session's proxy refuses.
function run(comment) {
	const dir = mkdtempSync(join(tmpdir(), "round-comment-check-"));
	try {
		writeFileSync(join(dir, "repository.json"), JSON.stringify(recorded("repository.json")));
		writeFileSync(join(dir, "run.json"), JSON.stringify(recorded("run.json")));
		writeFileSync(join(dir, "comment.json"), JSON.stringify(comment));
		writeFileSync(
			join(dir, "gh"),
			[
				"#!/bin/sh",
				'if [ "$1 $2 $3" = "api repos/melian-agent/melian --jq" ]; then jq -r "$4" "$FAKE/repository.json"; exit; fi',
				'if [ "$1 $2 $3" = "api repos/melian-agent/melian/actions/runs/42440138303 --jq" ]; then jq -r "$4" "$FAKE/run.json"; exit; fi',
				`if [ "$1 $2 $3" = "api repos/melian-agent/melian/issues/comments/${comment.id} --jq" ]; then jq -r "$4" "$FAKE/comment.json"; exit; fi`,
				"exit 1",
				"",
			].join("\n"),
		);
		chmodSync(join(dir, "gh"), 0o755);
		const ran = spawnSync("bash", ["-c", check(), "check", String(comment.id), "42440138303"], {
			encoding: "utf8",
			env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, FAKE: dir },
		});
		return [ran.status, ran.stdout];
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("the round comment check in AGENTS.md", () => {
	const actions = recorded("comment-github-actions.json");
	const bot = { ...actions, user: recorded("user-melian-status-bot.json") };

	it("reads a comment melian-status-bot posted, whose marker names the run", () => {
		expect(run(bot)).toEqual([0, `comment ${bot.id} is run 42440138303's\n`]);
	});

	it("refuses the same comment from github-actions[bot], which any workflow's token can post", () => {
		expect(actions.user.login).toBe("github-actions[bot]");
		expect(run(actions)).toEqual([
			1,
			`comment ${actions.id} is not melian-status-bot's comment for run 42440138303\n`,
		]);
	});

	it("refuses a comment from another account that took melian-status-bot's login", () => {
		const renamed = { ...bot, user: { ...bot.user, id: bot.user.id + 1 } };
		expect(run(renamed)).toEqual([1, `comment ${bot.id} is not melian-status-bot's comment for run 42440138303\n`]);
	});

	it("refuses melian-status-bot's comment when its marker names another run", () => {
		const other = { ...bot, body: bot.body.replace("run:42440138303 ", "run:424401383030 ") };
		expect(other.body).not.toBe(bot.body);
		expect(run(other)).toEqual([1, `comment ${bot.id} is not melian-status-bot's comment for run 42440138303\n`]);
	});
});
