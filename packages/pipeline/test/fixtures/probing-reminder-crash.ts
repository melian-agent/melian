// Runs a review of a level that probes in its own process. The prober answers no attack, so Melian reminds it once; on
// the reminder it runs a failing probe, then parks before it reports, so the parent can SIGKILL it there.
import { fauxAssistantMessage, fauxToolCall } from "../../src/testing.ts";
import { probingReview } from "./probing-scenario.ts";
import { isolatedGitEnv } from "./repo.ts";
import { record } from "./spike.ts";

const [repo, database, log] = process.argv.slice(2) as [string, string, string];
Object.assign(process.env, isolatedGitEnv);
const attack = { target: "src/user.ts", reason: "r", passing: "p", failing: "f" };
const { review } = await probingReview(repo, database, {
	first: {
		planner: [
			fauxAssistantMessage([fauxToolCall("record_plan", { attacks: [attack] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Planned 1 attack."),
		],
		prober: [
			fauxAssistantMessage("Done."),
			fauxAssistantMessage([fauxToolCall("run_probe", { attack: 1, script: "process.exit(1);\n" })], {
				stopReason: "toolUse",
			}),
			() => {
				record(log, { event: "prober-asked" });
				return new Promise(() => setInterval(() => {}, 60_000));
			},
		],
	},
	second: { planner: [], prober: [] },
});
await review();
