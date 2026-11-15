// Runs a review of a level that probes in its own process. The planner answers without a plan, so Melian reminds it once;
// on the reminder it records a plan of one attack, or none with "empty", then parks before it answers, so the parent can
// SIGKILL it there.
import { fauxAssistantMessage, fauxToolCall } from "../../src/testing.ts";
import { probingReview } from "./probing-scenario.ts";
import { isolatedGitEnv } from "./repo.ts";
import { record } from "./spike.ts";

const [repo, database, log, plan] = process.argv.slice(2) as [string, string, string, string | undefined];
Object.assign(process.env, isolatedGitEnv);
const attack = { target: "src/user.ts", reason: "r", passing: "p", failing: "f" };
const { review } = await probingReview(repo, database, {
	first: {
		planner: [
			fauxAssistantMessage("Done."),
			fauxAssistantMessage([fauxToolCall("record_plan", { attacks: plan === "empty" ? [] : [attack] })], {
				stopReason: "toolUse",
			}),
			() => {
				record(log, { event: "planner-reminded" });
				return new Promise(() => setInterval(() => {}, 60_000));
			},
		],
		prober: [],
	},
	second: { planner: [], prober: [] },
});
await review();
