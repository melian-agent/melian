// Checks a changeset out and exits without closing it, as a process that crashes mid-review does.
import { StateBranch } from "../../src/index.ts";
import { validate } from "./state.ts";

const [repoRoot, remote, directory, holder, changeset, key] = process.argv.slice(2) as string[];
await new StateBranch({
	repoRoot: repoRoot!,
	remote: remote!,
	directory: directory!,
	holder: holder!,
	key: Buffer.from(key!, "hex"),
	validate,
}).checkout(changeset!);
process.exit(0);
