import { posix } from "node:path";
import type { Context, ExecutionEnv } from "./harness.ts";

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// Directories a tool writes into `node_modules` while it runs. Linked, the head's tests would write into the reviewer's
// checkout through the link; left out, the tool makes its own in the worktree.
const cacheDirectories: ReadonlySet<string> = new Set([".cache", ".vite", ".vite-temp"]);

// Links the checkout's installed dependencies into the worktree entry by entry. Problem: one link to the checkout's
// node_modules made its workspace links, such as `node_modules/b -> ../packages/b`, resolve to the checkout's own
// sources, so base and head type-checked against one tree. Solution: an entry that resolves inside the checkout, outside
// any node_modules, is a workspace package, linked to the worktree's own copy; every other entry links to the install.
// `shell` runs the link script, so each caller keeps its own timeout and errors. Returns the install directories it
// linked from, or why it failed.
export async function linkDependencies(
	env: ExecutionEnv,
	context: Context,
	checkout: string,
	root: string,
	scratch: string,
	shell: (command: string) => Promise<{ readonly code: number; readonly output: string }>,
): Promise<{ readonly linked: readonly string[] } | { readonly failed: string }> {
	const commands: string[] = [];
	const workspaces = new Set<string>();
	const linked: string[] = [];
	const link = async (from: string, to: string): Promise<void> => {
		const listed = await env.listDir(from, context);
		if (!listed.ok) return;
		linked.push(from);
		commands.push(`mkdir -p ${quote(to)}`);
		for (const entry of listed.value) {
			if (cacheDirectories.has(entry.name)) continue;
			const source = posix.join(from, entry.name);
			const target = posix.join(to, entry.name);
			if (entry.kind === "directory" && entry.name.startsWith("@")) {
				await link(source, target);
				continue;
			}
			const real = entry.kind === "symlink" ? await env.canonicalPath(source, context) : undefined;
			const inside =
				real?.ok === true && real.value.startsWith(`${checkout}/`) ? real.value.slice(checkout.length + 1) : "";
			if (inside !== "" && !inside.split("/").includes("node_modules")) {
				workspaces.add(inside);
				commands.push(`ln -s ${quote(posix.join(root, inside))} ${quote(target)}`);
			} else {
				commands.push(`ln -s ${quote(source)} ${quote(target)}`);
			}
		}
	};
	const exists = async (path: string): Promise<boolean> => {
		const result = await env.exists(path, context);
		return result.ok && result.value;
	};
	await link(posix.join(checkout, "node_modules"), posix.join(root, "node_modules"));
	// A workspace package's own node_modules holds the versions only it depends on.
	for (const workspace of workspaces) {
		const nested = posix.join(checkout, workspace, "node_modules");
		if ((await exists(nested)) && (await exists(posix.join(root, workspace)))) {
			await link(nested, posix.join(root, workspace, "node_modules"));
		}
	}
	const script = posix.join(scratch, "link.sh");
	const written = await env.writeFile(script, `${commands.join("\n")}\n`, context);
	if (!written.ok) return { failed: `could not write ${script}: ${written.error.message}` };
	const result = await shell(`sh ${quote(script)}`);
	if (result.code !== 0) return { failed: `linking dependencies failed: ${result.output}` };
	return { linked };
}
