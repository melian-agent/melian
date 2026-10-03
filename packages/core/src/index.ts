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
	type Severity,
} from "./config.ts";
export type { ChangedFile, FileKind, FileStatus, Hunk } from "./diff.ts";
export {
	ChangesetError,
	type ChangesetErrorCode,
	ConfigError,
	type ConfigErrorCode,
	OutsideRepositoryError,
	StandardsError,
	type StandardsErrorCode,
} from "./errors.ts";
export { melianPaths } from "./paths.ts";
export type { RepositorySource } from "./source.ts";
export { loadStandards, type StandardsSection, standardsLimits } from "./standards.ts";

export const packageName = "@melian-agent/core";
