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
export type { ChangedFile, FileStatus, Hunk } from "./diff.ts";
export { ChangesetError, type ChangesetErrorCode } from "./errors.ts";

export const packageName = "@melian-agent/core";
