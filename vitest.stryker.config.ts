import { defineConfig, mergeConfig } from "vitest/config";
import { strykerTestNames } from "./scripts/stryker-test-names.mjs";
import base from "./vitest.config.ts";

export default mergeConfig(base, defineConfig({ plugins: [strykerTestNames()] }));
