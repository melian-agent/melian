export { type CodeLocation, classifyCause } from "./cause.ts";
export {
	type Changeset,
	parseRangeSpec,
	type RangeChangeset,
	type RangeMode,
	type RangeSpec,
	type ResolveRangeOptions,
	type Revision,
	resolveRange,
} from "./changeset.ts";
export {
	type Band,
	defaultConfig,
	type LensSettings,
	type LensTier,
	type LoadedConfig,
	loadConfig,
	type MelianConfig,
	type MelianYaml,
	type ModelRoute,
	maxConfigBytes,
	melianYamlSchema,
	type Resolution,
	resolutionSchema,
	type Severity,
	severitySchema,
} from "./config.ts";
export type { ChangedFile, FileKind, FileStatus, Hunk } from "./diff.ts";
export {
	ChangesetError,
	type ChangesetErrorCode,
	ConfigError,
	type ConfigErrorCode,
	FindingError,
	type FindingErrorCode,
	OutsideRepositoryError,
	StandardsError,
	type StandardsErrorCode,
} from "./errors.ts";
export {
	type Cause,
	causeSchema,
	createFinding,
	createFindingsLog,
	type Finding,
	type FindingExplanation,
	type FindingIdInput,
	type FindingInput,
	type FindingLocation,
	type FindingProperties,
	type FindingSource,
	type FindingStatus,
	type FindingsLog,
	type FindingTrigger,
	findingExplanationSchema,
	findingId,
	findingLocationSchema,
	findingPropertiesSchema,
	findingSchema,
	findingSourceSchema,
	findingStatusSchema,
	findingsLogSchema,
	findingTriggerSchema,
	fingerprintKey,
	type LocationCause,
	levelForSeverity,
	normaliseSnippet,
	parseFinding,
	type ReportFindingInput,
	reportFindingInputSchema,
	type SarifLevel,
	type SnippetRegion,
	sarifLevelSchema,
	sarifSchemaUri,
	snippetOccurrence,
} from "./findings.ts";
export { melianPaths } from "./paths.ts";
export { renderFindingsJson, renderFindingsTerminal, type TerminalRenderOptions } from "./render.ts";
export type { RepositorySource } from "./source.ts";
export { loadStandards, type StandardsSection, standardsLimits } from "./standards.ts";

export const packageName = "@melian-agent/core";
