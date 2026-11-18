import { EventEmitter } from "node:events";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { git } from "../src/git.ts";

// A git whose standard error arrives one byte at a time, as a remote that writes a byte per tick sends it. A real pipe
// coalesces bytes the reader has not yet read, so only a fake child can deliver a million chunks of one byte quickly.
class Stream extends EventEmitter {
	destroy(): void {}
	end(): void {}
}

class Child extends EventEmitter {
	stdin = new Stream();
	stdout = new Stream();
	stderr = new Stream();
	pid = undefined;
	kill(): boolean {
		return true;
	}
}

const children: Child[] = [];
vi.mock("node:child_process", () => ({
	spawn: () => {
		const child = new Child();
		children.push(child);
		return child;
	},
}));

setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
const held = () => {
	collect();
	const usage = process.memoryUsage();
	return usage.heapUsed + usage.arrayBuffers;
};

it("holds about the bytes it keeps when standard error arrives one byte at a time", async () => {
	const bytes = 1024 * 1024;
	const result = git("/", ["fetch"]);
	const child = children.at(-1)!;
	const before = held();
	for (let index = 0; index < bytes; index++) child.stderr.emit("data", Buffer.alloc(1, 0x78));
	const growth = held() - before;
	child.emit("close", 0);
	expect((await result).stderr).toBe("x".repeat(bytes));
	// One Buffer kept for each chunk holds a hundred bytes or more apiece, so a megabyte of one-byte chunks holds 100 MB.
	expect(growth).toBeLessThan(4 * bytes);
}, 60_000);

it("keeps standard error whole when its chunks cross the end of a slab", async () => {
	const chunks = ["a", "b".repeat(70_000), "cd"];
	const result = git("/", ["fetch"]);
	const child = children.at(-1)!;
	for (const chunk of chunks) child.stderr.emit("data", Buffer.from(chunk));
	child.emit("close", 0);
	expect(await result).toEqual({ code: 0, stdout: "", stdoutBytes: Buffer.alloc(0), stderr: chunks.join("") });
});
