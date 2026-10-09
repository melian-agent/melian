import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundContext, createNodeExecutionEnv } from "../src/harness.ts";
import { MutationScratch } from "../src/mutation-scratch.ts";
import { Sandbox } from "../src/sandbox.ts";
import { Run } from "../src/static.ts";

const available =
	process.platform === "darwin" &&
	spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" })
		.status === 0;

describe.skipIf(!available || process.env.MELIAN_SANDBOX !== undefined)(
	"scratch housekeeping under real seatbelt",
	{ timeout: 60_000 },
	() => {
		let directory: string;
		let scratch: string;
		let outside: string;
		beforeEach(() => {
			directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-housekeeping-race-")));
			scratch = join(directory, "scratch");
			outside = join(directory, "outside");
			for (const root of [scratch, outside]) mkdirSync(join(root, "tree/.git"), { recursive: true });
			writeFileSync(join(outside, "tree/.git/sentinel"), "host history");
			writeFileSync(join(outside, "tree/marker"), "host data");
		});
		afterEach(() => {
			vi.restoreAllMocks();
			rmSync(directory, { recursive: true, force: true });
		});

		it.each([
			["delete", "fs.rmSync(target, { recursive: true, force: true });", "remove", "tree/.git"],
			["write", 'if (operation === "write") {', "write", "tree/marker"],
		] as const)("refuses a directory swapped after validation during %s", async (_name, seam, operation, leaf) => {
			const env = createNodeExecutionEnv(directory);
			const execute = env.exec.bind(env);
			vi.spyOn(env, "exec").mockImplementation((command, options, context) => {
				expect(command.split(seam)).toHaveLength(2);
				const swap =
					'fs.renameSync(path.join(scratch,"tree"),path.join(scratch,"saved")); fs.symlinkSync(path.join(path.dirname(scratch),"outside/tree"),path.join(scratch,"tree"),"dir");';
				const changed =
					operation === "remove" ? command.replace(seam, swap + seam) : command.replace(seam, seam + swap);
				return execute(changed, options, context);
			});
			const run = new Run(
				{
					env,
					repoRoot: directory,
					commit: "a".repeat(40),
					tool: "mutation",
					settings: { enabled: true, timeout: 60, severity: {}, maxLines: 1 },
				},
				backgroundContext,
			);
			const files = MutationScratch.open(run, scratch, Sandbox.detect()!, []);
			const target = join(scratch, leaf);
			const pending = operation === "remove" ? files.remove(target) : files.write(target, "overwritten");
			await expect(pending).rejects.toThrow(target);
			expect(readFileSync(join(outside, "tree/.git/sentinel"), "utf8")).toBe("host history");
			expect(readFileSync(join(outside, "tree/marker"), "utf8")).toBe("host data");
		});
	},
);
