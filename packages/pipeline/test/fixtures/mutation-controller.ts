// A throwaway controller for the real-process test: it starts a supervisor for a shell command, releases the command, and
// parks. The test kills this process by its own pid, and the supervisor must end the command's tree.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProcessTable, supervisorSource } from "../../src/mutation-process.ts";

const [control, command] = process.argv.slice(2) as [string, string];
const start = new ProcessTable().start(process.pid)!;
const paused = `while [ ! -f ${join(control, "go")} ]; do sleep 0.1; done\nexec /bin/bash -c '${command}'`;
const script = join(control, "supervisor.mjs");
writeFileSync(script, supervisorSource({ controller: { pid: process.pid, start }, interval: 100 }, paused, control));
spawn(process.execPath, [script], { stdio: "ignore" });
while (!existsSync(join(control, "ready.json"))) await new Promise((resolve) => setTimeout(resolve, 50));
writeFileSync(join(control, "go"), "");
writeFileSync(join(control, "controller.ready"), "");
// A timer keeps the process alive while it waits to be killed.
setInterval(() => {}, 1000);
