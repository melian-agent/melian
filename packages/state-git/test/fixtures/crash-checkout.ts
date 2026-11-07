// Checks a changeset out and exits without closing it, as a process that crashes mid-review does.
import { StateBranch } from "../../src/index.ts";

const [repoRoot, remote, directory, holder, changeset] = process.argv.slice(2) as [
	string,
	string,
	string,
	string,
	string,
];
await new StateBranch({ repoRoot, remote, directory, holder }).checkout(changeset);
process.exit(0);
