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

// Asks each query and reports only whether it succeeded, whether it returned anything, and, for dump-keychain, whether
// its output named the canary account; never the secret itself. `marker` is the canary's unique account name.
const script = (keychain: string, service: string, marker: string) => `
import { spawnSync } from "node:child_process";
const keychain = ${JSON.stringify(keychain)}, service = ${JSON.stringify(service)}, marker = ${JSON.stringify(marker)};
const run = (...args) => spawnSync("/usr/bin/security", args, { encoding: "utf8" });
const search = {
	genericSearch: run("find-generic-password", "-s", service, "-w"),
	genericPath: run("find-generic-password", "-s", service, "-w", keychain),
	internetSearch: run("find-internet-password", "-s", service, "-w"),
	internetPath: run("find-internet-password", "-s", service, "-w", keychain),
};
const results = {};
for (const [name, r] of Object.entries(search)) results[name] = { status: r.status, returned: (r.stdout ?? "").trim().length > 0 };
const dump = run("dump-keychain", keychain);
// What the maintainer's manual probe checked: whether the dump named the canary account.
results.dump = { status: dump.status, containedMarker: (dump.stdout ?? "").includes(marker) };
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
		const secret = randomBytes(16).toString("hex");
		const service = "melian-probe-canary";
		const marker = `melian-canary-${randomBytes(8).toString("hex")}`;
		const list = security("list-keychains", "-d", "user")
			.split("\n")
			.map((line) => line.trim().replace(/^"|"$/g, ""))
			.filter((line) => line !== "");
		try {
			security("create-keychain", "-p", password, keychain);
			security("unlock-keychain", "-p", password, keychain);
			security("add-generic-password", "-a", marker, "-s", service, "-w", secret, "-A", keychain);
			security("add-internet-password", "-a", marker, "-s", service, "-w", secret, "-A", keychain);
			security("list-keychains", "-d", "user", "-s", keychain, ...list);
			// Outside the sandbox the secret reads back and the dump names the canary, so the probe's failure is the
			// sandbox's doing, not a keychain that never held the item.
			expect(security("find-generic-password", "-s", service, "-w").trim()).toBe(secret);
			expect(security("dump-keychain", keychain)).toContain(marker);
			const probe = await Probe.open(
				{ script: script(keychain, service, marker) },
				{ writer: { trusted: true, by: "reviewer" }, trustWriters: true },
			);
			let output: string;
			try {
				const result = await probe.run();
				expect(result.exitCode).toBe(0);
				output = result.output;
			} finally {
				await probe.close();
			}
			expect(output).not.toContain(secret);
			expect(output).not.toContain(marker);
			const results = JSON.parse(output) as Record<
				string,
				{ status: number | null; returned?: boolean; containedMarker?: boolean }
			>;
			for (const name of ["genericSearch", "genericPath", "internetSearch", "internetPath"]) {
				expect(results[name], name).toMatchObject({ returned: false });
				expect(results[name]?.status, name).not.toBe(0);
			}
			expect(results.dump?.containedMarker).toBe(false);
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
