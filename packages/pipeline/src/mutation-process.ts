import { spawnSync } from "node:child_process";
import { posix } from "node:path";
import { backgroundContext, type Context, type ExecutionEnv } from "./harness.ts";
import type { Run } from "./static.ts";

// Signal rule. Melian never signals a negative pid, 0, -1 or a process group. A mutation run ends by pid: only processes
// that a supervisor saw as descendants of the command it started, each pid kept with its start time so a reused pid is
// not mistaken for it, signalled one by one with SIGTERM and then SIGKILL. Problem: a group kill with a group of 1 is
// `kill(-1)`, which ends every process the user owns.

/** A process, named so that a reused pid cannot stand in for it. */
export type RecordedProcess = { pid: number; start: string };

/** What the mutation task keeps durably about the process tree its sandboxed command started. */
export type MutationTreeRecord = { control: string; supervisor: RecordedProcess; root: RecordedProcess };

/** Durable hooks supplied by the mutation task. */
export interface MutationProcessHooks {
	/** Records the tree before any head code starts. */
	started(tree: MutationTreeRecord): Promise<void>;
	/** Clears the record after the tree is terminated. */
	stopped(): Promise<void>;
}

/** One row of the process table. */
export interface ProcessEntry extends RecordedProcess {
	ppid: number;
}

/** What {@link terminateRecorded} needs from the host. */
export interface ProcessControl {
	list(): ProcessEntry[];
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

// Embedded in the supervisor script as source, so it names nothing outside itself.
export function parseProcesses(text: string): ProcessEntry[] {
	const entries: ProcessEntry[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
		if (match !== null)
			entries.push({ pid: Number(match[1]), ppid: Number(match[2]), start: match[3]!.replace(/\s+/g, " ") });
	}
	return entries;
}

// Embedded in the supervisor script as source, so it names nothing outside itself. SIGTERM, a wait of at most a second,
// then SIGKILL, to each recorded pid that is still the process that was recorded. A `kept` pid is never signalled.
export async function terminateRecorded(
	records: readonly RecordedProcess[],
	control: ProcessControl,
	sleep: (milliseconds: number) => Promise<void>,
	kept: readonly number[],
): Promise<void> {
	const live = () => {
		const table = control.list();
		return records.filter(
			(record) =>
				Number.isSafeInteger(record.pid) &&
				record.pid > 1 &&
				!kept.includes(record.pid) &&
				table.some((entry) => entry.pid === record.pid && entry.start === record.start),
		);
	};
	for (const record of live()) control.kill(record.pid, "SIGTERM");
	for (let wait = 0; wait < 20 && live().length > 0; wait++) await sleep(50);
	for (const record of live()) control.kill(record.pid, "SIGKILL");
}

/** What {@link supervise} needs from its process. */
export interface SupervisorHost {
	readonly pid: number;
	list(): ProcessEntry[];
	/** Starts the paused command and returns its pid. */
	spawn(): number;
	exited(callback: (code: number) => void): void;
	terminated(callback: () => void): void;
	/** Replaces a file in the control directory. */
	write(name: string, text: string): void;
	every(milliseconds: number, callback: () => void): void;
	terminate(records: readonly RecordedProcess[]): Promise<void>;
	exit(code: number): void;
}

/** What the supervisor is told when it starts. */
export interface SupervisorOptions {
	/** The Melian process; the supervisor ends its tree when this one disappears. */
	readonly controller: RecordedProcess;
	readonly interval: number;
}

// Embedded in the supervisor script as source, so it names nothing outside itself. Starts the command, records every
// descendant it sees, and ends the recorded tree when the command exits, when it is told to, or when its controller is
// gone. The control directory holds `ready.json`, `tree.json` and `done`.
export function supervise(options: SupervisorOptions, host: SupervisorHost): void {
	const known = new Map<number, string>();
	const root = host.spawn();
	let ended = false;
	let written = 0;
	const records = () => [...known].map(([pid, start]) => ({ pid, start }));
	const scan = () => {
		const table = host.list();
		const children = new Map<number, ProcessEntry[]>();
		for (const entry of table) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
		const start = table.find((entry) => entry.pid === root);
		if (start !== undefined) known.set(start.pid, start.start);
		const queue = [root];
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			for (const child of children.get(next) ?? []) {
				known.set(child.pid, child.start);
				queue.push(child.pid);
			}
		}
		if (known.size !== written) {
			written = known.size;
			host.write("tree.json", JSON.stringify(records()));
		}
		return table;
	};
	const end = async (code: number) => {
		if (ended) return;
		ended = true;
		await host.terminate(records());
		host.write("done", String(code));
		host.exit(code);
	};
	const table = scan();
	const self = table.find((entry) => entry.pid === host.pid);
	if (!known.has(root) || self === undefined) {
		void end(1);
		return;
	}
	host.write(
		"ready.json",
		JSON.stringify({
			supervisor: { pid: self.pid, start: self.start },
			root: { pid: root, start: known.get(root) },
		}),
	);
	host.exited((code) => void end(code));
	host.terminated(() => void end(1));
	host.every(options.interval, () => {
		if (ended) return;
		const current = scan();
		const alive = current.some(
			(entry) => entry.pid === options.controller.pid && entry.start === options.controller.start,
		);
		if (!alive) void end(1);
	});
}

