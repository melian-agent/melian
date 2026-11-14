import { visibleText } from "@melian-agent/core";
import { type LiveRun, type PruneEntry, StorePrune, ToolProvisioning } from "@melian-agent/pipeline";
import type { Io } from "./commands.ts";
import { git, stateDirectory } from "./repository.ts";

// A byte count is a safe integer, below 8 PiB, so the units never run out.
export function size(bytes: number): string {
	const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
	if (bytes < 1024) return `${bytes} B`;
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

function summary(entries: readonly PruneEntry[]): string {
	const kinds = new Map<string, { count: number; bytes: number }>();
	for (const { kind, bytes } of entries) {
		const total = kinds.get(kind) ?? { count: 0, bytes: 0 };
		kinds.set(kind, { count: total.count + 1, bytes: total.bytes + bytes });
	}
	return [...kinds].map(([kind, { count, bytes }]) => `  ${kind}: ${count}, ${size(bytes)}\n`).join("");
}

function refusal(live: readonly LiveRun[]): string {
	const runs = live.map(({ pid, worktree }) => `pid ${pid} at ${visibleText(worktree)}`).join("; ");
	return `melian: a static check is running (${runs}), so prune removes nothing; run it again once the review ends\n`;
}

/** `melian store prune`: prints what the retention decision lets prune remove, and with `apply` removes it. */
export async function storePrune(io: Io, apply: boolean): Promise<number> {
	const repoRoot = await git(io.cwd, ["rev-parse", "--show-toplevel"]);
	const prune = await StorePrune.open(repoRoot, {
		root: await stateDirectory(repoRoot, io.env),
		manifest: await ToolProvisioning.manifest(),
		env: io.env,
	});
	const outcome = apply ? await prune.apply() : { removed: prune.entries, live: prune.live };
	const listed = outcome.removed;
	const freed = listed.reduce((total, entry) => total + entry.bytes, 0);
	const lines = [`State directory: ${visibleText(prune.root)}\n`];
	lines.push(
		apply
			? `Removed ${listed.length} ${listed.length === 1 ? "entry" : "entries"}, freeing ${size(freed)}.\n`
			: `Would remove ${listed.length} ${listed.length === 1 ? "entry" : "entries"}, freeing ${size(freed)}. Nothing is removed without --apply.\n`,
	);
	for (const entry of listed)
		lines.push(`  ${entry.kind}  ${size(entry.bytes)}  ${visibleText(entry.paths.join(", "))}\n`);
	lines.push(summary(listed));
	const { files, bytes } = prune.changesets;
	lines.push(`Kept ${files} changeset ${files === 1 ? "file" : "files"}, ${size(bytes)}, and scripted/.\n`);
	if (prune.kept.length > 0) lines.push(`Kept, not recognised: ${prune.kept.map(visibleText).join(", ")}\n`);
	io.stdout(lines.join(""));
	if (outcome.live.length === 0) return 0;
	io.stderr(refusal(outcome.live));
	return 1;
}
