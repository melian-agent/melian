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
	goldenEvidenceSchema,
	goldensDirectory,
	loadGoldens,
	runGolden,
	type Script,
	scoreCorpus,
	scoreGolden,
	scriptedMismatches,
	scriptSchema,
} from "./goldens.ts";

export const packageName = "@melian-agent/evals";
