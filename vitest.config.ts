import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packages = ["core", "pipeline", "github", "state-git", "decisions", "cli", "pi-extension", "evals"];

export default defineConfig({
	resolve: {
		alias: packages.map((name) => ({
			find: new RegExp(`^@melian-agent/${name}$`),
			replacement: fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
		})),
	},
	test: {
		include: ["packages/*/test/**/*.test.ts", "scripts/**/*.test.mjs"],
	},
});
