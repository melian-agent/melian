// Checks a changeset out, says whether it reached the branch, and holds the copy until its input closes, as a
// command does while it works. It exits on its own after a minute, so a test cut short leaves nothing running.
import { StateBranch } from "../../src/index.ts";
import { validate } from "./state.ts";

const [repoRoot, remote, directory, holder, changeset, key] = process.argv.slice(2) as string[];
const checkout = await new StateBranch({
	repoRoot: repoRoot!,
	remote: remote!,
	directory: directory!,
	holder: holder!,
	key: Buffer.from(key!, "hex"),
	validate,
}).checkout(changeset!);
process.stdout.write(`${checkout.unreached === undefined ? "reached" : "unreached"}\n`);
const deadline = setTimeout(() => process.exit(0), 60_000);
process.stdin.resume();
process.stdin.on("end", () => {
	clearTimeout(deadline);
	checkout.close();
	process.exit(0);
});
