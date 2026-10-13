// Re-derives by hand what semver's `satisfies` answers for the `engines.node` range in package.json.
// semver cannot be asked here: npm runs this file as `preinstall`, before it installs any dependency,
// so `node_modules` does not exist yet. The check reads only a `>=<major>` range and refuses anything else.
import { readFileSync } from "node:fs";

const { engines } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const wanted = /^>=(\d+)$/.exec(engines.node);
const running = /^v(\d+)\./.exec(process.version);
if (wanted === null || running === null || Number(running[1]) < Number(wanted[1])) {
	console.error(`notes-cli needs Node ${engines.node}, and this is ${process.version}`);
	process.exit(1);
}
