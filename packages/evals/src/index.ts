export {
	buildGoldenRepository,
	type Expected,
	expectedSchema,
	type Golden,
	type GoldenComment,
	type GoldenMode,
	type GoldenRun,
	type GoldenScore,
	goldenCommentSchema,
	goldensDirectory,
	loadGoldens,
	runGolden,
	type Script,
	scoreCorpus,
	scoreGolden,
	scriptSchema,
} from "./goldens.ts";

export const packageName = "@melian-agent/evals";
