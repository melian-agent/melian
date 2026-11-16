import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ProcessControl, ProcessEntry } from "@melian-agent/core";

/** The process table a sweep reads, core's `ProcessTable` unless a test gives another. */
export type Processes = Pick<ProcessControl, "list">;

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// The host's hash, a pid with no leading zero, the start time as lower-case hex, and the UUID that keeps names apart.
const pattern = new RegExp(`^([0-9a-f]{16})-([1-9][0-9]{0,9})-((?:[0-9a-f]{2})+)-${uuid}$`);

// A pid alone can pass to another process, so the start time `ps` gives is kept with it, as core's signal rule keeps
// it. A hash of the host's name keeps a state directory shared with another host, or a container whose processes this
// table cannot see, from reading that host's live call as gone.
function thisHost(): string {
	return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}

/** The process that made a leftover, as its name records it. */
export class Owner {
	readonly host: string;
	readonly pid: number;
	readonly start: string;

	private constructor(host: string, pid: number, start: string) {
		this.host = host;
		this.pid = pid;
		this.start = start;
	}

	// This process, as `table` lists it, or `undefined` when it does not, so the caller names what it makes by a UUID.
	static current(table: readonly ProcessEntry[]): Owner | undefined {
		const entry = table.find((candidate) => candidate.pid === process.pid);
		return entry === undefined ? undefined : new Owner(thisHost(), entry.pid, entry.start);
	}

	// The owner a leftover's name records, or `undefined` when the name records none, as an earlier build's did.
	static parse(suffix: string): Owner | undefined {
		const match = pattern.exec(suffix);
		if (match === null) return undefined;
		const start = Buffer.from(match[3] as string, "hex").toString("utf8");
		// Bytes that are not UTF-8 decode to a replacement character and name no start time `ps` could give.
		if (Buffer.from(start, "utf8").toString("hex") !== match[3]) return undefined;
		return new Owner(match[1] as string, Number(match[2]), start);
	}

	// A new name for something a call makes and removes before it returns.
	name(): string {
		return `${this.host}-${this.pid}-${Buffer.from(this.start, "utf8").toString("hex")}-${randomUUID()}`;
	}

	// Whether this host made it, so its process table is the one that can say whether the owner is gone.
	isHere(): boolean {
		return this.host === thisHost();
	}

	// Gone only when the table lists no process with the pid, or lists it with another start time. A pid reused within
	// the second `ps` gives reads as the owner, so the leftover is kept, which costs disk and loses nothing.
	isGone(table: readonly ProcessEntry[]): boolean {
		return !table.some((entry) => entry.pid === this.pid && entry.start === this.start);
	}
}
