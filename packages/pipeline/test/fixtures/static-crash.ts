// Starts a static run in its own process and parks once its worktree exists; the parent test kills it with SIGKILL.
import { appendFileSync } from "node:fs";
import { defaultConfig } from "@melian-agent/core";
import { backgroundContext, createNodeExecutionEnv, type ExecutionEnv } from "../../src/harness.ts";
import { runStaticTool } from "../../src/static.ts";

const [repoRoot, commit, log] = process.argv.slice(2) as [string, string, string];
const env = createNodeExecutionEnv(repoRoot);
const parking: ExecutionEnv = Object.create(env);
parking.exec = (command, options, context) => {
	if (!command.includes("--version")) return env.exec(command, options, context);
	appendFileSync(log, "parked\n");
	// A timer keeps the process alive while it waits to be killed.
	return new Promise(() => setInterval(() => {}, 1000));
};
await runStaticTool(
	{ env: parking, repoRoot, commit, tool: "biome", settings: defaultConfig.static.biome },
	backgroundContext,
);
