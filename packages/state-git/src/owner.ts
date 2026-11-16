import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ProcessControl, ProcessEntry } from "@melian-agent/core";

/** The process table a sweep reads, core's `ProcessTable` unless a test gives another. */
export type Processes = Pick<ProcessControl, "list">;

// The host's hash, a pid with no leading zero, and the UUID that keeps names apart.
const pattern = /^([0-9a-f]{16})-([1-9][0-9]{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A hash of the host's name keeps a state directory shared with another host, or a container whose processes this
// table cannot see, from reading that host's live call as gone.
function thisHost(): string {
	return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}

/** The process that made a leftover, as its name records it. */
export class Owner {
	readonly host: string;
	readonly pid: number;

	private constructor(host: string, pid: number) {
		this.host = host;
		this.pid = pid;
	}

	// This process, or `undefined` when `table` does not list it with its own parent, as a table read from another pid
	// namespace would not, so the caller names what it makes by a UUID alone.
	static current(table: readonly ProcessEntry[]): Owner | undefined {
		return Owner.lists(table) ? new Owner(thisHost(), process.pid) : undefined;
	}

	// Whether `table` lists this process with its own parent, so it can say whether this host's pids are gone.
	static lists(table: readonly ProcessEntry[]): boolean {
		return table.some((entry) => entry.pid === process.pid && entry.ppid === process.ppid);
	}

	// The owner a leftover's name records, or `undefined` when the name records none, as an earlier build's did.
	static parse(suffix: string): Owner | undefined {
		const match = pattern.exec(suffix);
		return match === null ? undefined : new Owner(match[1] as string, Number(match[2]));
	}

	// A new name for something a call makes and removes before it returns.
	name(): string {
		return `${this.host}-${this.pid}-${randomUUID()}`;
	}

	// Whether this host made it, so its process table is the one that can say whether the owner is gone.
	isHere(): boolean {
		return this.host === thisHost();
	}

	// Gone only when the table lists no process with the pid. A start time would tell a reused pid apart, but `ps`
	// prints it in the caller's time zone and locale, and on Linux moves it when the clock is stepped, so a live owner
	// could read as gone. A reused pid keeps its leftover until that process ends, which costs disk and loses nothing.
	isGone(table: readonly ProcessEntry[]): boolean {
		return !table.some((entry) => entry.pid === this.pid);
	}
}
