import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// Its own file, since a module that imports the script would fail to load before any test could say why.
it("runs nothing when another module imports the script", { timeout: 60_000 }, () => {
	const script = pathToFileURL(new URL("./code-hashes.mjs", import.meta.url).pathname).href;
	const imported = spawnSync(
		process.execPath,
		["--input-type=module", "-e", `await import(${JSON.stringify(script)});`],
		{
			encoding: "utf8",
		},
	);
	expect(imported).toMatchObject({ status: 0, stdout: "" });
});
