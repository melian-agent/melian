import { readFileSync } from "node:fs";
import { supported } from "./node-range.mjs";

const { engines } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (!supported(engines.node, process.version)) {
	console.error(`notes-cli needs Node ${engines.node}, and this is ${process.version}`);
	process.exit(1);
}
