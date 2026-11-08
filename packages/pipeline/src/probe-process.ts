import { type ChildProcess, spawn } from "node:child_process";
import { type ProcessControl, ProcessTable, type RecordedProcess, terminateRecorded } from "./mutation-process.ts";

// The signal rule of mutation-process.ts holds here: a probe ends by recorded pid, only processes this file saw
// descending from the command it started, each kept with its start time, never 0, 1, a negative pid or a group. This file
// is in mutation-paths.ts's signal set, so no mutation runs over it; test/probe-process.test.ts proves it on fakes.

// After the deadline or the output limit stops the recorded tree, wait at most this for the streams to close on their
// own before abandoning them. A reparented grandchild that still holds a stream never lets close fire, so the run must
// not wait for it without a bound.
export const closeGraceMs = 2_000;

export type ProbeExit = {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly timedOut: boolean;
	/** Why stopping the recorded tree failed, when it did; the run still settles. */
	readonly error?: string;
};

export interface ProbeProcessOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly output: (chunk: Buffer) => void;
	readonly control?: ProcessControl;
	readonly interval?: number;
	/** The run's time limit; past it the recorded tree is stopped and, after the grace, the streams are abandoned. */
	readonly timeoutMs?: number;
	readonly graceMs?: number;
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
	readonly #grace: number;
	readonly #known = new Map<number, string>();
	readonly #exit: Promise<ProbeExit>;
	readonly #settle: (exit: ProbeExit) => void;
	readonly #closed: Promise<void>;
	readonly #timer: ReturnType<typeof setInterval>;
	readonly #deadline: ReturnType<typeof setTimeout> | undefined;
	#natural: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	#timedOut = false;
	#done = false;
	#error: string | undefined;

	private constructor(child: ChildProcess, options: ProbeProcessOptions) {
		this.#child = child;
		this.#root = child.pid;
		this.#control = options.control ?? new ProcessTable();
		this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
		this.#grace = options.graceMs ?? closeGraceMs;
		child.stdout?.on("data", options.output);
		child.stderr?.on("data", options.output);
		let settle!: (exit: ProbeExit) => void;
		this.#exit = new Promise<ProbeExit>((resolve) => {
			settle = resolve;
		});
		this.#settle = settle;
		this.#closed = new Promise<void>((resolve) => {
			// "close" fires once the process has exited and both stdio streams have ended, so no output lands after the
			// result is built; "exit" can leave buffered bytes still to come.
			child.once("close", (code, signal) => {
				this.#natural = { code, signal };
				resolve();
			});
			// A command that never started has no exit; 127 is the shell's word for it.
			child.once("error", () => {
				this.#natural = { code: 127, signal: null };
				resolve();
			});
		});
		void this.#closed.then(() => this.#finish({ ...this.#natural!, timedOut: this.#timedOut }));
		this.#timer = setInterval(() => this.#scan(), options.interval ?? 100);
		this.#scan();
		this.#deadline =
			options.timeoutMs === undefined ? undefined : setTimeout(() => void this.#bound(true), options.timeoutMs);
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

	// The output limit was hit: stop the recorded tree, and if its streams do not close within the grace, abandon them,
	// so a survivor holding a stream cannot keep the run waiting. The result is not a timeout.
	cut(): void {
		void this.#bound(false);
	}

	#finish(exit: ProbeExit): void {
		if (this.#done) return;
		this.#done = true;
		clearInterval(this.#timer);
		if (this.#deadline !== undefined) clearTimeout(this.#deadline);
		this.#settle(this.#error === undefined ? exit : { ...exit, error: this.#error });
	}

	// Stop the recorded tree, wait at most the grace for a natural close, then abandon the streams and settle. A natural
	// close during the grace settles through the #closed handler, carrying whatever #timedOut records.
	async #bound(timedOut: boolean): Promise<void> {
		if (this.#done) return;
		this.#timedOut = this.#timedOut || timedOut;
		// A process table that cannot be read fails the stop; the run still settles, with the failure recorded, rather
		// than leaving an unhandled rejection behind a fire-and-forget call. stop() has already ended the root through
		// its own handle.
		try {
			await this.stop();
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		}
		const closed = await Promise.race([this.#closed.then(() => true), this.#sleep(this.#grace).then(() => false)]);
		if (closed || this.#done) return;
		this.#child.stdout?.destroy();
		this.#child.stderr?.destroy();
		this.#finish({ code: this.#child.exitCode, signal: this.#child.signalCode, timedOut: this.#timedOut });
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