/** The process table of this host. */
export class ProcessTable implements ProcessControl {
	list(): ProcessEntry[] {
		const result = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`);
		return parseProcesses(result.stdout);
	}

	/** The start time of `pid`, or undefined when no such process runs. */
	start(pid: number): string | undefined {
		return this.list().find((entry) => entry.pid === pid)?.start;
	}

	/** Sends one signal to one process. A pid that is gone is not an error. */
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
		if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`refusing to signal pid ${pid}`);
		try {
			process.kill(pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}

/** The supervisor script, which runs under Node as a file. `command` is the shell text it starts. */
export function supervisorSource(options: SupervisorOptions, command: string, control: string): string {
	return `
import { spawn, spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
const options = JSON.parse(${JSON.stringify(JSON.stringify(options))});
const control = ${JSON.stringify(control)};
const parseProcesses = ${parseProcesses};
const terminateRecorded = ${terminateRecorded};
const supervise = ${supervise};
const list = () => {
	const result = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8" });
	if (result.status !== 0) throw new Error("ps failed");
	return parseProcesses(result.stdout);
};
const table = {
	list,
	kill: (pid, signal) => { try { process.kill(pid, signal); } catch {} },
};
let child;
supervise(options, {
	pid: process.pid,
	list,
	spawn: () => {
		child = spawn("/bin/bash", ["-c", ${JSON.stringify(command)}], { stdio: "ignore" });
		return child.pid;
	},
	exited: (callback) => child.on("exit", (code) => callback(code ?? 1)),
	terminated: (callback) => process.on("SIGTERM", callback),
	write: (name, text) => {
		writeFileSync(control + "/" + name + ".tmp", text);
		renameSync(control + "/" + name + ".tmp", control + "/" + name);
	},
	every: (milliseconds, callback) => setInterval(callback, milliseconds),
	terminate: (records) => terminateRecorded(records, table, (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), [process.pid, options.controller.pid]),
	exit: (code) => process.exit(code),
});
`;
}

function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

function isRecorded(value: unknown): value is RecordedProcess {
	const record = value as Partial<RecordedProcess> | null;
	return typeof record?.pid === "number" && typeof record.start === "string";
}

export class MutationTree {
	readonly record: MutationTreeRecord;
	readonly processes: readonly RecordedProcess[];

	private constructor(record: MutationTreeRecord, processes: readonly RecordedProcess[]) {
		this.record = record;
		this.processes = processes;
	}

	static async read(env: ExecutionEnv, record: MutationTreeRecord, context: Context): Promise<MutationTree> {
		const text = await env.readTextFile(posix.join(record.control, "tree.json"), context);
		let seen: unknown = [];
		if (text.ok) {
			try {
				seen = JSON.parse(text.value);
			} catch {
				// A half-written file holds nothing more than the record already names.
			}
		}
		const processes = new Map<number, RecordedProcess>();
		for (const each of [record.supervisor, record.root, ...(Array.isArray(seen) ? seen.filter(isRecorded) : [])])
			processes.set(each.pid, each);
		return new MutationTree(record, [...processes.values()]);
	}

	async terminate(
		env: ExecutionEnv,
		control: ProcessControl = new ProcessTable(),
		sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
			new Promise((resolve) => setTimeout(resolve, milliseconds)),
	): Promise<void> {
		await terminateRecorded(this.processes, control, sleep, [process.pid]);
		await env.remove(this.record.control, { recursive: true, force: true }, backgroundContext);
	}
}

/** One sandbox command, run under a supervisor that ends its process tree by pid when Melian disappears. */
export class MutationProcess {
	readonly run: Run;
	constructor(run: Run) {
		this.run = run;
	}

	/** Runs only after the task has durably recorded the tree; the command stays paused until then. */
	async execute(command: string, environment: Record<string, string>): Promise<{ code: number; output: string }> {
		const { run } = this;
		const { env } = run.input;
		const created = await env.createTempDir("melian-mutation-control-", run.context);
		if (!created.ok) throw run.fail("toolFailed", `no control directory: ${created.error.message}`);
		const canonical = await env.canonicalPath(created.value, run.context);
		const control = canonical.ok ? canonical.value : created.value;
		let record: MutationTreeRecord | undefined;
		let started = false;
		try {
			const self = new ProcessTable().start(process.pid);
			if (self === undefined) throw run.fail("toolFailed", "could not read this process's start time");
			const go = quote(posix.join(control, "go"));
			const paused = `while [ ! -f ${go} ]; do /bin/ps -p "$PPID" > /dev/null || exit 1; sleep 0.1; done\nexec /bin/bash -c ${quote(command)}`;
			const script = posix.join(control, "supervisor.mjs");
			const written = await env.writeFile(
				script,
				supervisorSource({ controller: { pid: process.pid, start: self }, interval: 100 }, paused, control),
				run.context,
			);
			if (!written.ok) throw run.fail("toolFailed", written.error.message);
			const ready = quote(posix.join(control, "ready.json"));
			const launched = await run.shell(
				`${quote(process.execPath)} ${quote(script)} </dev/null > ${quote(posix.join(control, "supervisor.log"))} 2>&1 &\nsupervisor=$!\nwhile [ ! -f ${ready} ]; do /bin/ps -p "$supervisor" > /dev/null || exit 1; sleep 0.1; done`,
				undefined,
				environment,
			);
			if (launched.code !== 0) throw run.fail("toolFailed", "the mutation supervisor did not start");
			const text = await env.readTextFile(posix.join(control, "ready.json"), run.context);
			if (!text.ok) throw run.fail("toolFailed", text.error.message);
			const { supervisor, root } = JSON.parse(text.value) as { supervisor: RecordedProcess; root: RecordedProcess };
			record = { control, supervisor, root };
			await run.input.mutationProcess?.started(record);
			started = true;
			const done = quote(posix.join(control, "done"));
			return await run.shell(
				`touch ${go}\nwhile [ ! -f ${done} ]; do sleep 0.1; done\nexit "$(cat ${done})"`,
				undefined,
				environment,
			);
		} finally {
			if (record === undefined) await env.remove(control, { recursive: true, force: true }, backgroundContext);
			else await (await MutationTree.read(env, record, backgroundContext)).terminate(env);
			if (started) await run.input.mutationProcess?.stopped();
		}
	}
}
