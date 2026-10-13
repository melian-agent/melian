import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundContext, createNodeExecutionEnv, type ExecutionEnv } from "../src/harness.ts";
import { MutationScratch } from "../src/mutation-scratch.ts";
import { Run } from "../src/static.ts";
import { hostSandbox } from "./fixtures/sandbox.ts";

// Housekeeping inside the host's real sandbox, seatbelt or bubblewrap. Inside another sandbox there is none to start.
describe.skipIf(hostSandbox === undefined)("scratch housekeeping under the host's sandbox", { timeout: 60_000 }, () => {
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

	function files(env: ExecutionEnv = createNodeExecutionEnv(directory)): MutationScratch {
		const run = new Run(
			{
				env,
				repoRoot: directory,
				commit: "a".repeat(40),
				tool: "biome",
				settings: { ...defaultConfig.static.biome, timeout: 60 },
			},
			backgroundContext,
		);
		return MutationScratch.open(run, scratch, hostSandbox, []);
	}

	// The control for every refusal below: with nothing swapped, the same sandbox starts and each operation works.
	it("writes, reads, and removes a file, so a refusal elsewhere is not a sandbox that never started", async () => {
		const operations = files();
		const target = join(scratch, "tree/control");
		await operations.write(target, "written inside");
		expect(readFileSync(target, "utf8")).toBe("written inside");
		expect(await operations.read(target, 64)).toBe("written inside");
		await operations.remove(target);
		expect(existsSync(target)).toBe(false);
		expect(await operations.read(target, 64)).toBeUndefined();
		await operations.close();
		expect(existsSync(scratch)).toBe(false);
	});

	// Under bubblewrap the directory beside scratch is not in the namespace at all, so there the swap leads nowhere and
	// the operation may succeed on nothing; under seatbelt the script's own open or the profile must refuse it.
	it.each([
		["delete", "fs.rmSync(target, { recursive: true, force: true });", "remove", "tree/.git", "EPERM"],
		["write", 'if (operation === "write") {', "write", "tree/marker", "ELOOP"],
	] as const)("refuses a directory swapped after validation during %s", async (_name, seam, operation, leaf, code) => {
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
		const operations = files(env);
		const target = join(scratch, leaf);
		const failure = await (operation === "remove"
			? operations.remove(target)
			: operations.write(target, "overwritten")
		).then(
			() => undefined,
			(error: Error) => error.message,
		);
		// The swap ran: the script got past its checks, moved the tree aside, and put the link in its place.
		expect(existsSync(join(scratch, "saved"))).toBe(true);
		expect(lstatSync(join(scratch, "tree")).isSymbolicLink()).toBe(true);
		if (hostSandbox?.backend === "seatbelt") {
			// The refusal is the script's own report of a denied call, not a sandbox that failed to start.
			expect(failure).toContain(
				`scratch operation refused ${target}: {"error":"refused ${target}: ${code}","code":"${code}"}`,
			);
		}
		expect(readFileSync(join(outside, "tree/.git/sentinel"), "utf8")).toBe("host history");
		expect(readFileSync(join(outside, "tree/marker"), "utf8")).toBe("host data");
	});
});
