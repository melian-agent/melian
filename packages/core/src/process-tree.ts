import { spawnSync } from "node:child_process";

// The signal rule of AGENTS.md holds here: a pid is signalled only when it was recorded with its start time and still
// has it, never 0, 1, a negative pid or a group. This file is in mutation-paths.ts's signal set, so no mutation runs over
// it; its guards are proved on a fake process.kill.

export type RecordedProcess = { pid: number; start: string };

export interface ProcessEntry extends RecordedProcess {
	ppid: number;
	// Present only where ps was asked for stat= and args=.
	state?: string;
	command?: string;
}

export interface ProcessControl {
	list(): ProcessEntry[];
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

// Embedded in the supervisor script as source, so it names nothing outside itself. Reads pid=,ppid=,lstart= with an
// optional stat= and then args= after it. lstart is ctime's five fields, so the state is the word after them.
export function parseProcesses(text: string): ProcessEntry[] {
	const entries: ProcessEntry[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+(?:\s+\S+){4})(?:\s+(\S+)(?:\s+(\S.*?))?)?\s*$/.exec(line);
		if (match === null) continue;
		const entry: ProcessEntry = { pid: Number(match[1]), ppid: Number(match[2]), start: match[3]!.replace(/\s+/g, " ") };
		if (match[4] !== undefined) entry.state = match[4];
		if (match[5] !== undefined) entry.command = match[5];
		entries.push(entry);
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
				// A zombie has exited and holds its pid until it is reaped, so it is neither signalled nor waited for. Only a
				// state ps reports as a zombie counts; a missing one does not.
				table.some(
					(entry) => entry.pid === record.pid && entry.start === record.start && entry.state?.startsWith("Z") !== true,
				),
		);
	};
	// The table is read again before each signal, not once for the batch: a recorded process can exit while the ones
	// before it are signalled, and its pid can pass to a process that is nobody's to end.
	const signal = (name: "SIGTERM" | "SIGKILL") => {
		for (const record of live()) if (live().includes(record)) control.kill(record.pid, name);
	};
	signal("SIGTERM");
	for (let wait = 0; wait < 20 && live().length > 0; wait++) await sleep(50);
	signal("SIGKILL");
}

/**
 * Stops `root` and every process below it, as one read of the process table shows them, by recorded pid: SIGTERM, then
 * SIGKILL. The read comes before any signal, because a child whose parent has ended is re-parented and no longer reads
 * as below `root`. This process and its ancestors are never signalled. Returns the stop's completion, or `undefined`,
 * having signalled nothing, when the table cannot be read or `root` is not a pid above 1.
 */
export function stopTree(
	root: number,
	control: ProcessControl,
	sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> | undefined {
	// Pid 1 and pid 0 are the parents of every process, so a tree rooted at either would take in the whole machine.
	if (!Number.isSafeInteger(root) || root <= 1) return undefined;
	let table: ProcessEntry[];
	try {
		table = control.list();
	} catch {
		return undefined;
	}
	const parents = new Map(table.map((entry) => [entry.pid, entry.ppid]));
	const kept: number[] = [];
	for (let pid: number | undefined = process.pid; pid !== undefined && !kept.includes(pid); pid = parents.get(pid))
		kept.push(pid);
	const recorded = new Map<number, string>();
	const queue: number[] = [];
	for (const entry of table)
		if (entry.pid === root) {
			recorded.set(entry.pid, entry.start);
			queue.push(entry.pid);
		}
	for (let next = queue.shift(); next !== undefined; next = queue.shift())
		for (const entry of table)
			if (entry.ppid === next && !recorded.has(entry.pid)) {
				recorded.set(entry.pid, entry.start);
				queue.push(entry.pid);
			}
	const records = [...recorded].map(([pid, start]) => ({ pid, start }));
	return terminateRecorded(records, control, sleep, kept);
}

export class ProcessTable implements ProcessControl {
	list(): ProcessEntry[] {
		// parseProcesses reads lstart as ctime's five fields, which only the C locale promises.
		const result = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart=,stat="], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C" },
		});
		if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`);
		return parseProcesses(result.stdout);
	}

	start(pid: number): string | undefined {
		return this.list().find((entry) => entry.pid === pid)?.start;
	}

	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
		if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`refusing to signal pid ${pid}`);
		try {
			process.kill(pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}
