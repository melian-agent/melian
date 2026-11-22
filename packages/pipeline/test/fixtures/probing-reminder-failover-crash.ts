// Runs a review of a level that probes in its own process. The planner fails over from `first` to `second` and plans one
// attack; the prober answers on `first` without answering it, its reminder fails over to `second`, and parks there so
// the parent can SIGKILL it.
import { fauxAssistantMessage, fauxToolCall } from "../../src/testing.ts";
import { probingReview } from "./probing-scenario.ts";
import { isolatedGitEnv } from "./repo.ts";
import { record } from "./spike.ts";

const [repo, database, log] = process.argv.slice(2) as [string, string, string];
Object.assign(process.env, isolatedGitEnv);
const limited = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage_limit_reached" });
const attack = { target: "src/user.ts", reason: "r", passing: "p", failing: "f" };
const { review } = await probingReview(repo, database, {
	first: { planner: [limited], prober: [fauxAssistantMessage("Done."), limited] },
	second: {
		planner: [
			fauxAssistantMessage([fauxToolCall("record_plan", { attacks: [attack] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Planned 1 attack."),
		],
		prober: [
			() => {
				record(log, { event: "prober-reminded" });
				return new Promise(() => setInterval(() => {}, 60_000));
			},
		],
	},
});
await review();
