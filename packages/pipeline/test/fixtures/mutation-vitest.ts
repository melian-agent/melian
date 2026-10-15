import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createVitest } from "vitest/node";
import { MutationVitest } from "../../src/mutation-vitest.ts";

const [root, changed, output] = process.argv.slice(2) as [string, string, string];
process.chdir(root);
const selection = await MutationVitest.open(
	() => createVitest("test", { config: resolve("vitest.config.ts"), watch: false, coverage: { enabled: false } }),
	JSON.parse(changed) as string[],
);
const runs: string[][] = [];
await selection.execute(
	async (tests) => {
		const vitest = await createVitest("test", { config: resolve("vitest.config.ts"), watch: false, maxWorkers: 1 });
		try {
			await vitest.start(tests?.slice());
			runs.push(vitest.state.getFiles().map((file) => file.filepath));
			return { code: 0, report: '{"files":{}}' };
		} finally {
			await vitest.close();
		}
	},
	() => false,
);
writeFileSync(output, JSON.stringify({ runs, notes: selection.notes }));
