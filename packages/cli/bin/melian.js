#!/usr/bin/env node
// Committed and executable so npm links `melian` before any build. A checkout runs the source, with workspace packages
// resolved to theirs through the `@melian-agent/source` condition; the published tarball has no src/ and runs dist/.
// Synchronous hooks, not module.register: those load on a worker thread, and Node 22's SQLite warning then prints
// before src/warnings.ts can drop it. The imports are dynamic because the hook must register before the graph loads,
// and a static import would load it first.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

const source = new URL("../src/bin.ts", import.meta.url);
if (existsSync(source)) {
	registerHooks({
		resolve: (specifier, context, next) =>
			next(specifier, { ...context, conditions: [...context.conditions, "@melian-agent/source"] }),
	});
	await import(source.href);
} else {
	await import("../dist/bin.js");
}
