import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessTable, type RecordedProcess, terminateRecorded } from "../src/mutation-process.ts";

// The supervisor and the process table against real processes. The test spawns its own throwaway controller and kills
// it by the controller's own pid. It signals only pids that the supervisor recorded, and only a pid it has just checked
// is still the process recorded; the code under test never signals anything else. Never run a mutation over this file or
// over the code it exercises: the guards are proven by mutation-process.test.ts, on fakes.

const fixture = fileURLToPath(new URL("./fixtures/mutation-controller.ts", import.meta.url));
const table = new ProcessTable();
const ps = (() => {
	try {
		table.list();
		return true;
	} catch {
		return false;
	}
})();

let control: string;
let controllers: ChildProcess[];

beforeEach(() => {
	control = mkdtempSync(join(tmpdir(), "melian-real-control-"));
	controllers = [];
});

afterEach(async () => {
	// Whatever the assertions found, nothing the supervisor recorded outlives the test.
	const left: RecordedProcess[] = [];
	for (const name of ["tree.json", "ready.json"]) {
		try {
			const value = JSON.parse(readFileSync(join(control, name), "utf8")) as unknown;
			left.push(...(Array.isArray(value) ? value : [(value as { supervisor: RecordedProcess }).supervisor]));
		} catch {}
	}
	await terminateRecorded(left, table, async () => {}, [process.pid]);
	for (const controller of controllers) if (controller.pid !== undefined) controller.kill("SIGKILL");
	rmSync(control, { recursive: true, force: true });
});

async function until(condition: () => boolean, what: string, seconds = 15): Promise<void> {
	const deadline = Date.now() + seconds * 1000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function startController(command: string) {
	const controller = spawn(process.execPath, ["--conditions=@melian-agent/source", fixture, control, command], {
		stdio: "ignore",
	});
	controllers.push(controller);
	return controller;
}

const running = (records: readonly RecordedProcess[]) => {
	const current = table.list();
	return records.filter((record) => current.some((entry) => entry.pid === record.pid && entry.start === record.start));
};
const readTree = () => JSON.parse(readFileSync(join(control, "tree.json"), "utf8")) as RecordedProcess[];

describe.skipIf(!ps)("the mutation supervisor on real processes", { timeout: 60_000 }, () => {
	it("ends the recorded tree, and its own process, within seconds of its controller being killed", async () => {
		const controller = startController("sleep 300 & sleep 300 & wait");
		await until(() => existsSync(join(control, "controller.ready")), "the controller");
		await until(
			() => existsSync(join(control, "tree.json")) && running(readTree()).length >= 3,
			"three live processes",
		);
		const tree = readTree();
		const { supervisor } = JSON.parse(readFileSync(join(control, "ready.json"), "utf8")) as {
			supervisor: RecordedProcess;
		};
		expect(running([supervisor])).toHaveLength(1);
		controller.kill("SIGKILL");
		await until(() => running([supervisor, ...tree]).length === 0, "the tree to end", 10);
		expect(readFileSync(join(control, "done"), "utf8")).toBe("1");
	});

	it("reports the command's exit code and ends a process the command left behind", async () => {
		startController("sleep 300 & sleep 1; exit 3");
		await until(() => existsSync(join(control, "controller.ready")), "the controller");
		await until(() => existsSync(join(control, "done")), "the command to finish", 20);
		expect(readFileSync(join(control, "done"), "utf8")).toBe("3");
		const tree = readTree();
		expect(tree.length).toBeGreaterThanOrEqual(2);
		await until(() => running(tree).length === 0, "the leftover process to end", 10);
	});
});
