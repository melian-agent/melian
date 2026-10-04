import { readFileSync } from "node:fs";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
	entryPoints: ["src/index.ts"],
	bundle: true,
	format: "esm",
	platform: "node",
	outfile: "dist/index.js",
	define: { __VERSION__: JSON.stringify(version) },
});
