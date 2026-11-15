import { spawnSync } from "node:child_process";

// The signal rule of AGENTS.md holds here: a pid is signalled only when it was recorded with its start time and still
// has it, never 0, 1, a negative pid or a group. This file is in mutation-paths.ts's signal set, so no mutation runs over
// it; its guards are proved on a fake process.kill.

export type RecordedProcess = { pid: number; start: string };

export interface ProcessEntry extends RecordedProcess {
	ppid: number;
}

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
	// The table is read again before each signal, not once for the batch: a recorded process can exit while the ones
	// before it are signalled, and its pid can pass to a process that is nobody's to end.
	const signal = (name: "SIGTERM" | "SIGKILL") => {
		for (const record of live()) if (live().includes(record)) control.kill(record.pid, name);
	};
	signal("SIGTERM");
	for (let wait = 0; wait < 20 && live().length > 0; wait++) await sleep(50);
	signal("SIGKILL");
}

export class ProcessTable implements ProcessControl {
	list(): ProcessEntry[] {
		const result = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8" });
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
