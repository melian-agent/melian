import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "../src/commands.ts";

const parsed = (command: string) =>
	spawnSync("bash", ["--noprofile", "--norc", "-c", `words() { printf '%s\\0' "$@"; }; words ${command}`], {
		encoding: "utf8",
	});

describe("shellQuote", () => {
	it.each([
		["a plain word", "trusting"],
		["a comment sign", "#12...HEAD"],
		["a space", "dir:/tmp/shared records"],
		["a single quote", "it's"],
		["shell specials beside a single quote", 'it\'s $HOME `id` \\ ! "q"'],
	])("quotes %s so bash reads it back unchanged", (_, argument) => {
		const words = parsed(shellQuote(argument));
		expect(words).toMatchObject({ status: 0, stderr: "" });
		expect(words.stdout).toBe(`${argument}\0`);
	});
});
