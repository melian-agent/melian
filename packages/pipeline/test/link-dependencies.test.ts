import { describe, expect, it } from "vitest";
import { backgroundContext as context, type ExecutionEnv } from "../src/harness.ts";
import { linkDependencies } from "../src/link-dependencies.ts";

type Entry = { readonly name: string; readonly kind: "file" | "directory" | "symlink" };

// A fake file system that answers only what linkDependencies asks: the listings and links it holds, the paths that
// exist, and the one script it writes. Anything else is an error, so a wrong question fails the test.
function fakeEnv(tree: {
	readonly listings: Readonly<Record<string, readonly Entry[]>>;
	readonly links?: Readonly<Record<string, string>>;
	readonly existing?: readonly string[];
	readonly unreadable?: readonly string[];
	readonly dangling?: readonly string[];
	readonly writeFails?: boolean;
}) {
	const written: Record<string, string> = {};
	const fail = (path: string) => ({
		ok: false as const,
		error: Object.assign(new Error(`no ${path}`), { code: "not_found" }),
	});
	const env = {
		listDir: async (path: string) => {
			const entries = tree.listings[path];
			if (entries === undefined) return fail(path);
			return {
				ok: true as const,
				value: entries.map((entry) => ({ ...entry, path: `${path}/${entry.name}`, size: 0, mtimeMs: 0 })),
			};
		},
		canonicalPath: async (path: string) => {
			if (tree.dangling?.includes(path)) return fail(path);
			const real = tree.links?.[path];
			if (real === undefined) throw new Error(`resolved ${path}, which is not a link`);
			return { ok: true as const, value: real };
		},
		exists: async (path: string) =>
			tree.unreadable?.includes(path)
				? fail(path)
				: { ok: true as const, value: tree.existing?.includes(path) ?? false },
		writeFile: async (path: string, content: string) => {
			if (tree.writeFails === true) return fail(path);
			written[path] = content;
			return { ok: true as const, value: undefined };
		},
	};
	return { env: env as unknown as ExecutionEnv, written };
}

const checkout = "/repo";
const root = "/scratch/tree";
const scratch = "/scratch";

function shell(code = 0, output = "") {
	const commands: string[] = [];
	return {
		commands,
		run: async (command: string) => {
			commands.push(command);
			return { code, output };
		},
	};
}

describe("linkDependencies", () => {
	it("links each install entry, a workspace package to the tree's own copy, and skips tool caches", async () => {
		const { env, written } = fakeEnv({
			listings: {
				"/repo/node_modules": [
					{ name: ".cache", kind: "directory" },
					{ name: ".vite", kind: "directory" },
					{ name: ".vite-temp", kind: "directory" },
					{ name: "@scope", kind: "directory" },
					{ name: "@loose", kind: "file" },
					{ name: "plain", kind: "directory" },
					{ name: "b", kind: "symlink" },
					{ name: "hoisted", kind: "symlink" },
					{ name: "away", kind: "symlink" },
					{ name: "broken", kind: "symlink" },
				],
				"/repo/node_modules/@scope": [{ name: "pkg", kind: "directory" }],
				"/repo/packages/b/node_modules": [{ name: "only-b", kind: "directory" }],
			},
			links: {
				"/repo/node_modules/b": "/repo/packages/b",
				"/repo/node_modules/hoisted": "/repo/node_modules/.pnpm/hoisted",
				"/repo/node_modules/away": "/elsewhere/away",
			},
			existing: ["/repo/packages/b/node_modules", "/scratch/tree/packages/b"],
			dangling: ["/repo/node_modules/broken"],
		});
		const sh = shell();
		const result = await linkDependencies(env, context, checkout, root, scratch, sh.run);
		expect(result).toEqual({
			linked: ["/repo/node_modules", "/repo/node_modules/@scope", "/repo/packages/b/node_modules"],
		});
		expect(sh.commands).toEqual(["sh '/scratch/link.sh'"]);
		expect(written).toEqual({
			"/scratch/link.sh": `${[
				"mkdir -p '/scratch/tree/node_modules'",
				"mkdir -p '/scratch/tree/node_modules/@scope'",
				"ln -s '/repo/node_modules/@scope/pkg' '/scratch/tree/node_modules/@scope/pkg'",
				"ln -s '/repo/node_modules/@loose' '/scratch/tree/node_modules/@loose'",
				"ln -s '/repo/node_modules/plain' '/scratch/tree/node_modules/plain'",
				"ln -s '/scratch/tree/packages/b' '/scratch/tree/node_modules/b'",
				"ln -s '/repo/node_modules/hoisted' '/scratch/tree/node_modules/hoisted'",
				"ln -s '/repo/node_modules/away' '/scratch/tree/node_modules/away'",
				"ln -s '/repo/node_modules/broken' '/scratch/tree/node_modules/broken'",
				"mkdir -p '/scratch/tree/packages/b/node_modules'",
				"ln -s '/repo/packages/b/node_modules/only-b' '/scratch/tree/packages/b/node_modules/only-b'",
			].join("\n")}\n`,
		});
	});

	it("links a workspace's own node_modules only when it and the tree's copy of the workspace both exist", async () => {
		const listings = {
			"/repo/node_modules": [{ name: "b", kind: "symlink" as const }],
			"/repo/packages/b/node_modules": [{ name: "only-b", kind: "directory" as const }],
		};
		const links = { "/repo/node_modules/b": "/repo/packages/b" };
		for (const tree of [
			{ existing: ["/repo/packages/b/node_modules"] },
			{ existing: ["/scratch/tree/packages/b"] },
			{ existing: ["/scratch/tree/packages/b"], unreadable: ["/repo/packages/b/node_modules"] },
		]) {
			const { env } = fakeEnv({ listings, links, ...tree });
			expect(await linkDependencies(env, context, checkout, root, scratch, shell().run)).toEqual({
				linked: ["/repo/node_modules"],
			});
		}
	});

	it("writes an empty script for a checkout with no install", async () => {
		const { env, written } = fakeEnv({ listings: {} });
		expect(await linkDependencies(env, context, checkout, root, scratch, shell().run)).toEqual({ linked: [] });
		expect(written).toEqual({ "/scratch/link.sh": "\n" });
	});

	it("quotes a name holding a single quote", async () => {
		const { env, written } = fakeEnv({ listings: { "/repo/node_modules": [{ name: "it's", kind: "directory" }] } });
		await linkDependencies(env, context, checkout, root, scratch, shell().run);
		expect(written["/scratch/link.sh"]).toContain(
			"ln -s '/repo/node_modules/it'\\''s' '/scratch/tree/node_modules/it'\\''s'",
		);
	});

	it("reports a script it cannot write, and a link script that fails, with the shell's output", async () => {
		const unwritable = fakeEnv({ listings: {}, writeFails: true });
		const sh = shell();
		expect(await linkDependencies(unwritable.env, context, checkout, root, scratch, sh.run)).toEqual({
			failed: "could not write /scratch/link.sh: no /scratch/link.sh",
		});
		expect(sh.commands).toEqual([]);
		const { env } = fakeEnv({ listings: {} });
		expect(await linkDependencies(env, context, checkout, root, scratch, shell(1, "ln: exists").run)).toEqual({
			failed: "linking dependencies failed: ln: exists",
		});
	});
});
