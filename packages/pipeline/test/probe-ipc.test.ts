import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Probe } from "../src/probe.ts";

// bubblewrap leaves the IPC namespace shared, so without Melian's own wrap a probe lists and removes the host's System V
// segments, which belong to the same user. Linux alone: macOS has no IPC namespace, and the macOS CI job requires every
// test in the probe suites it names to pass there, so this test has a file of its own. MELIAN_PROBE_SANDBOX=1 makes it
// fail, not skip, where the sandbox cannot run.

const availability = await Probe.availability();
const required = process.env.MELIAN_PROBE_SANDBOX === "1";
const reason = availability.available ? "" : availability.reason;

describe.runIf(process.platform === "linux" && (availability.available || required))(
	`a probe under bubblewrap${reason ? ` (${reason})` : ""}`,
	() => {
		it("cannot see or remove a System V shared memory segment the host holds", { timeout: 60_000 }, async () => {
			const made = spawnSync("ipcmk", ["--shmem", "64"], { encoding: "utf8" });
			expect(made.status, made.stderr).toBe(0);
			const id = /(\d+)\s*$/.exec(made.stdout)?.[1];
			expect(id, made.stdout).toBeDefined();
			try {
				const script = `
import { execFileSync } from "node:child_process";
const id = ${JSON.stringify(id)};
const listed = execFileSync("ipcs", ["-m"], { encoding: "utf8" }).split("\\n").some((line) => line.trim().split(/\\s+/)[1] === id);
let removed = false;
try { execFileSync("ipcrm", ["-m", id], { stdio: "ignore" }); removed = true; } catch {}
console.log(JSON.stringify({ listed, removed }));
`;
				const probe = await Probe.open(
					{ script },
					{ writer: { trusted: true, by: "reviewer" }, trustWriters: true },
				);
				let output: string;
				try {
					const result = await probe.run();
					expect(result, result.output).toMatchObject({ exitCode: 0, timedOut: false, truncated: false });
					output = result.output;
				} finally {
					await probe.close();
				}
				expect(JSON.parse(output)).toEqual({ listed: false, removed: false });
				expect(spawnSync("ipcs", ["-m", "-i", id!]).status).toBe(0);
			} finally {
				spawnSync("ipcrm", ["-m", id!]);
			}
		});
	},
);
