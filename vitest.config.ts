import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	ssr: {
		resolve: {
			conditions: ["@melian-agent/source", ...defaultServerConditions],
		},
	},
	test: {
		include: ["packages/*/test/**/*.test.ts", "scripts/**/*.test.mjs"],
	},
});
