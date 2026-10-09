import { readFileSync } from "node:fs";
import { defineConfig, mergeConfig } from "vitest/config";
import { strykerTestNames } from "./scripts/stryker-test-names.mjs";
import base from "./vitest.config.ts";

const includeFile = process.env.MELIAN_MUTATION_TEST_INCLUDE;
const include = includeFile === undefined ? undefined : JSON.parse(readFileSync(includeFile, "utf8")) as string[];

const config = mergeConfig(base, defineConfig({ plugins: [strykerTestNames()] }));
// mergeConfig concatenates arrays; the selected dry run must replace the base include globs.
if (include !== undefined) config.test = { ...config.test, include };
export default config;
