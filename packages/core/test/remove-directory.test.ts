import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { removeDirectory, temporaryDirectory } from "./fixtures/repo.ts";

// Recreates ten files in the directory as fast as it can for 300 ms and then exits, as a detached git maintenance run
// writes into a repository after the command that started it has returned.
const writer = `
const { writeFileSync } = require("node:fs");
const directory = process.argv[1];
const end = Date.now() + 300;
for (let i = 0; Date.now() < end; i++) {
	try { writeFileSync(directory + "/file-" + (i % 10), ""); } catch {}
}
`;

it("removes a directory that another process is still writing into", async () => {
	const root = temporaryDirectory();
	const directory = join(root, "written");
	mkdirSync(directory);
	const child = spawn(process.execPath, ["-e", writer, directory], { stdio: "ignore" });
	const exited = new Promise((resolve) => child.once("exit", resolve));
	try {
		while (!existsSync(join(directory, "file-0"))) await new Promise((resolve) => setTimeout(resolve, 1));
		removeDirectory(root);
		expect(existsSync(root)).toBe(false);
	} finally {
		if (child.pid !== undefined && child.exitCode === null) process.kill(child.pid);
		await exited;
		removeDirectory(root);
	}
});
