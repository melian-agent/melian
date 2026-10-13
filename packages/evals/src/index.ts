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
	selectGoldens,
} from "./goldens.ts";
export {
	loadResolutionGoldens,
	type ResolutionGolden,
	type ResolutionRun,
	type ResolutionScenario,
	resolutionDirectory,
	resolutionScenarioSchema,
	runResolutionGolden,
} from "./resolution.ts";
export {
	loadTriageGoldens,
	runTriageGolden,
	type StoredTriageResults,
	type TriageChoice,
	type TriageChosen,
	type TriageComparison,
	type TriageGolden,
	type TriageMode,
	TriageQuestions,
	TriageResults,
	triageDirectory,
} from "./triage.ts";
export {
	loadScenarioGoldens,
	loadVerifierGoldens,
	runScenarioGolden,
	runVerifierGolden,
	type ScenarioGolden,
	type ScenarioRevision,
	type ScenarioRun,
	scenarioMismatches,
	scoreVerifierGolden,
	type VerifierGolden,
	type VerifierRun,
	verifierDirectory,
} from "./verifier.ts";

export const packageName = "@melian-agent/evals";

export { EnolaCoverage } from "./enola-coverage.ts";
