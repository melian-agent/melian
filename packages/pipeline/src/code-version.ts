import { createHash } from "node:crypto";
import { moduleHashes, producerModules } from "./code-hashes.ts";

/**
 * The version of the code that decides `producer`'s result: a SHA-256 over the recorded path and hash of each module its
 * run reaches, read from the recorded table and never from source, which a built package does not ship. The gate's
 * `scripts/code-hashes.test.mjs` fails when the table disagrees with the source. Throws for a producer, or a module, the
 * table does not hold.
 */
export function codeVersion(producer: string): string {
	const modules = Object.hasOwn(producerModules, producer) ? producerModules[producer] : undefined;
	if (modules === undefined) throw new Error(`no code is recorded for the producer ${producer}`);
	const lines = modules.map((path) => {
		const hash = Object.hasOwn(moduleHashes, path) ? moduleHashes[path] : undefined;
		if (hash === undefined) throw new Error(`${producer} reaches ${path}, whose hash is not recorded`);
		return `${path} ${hash}\n`;
	});
	return createHash("sha256").update(lines.join("")).digest("hex");
}
