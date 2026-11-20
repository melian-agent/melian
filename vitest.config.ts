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
		tags: [
			{
				name: "macos",
				description:
					"Also runs on macOS: its outcome depends on how the platform's clock, shell or signals end a real process.",
			},
		],
	},
});
