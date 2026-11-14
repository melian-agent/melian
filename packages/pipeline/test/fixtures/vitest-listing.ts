// npm's record of the install sits beside it, as a real install writes, so a check run under it can be reused.
export const emptyVitestInstall = {
	"node_modules/.package-lock.json": "{}",
	"node_modules/vitest/package.json": JSON.stringify({
		name: "vitest",
		version: "5.0.3",
		type: "module",
		exports: { "./node": "./node.js", "./package.json": "./package.json" },
	}),
	"node_modules/vitest/node.js": `export async function createVitest(mode, options) {
  if (mode !== "test" || options.watch !== false || options.coverage.enabled !== false) throw new Error("wrong listing request");
  return { config: {}, getRelevantTestSpecifications: async () => [], close: async () => {} };
}`,
};
