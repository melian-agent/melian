// Builds every workspace package and packs each into the directory given, with lifecycle scripts off, so a release
// tarball depends neither on prepack running nor on the user's ignore-scripts setting. Usage: npm run pack -- <dir>
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const [destination] = process.argv.slice(2);
if (destination === undefined) {
	console.error("Usage: npm run pack -- <directory>");
	process.exit(64);
}
const directory = resolve(process.env.INIT_CWD ?? process.cwd(), destination);
mkdirSync(directory, { recursive: true });
const npm = (...args) => execFileSync("npm", args, { stdio: "inherit" });
npm("run", "build");
copyFileSync(new URL("../tools.yaml", import.meta.url), new URL("../packages/pipeline/tools.yaml", import.meta.url));
npm("pack", "--workspaces", "--ignore-scripts", "--pack-destination", directory);
