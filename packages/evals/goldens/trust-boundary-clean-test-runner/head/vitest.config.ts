import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// dayOf reads the local day, so the tests pin the zone their expectations are written in.
		env: { TZ: "UTC" },
	},
});
