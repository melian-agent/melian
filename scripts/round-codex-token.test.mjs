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

	it("says the variable is unset when it is absent or empty", () => {
		expect(() => codexAccessToken(undefined)).toThrow(/^CODEX_AUTH_B64 is unset$/);
		expect(() => codexAccessToken("")).toThrow(/^CODEX_AUTH_B64 is unset$/);
	});

	it("says the text is not a Codex login without quoting it", () => {
		for (const value of [encode("sk-secret-not-json"), encode({ OPENAI_API_KEY: "sk-secret" })]) {
			expect(() => codexAccessToken(value)).toThrow(/^CODEX_AUTH_B64 is not a Codex login$/);
		}
	});

	it("says a login with no usable access token has none", () => {
		for (const tokens of [{ refresh_token: "refresh" }, { access_token: "" }, { access_token: 7 }]) {
			expect(() => codexAccessToken(login(tokens))).toThrow(
				/^the Codex login in CODEX_AUTH_B64 has no access token$/,
			);
		}
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

	it("exits 1 with nothing on standard output, naming what is missing, when there is no token", () => {
		const ran = run(undefined);
		expect([ran.status, ran.stdout, ran.stderr]).toEqual([1, "", "CODEX_AUTH_B64 is unset\n"]);
		const malformed = run(encode("sk-secret-not-json"));
		expect([malformed.status, malformed.stdout, malformed.stderr]).toEqual([
			1,
			"",
			"CODEX_AUTH_B64 is not a Codex login\n",
		]);
	});
});
