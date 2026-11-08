// Runs a CPU-bound probe and prints the probe runner's pid and start time once it appears among this process's
// descendants, so a test can kill this process mid-probe and watch what the runner does with nothing left to end it.
import { spawnSync } from "node:child_process";
import { Probe } from "../../src/probe.ts";

const [seconds] = process.argv.slice(2) as [string];
// Spins until it has used the given CPU seconds, so a run without a CPU bound still ends on its own.
const script = `for (;;) { for (let i = 0; i < 1e6; i++); if (process.cpuUsage().user > ${Number(seconds)} * 1e6) break; }\n`;
const probe = await Probe.open(
	{ script },
	{ writer: { trusted: true, by: "reviewer" }, trustWriters: true, timeout: 5_000 },
);
const running = probe.run();
const ends = Date.now() + 60_000;
const timer = setInterval(() => {
	const table = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart=,args="], { encoding: "utf8" }).stdout;
	const rows = table
		.split("\n")
		.map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line))
		.filter((match) => match !== null)
		.map(([, pid, ppid, start, args]) => ({ pid: Number(pid), ppid: Number(ppid), start: start!, args: args! }));
	const mine = new Set([process.pid]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const row of rows)
			if (mine.has(row.ppid) && !mine.has(row.pid)) {
				mine.add(row.pid);
				grew = true;
			}
	}
	const runner = rows.find(
		(row) => mine.has(row.pid) && row.pid !== process.pid && row.args.includes("/probe/run.mjs"),
	);
	if (runner !== undefined) {
		process.stdout.write(`${JSON.stringify({ pid: runner.pid, start: runner.start })}\n`);
		clearInterval(timer);
	} else if (Date.now() > ends) clearInterval(timer);
}, 50);
await running;
await probe.close();
