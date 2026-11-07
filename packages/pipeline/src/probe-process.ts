import { type ChildProcess, spawn } from "node:child_process";
import { type ProcessControl, ProcessTable, type RecordedProcess, terminateRecorded } from "./mutation-process.ts";

// The signal rule of mutation-process.ts holds here: a probe ends by recorded pid, only processes this file saw
// descending from the command it started, each kept with its start time, never 0, 1, a negative pid or a group. This file
// is in mutation-paths.ts's signal set, so no mutation runs over it; test/probe-process.test.ts proves it on fakes.

export type ProbeExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

export interface ProbeProcessOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly output: (chunk: Buffer) => void;
	readonly control?: ProcessControl;
	readonly interval?: number;
	readonly spawner?: (argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
	readonly sleep?: (milliseconds: number) => Promise<void>;
}

function spawned(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
	return spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
}

export class ProbeProcess {
	readonly #child: ChildProcess;
	readonly #root: number | undefined;
	readonly #control: ProcessControl;
	readonly #sleep: (milliseconds: number) => Promise<void>;
	readonly #known = new Map<number, string>();
	readonly #exit: Promise<ProbeExit>;
	readonly #timer: ReturnType<typeof setInterval>;

	private constructor(child: ChildProcess, options: ProbeProcessOptions) {
		this.#child = child;
		this.#root = child.pid;
		this.#control = options.control ?? new ProcessTable();
		this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
		child.stdout?.on("data", options.output);
		child.stderr?.on("data", options.output);
		this.#exit = new Promise((resolve) => {
			// "close" fires once the process has exited and both stdio streams have ended, so no output lands after the
			// result is built; "exit" can leave buffered bytes still to come.
			child.once("close", (code, signal) => resolve({ code, signal }));
			// A command that never started has no exit; 127 is the shell's word for it.
			child.once("error", () => resolve({ code: 127, signal: null }));
		});
		this.#timer = setInterval(() => this.#scan(), options.interval ?? 100);
		this.#scan();
	}

	static start(argv: readonly string[], options: ProbeProcessOptions): ProbeProcess {
		if (argv.length === 0) throw new Error("a probe needs a command");
		return new ProbeProcess((options.spawner ?? spawned)(argv, options.cwd, options.env), options);
	}

	get recorded(): readonly RecordedProcess[] {
		return [...this.#known].map(([pid, start]) => ({ pid, start }));
	}

	wait(): Promise<ProbeExit> {
		return this.#exit;
	}

	// Ends every recorded process still alive, the root first among them, and stops watching. Safe to call twice. The
	// command is also ended through its own handle, which needs no process table: on a CI runner a probe that flooded its
	// output outlived the first stop and ran on to its time limit.
	async stop(): Promise<void> {
		this.#scan();
		clearInterval(this.#timer);
		try {
			await terminateRecorded(this.recorded, this.#control, this.#sleep, [process.pid]);
		} finally {
			if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGKILL");
		}
	}

	// Records the root and every process descending from it or from a process recorded earlier. A table that cannot be read
	// records nothing new; stop() then ends what was recorded before.
	#scan(): void {
		if (this.#root === undefined) return;
		let table: ReturnType<ProcessControl["list"]>;
		try {
			table = this.#control.list();
		} catch {
			return;
		}
		const children = new Map<number, number[]>();
		for (const entry of table) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry.pid]);
		const starts = new Map(table.map((entry) => [entry.pid, entry.start]));
		const queue = [this.#root, ...this.#known.keys()].filter((pid) => starts.get(pid) !== undefined);
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			const start = starts.get(next)!;
			if (this.#known.has(next) && this.#known.get(next) !== start) continue;
			this.#known.set(next, start);
			for (const child of children.get(next) ?? []) if (!this.#known.has(child)) queue.push(child);
		}
	}
}
