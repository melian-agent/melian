// Copy to the root of 2181ecea; run with --conditions=@melian-agent/source and the fixture directory.
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	backgroundContext as context,
	createRegistry,
	openHarness,
	openSqliteStorage,
} from "./packages/pipeline/src/index.ts";
import { RoundWriter } from "./packages/pipeline/src/rounds.ts";
import { createFakeModels } from "./packages/pipeline/src/testing.ts";

const directory = process.argv[2];
const { key } = JSON.parse(readFileSync(join(directory, "recorded.json"), "utf8"));
copyFileSync(join(directory, "main.sqlite"), join(directory, "rounds-v1.sqlite"));
const fake = createFakeModels();
const harness = await openHarness(await openSqliteStorage(join(directory, "rounds-v1.sqlite")), {
	models: fake.models,
	registry: createRegistry(),
});
try {
	const root = await harness.root(context);
	await root.commit((tx) => new RoundWriter(tx, root.id).preserve(key), context);
} finally {
	await harness.close(context);
}
