import { dirname, join } from "node:path";
import { configFiles } from "./config-files.ts";

// melian-config <root> <file>: prints the configuration files that apply to <file>, nearest first.
const [root = ".", file = "."] = process.argv.slice(2);
for (const found of configFiles(root, dirname(join(root, file)))) console.log(found);
