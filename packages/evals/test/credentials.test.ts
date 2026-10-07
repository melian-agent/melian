import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveCredentials, liveModels } from "../src/credentials.ts";

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

describe("liveModels", () => {
	let config: string;
	beforeEach(() => {
		config = realpathSync(mkdtempSync(join(tmpdir(), "melian-live-config-")));
	});
	afterEach(() => rmSync(config, { recursive: true, force: true }));

	const secrets = (command: string) => {
		mkdirSync(join(config, "melian"), { recursive: true, mode: 0o700 });
		writeFileSync(
			join(config, "melian", "secrets.yaml"),
			`credentials:\n  vault: { provider: anthropic, command: "${command}" }\n`,
			{ mode: 0o600 },
		);
	};
	const env = () => ({ XDG_CONFIG_HOME: config });

	it("stops a run before its first model request when a credential's command fails, naming the credential", async () => {
		const marker = join(repo, "ran");
		secrets(`touch ${marker}; exit 3`);
		await expect(liveModels(join(repo, "packages", "evals"), env())).rejects.toThrow(
			/credential vault in .*secrets\.yaml/,
		);
		expect(existsSync(marker)).toBe(true);
	});

	it("returns the models once every named command has run", async () => {
		const marker = join(repo, "ran");
		secrets(`touch ${marker}; printf key-value`);
		await liveModels(join(repo, "packages", "evals"), env());
		expect(existsSync(marker)).toBe(true);
	});
});
