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
	melianYamlSchema,
	type Resolution,
	type Severity,
} from "./config.ts";
export type { ChangedFile, FileStatus, Hunk } from "./diff.ts";
export {
	ChangesetError,
	type ChangesetErrorCode,
	ConfigError,
	type ConfigErrorCode,
	OutsideRepositoryError,
} from "./errors.ts";
export { melianPaths } from "./paths.ts";
export { loadStandards, type StandardsSection } from "./standards.ts";

export const packageName = "@melian-agent/core";
