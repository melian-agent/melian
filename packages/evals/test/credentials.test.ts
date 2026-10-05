import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveCredentials } from "../src/credentials.ts";

let repo: string;

beforeEach(() => {
	repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-live-")));
	execFileSync("git", ["init", "--quiet"], { cwd: repo });
	writeFileSync(
		join(repo, "melian.secrets.yaml"),
		"credentials:\n  pinned: { provider: openai, env: OPENAI_API_KEY }\n",
		{
			mode: 0o600,
		},
	);
	mkdirSync(join(repo, "packages", "evals"), { recursive: true });
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("liveCredentials", () => {
	it("reads the repository root's secrets file from the evals package, where npm runs the script", async () => {
		const credentials = await liveCredentials(join(repo, "packages", "evals"), {
			XDG_CONFIG_HOME: join(repo, "none"),
		});
		expect(credentials.map(({ name, file }) => [name, file])).toEqual([
			["pinned", join(repo, "melian.secrets.yaml")],
		]);
	});
});
