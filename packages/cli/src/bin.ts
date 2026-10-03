#!/usr/bin/env node
import "./warnings.ts";
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2), {
	cwd: process.cwd(),
	env: process.env,
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	color: process.stdout.isTTY === true && (process.env.NO_COLOR ?? "") === "",
});
