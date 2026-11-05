import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexAccessToken } from "./round.mjs";

const script = fileURLToPath(new URL("./round-codex-token.mjs", import.meta.url));
const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
const login = (tokens) => encode({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens, last_refresh: "2026-11-04" });

describe("codexAccessToken", () => {
	it("takes the access token of a Codex login and nothing else", () => {
		expect(codexAccessToken(login({ id_token: "id", access_token: "access", refresh_token: "refresh" }))).toBe(
			"access",
		);
	});

	it("reads no login when the variable is unset or empty", () => {
		expect(codexAccessToken(undefined)).toBeUndefined();
		expect(codexAccessToken("")).toBeUndefined();
	});

	it("reads no login from text that is not a Codex login", () => {
		expect(codexAccessToken(encode("not json"))).toBeUndefined();
		expect(codexAccessToken(encode({ OPENAI_API_KEY: "sk-test" }))).toBeUndefined();
		expect(codexAccessToken(login({ refresh_token: "refresh" }))).toBeUndefined();
		expect(codexAccessToken(login({ access_token: "" }))).toBeUndefined();
		expect(codexAccessToken(login({ access_token: 7 }))).toBeUndefined();
	});
});

describe("the command", () => {
	const run = (value) =>
		spawnSync(process.execPath, [script], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, ...(value === undefined ? {} : { CODEX_AUTH_B64: value }) },
		});

	it("prints the access token alone", () => {
		const ran = run(login({ access_token: "access", refresh_token: "refresh" }));
		expect([ran.status, ran.stdout, ran.stderr]).toEqual([0, "access", ""]);
	});

	it("exits 1 with nothing on standard output when there is no login", () => {
		for (const value of [undefined, encode("not json")]) {
			const ran = run(value);
			expect([ran.status, ran.stdout, ran.stderr]).toEqual([1, "", "no Codex access token in CODEX_AUTH_B64\n"]);
		}
	});
});
