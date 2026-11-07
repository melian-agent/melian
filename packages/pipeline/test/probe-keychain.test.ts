import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Probe } from "../src/probe.ts";

// A probe cannot read the macOS keychain, though sandbox-runtime's profile lets it reach the security services. The
// test adds a keychain of its own to the user's search list while it runs, so it runs only on CI's macOS runner, whose
// keychains are throwaway; the maintainer ran the same check by hand against his login keychain on 2026-11-07.

const throwaway = process.env.CI !== undefined && process.platform === "darwin";
const security = (...args: string[]) => execFileSync("/usr/bin/security", args, { encoding: "utf8" });

// Asks each query and prints only whether it succeeded and whether it returned anything, never what.
const script = (keychain: string) => `
import { spawnSync } from "node:child_process";
const keychain = ${JSON.stringify(keychain)};
const queries = {
	genericSearch: ["find-generic-password", "-s", "melian-probe-canary", "-w"],
	genericPath: ["find-generic-password", "-s", "melian-probe-canary", "-w", keychain],
	internetSearch: ["find-internet-password", "-s", "melian-probe.invalid", "-w"],
	internetPath: ["find-internet-password", "-s", "melian-probe.invalid", "-w", keychain],
	dump: ["dump-keychain", keychain],
};
const results = {};
for (const [name, args] of Object.entries(queries)) {
	const run = spawnSync("/usr/bin/security", args, { encoding: "utf8" });
	results[name] = { status: run.status, returned: (run.stdout ?? "").trim().length > 0 };
}
console.log(JSON.stringify(results));
`;

describe.skipIf(!throwaway)("a probe and the macOS keychain (CI's throwaway macOS runner only)", () => {
	it("gets nothing back from a keychain the user can read, by the search list or by path", {
		timeout: 120_000,
	}, async () => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-keychain-")));
		const worktree = realpathSync(mkdtempSync(join(tmpdir(), "melian-probe-keychain-worktree-")));
		const keychain = join(directory, "probe-test.keychain-db");
		const password = randomBytes(16).toString("hex");
		const canary = randomBytes(16).toString("hex");
		const list = security("list-keychains", "-d", "user")
			.split("\n")
			.map((line) => line.trim().replace(/^"|"$/g, ""))
			.filter((line) => line !== "");
		try {
			security("create-keychain", "-p", password, keychain);
			security("unlock-keychain", "-p", password, keychain);
			security(
				"add-generic-password",
				"-a",
				"melian-probe",
				"-s",
				"melian-probe-canary",
				"-w",
				canary,
				"-A",
				keychain,
			);
			security(
				"add-internet-password",
				"-a",
				"melian-probe",
				"-s",
				"melian-probe.invalid",
				"-w",
				canary,
				"-A",
				keychain,
			);
			security("list-keychains", "-d", "user", "-s", keychain, ...list);
			// Outside the sandbox the canary reads back, so the probe's failure is the sandbox's doing.
			expect(security("find-generic-password", "-s", "melian-probe-canary", "-w").trim()).toBe(canary);
			const probe = await Probe.open(
				{ script: script(keychain) },
				{ worktree, writer: { trusted: true, by: "reviewer" }, trustWriters: true },
			);
			let output: string;
			try {
				const result = await probe.run();
				expect(result.exitCode).toBe(0);
				output = result.output;
			} finally {
				await probe.close();
			}
			expect(output).not.toContain(canary);
			const results = JSON.parse(output) as Record<string, { status: number | null; returned: boolean }>;
			for (const name of ["genericSearch", "genericPath", "internetSearch", "internetPath"])
				expect(results[name], name).toMatchObject({ returned: false });
			for (const name of ["genericSearch", "genericPath", "internetSearch", "internetPath"])
				expect(results[name]?.status, name).not.toBe(0);
		} finally {
			security("list-keychains", "-d", "user", "-s", ...list);
			try {
				security("delete-keychain", keychain);
			} catch {
				// Never created; nothing to delete.
			}
			rmSync(directory, { recursive: true, force: true });
			rmSync(worktree, { recursive: true, force: true });
		}
	});
});
