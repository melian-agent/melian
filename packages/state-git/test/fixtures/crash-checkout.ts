// Checks a changeset out, or reserves it, and exits without closing it, as a process that crashes mid-review does.
import { StateBranch } from "../../src/index.ts";
import { validate } from "./state.ts";

const [repoRoot, remote, directory, holder, changeset, key, mode] = process.argv.slice(2) as string[];
const branch = new StateBranch({
	repoRoot: repoRoot!,
	remote: remote!,
	directory: directory!,
	holder: holder!,
	key: Buffer.from(key!, "hex"),
	validate,
});
await (mode === "reserve" ? branch.reserve(changeset!) : branch.checkout(changeset!));
process.exit(0);
