export { createReviewModels, piAuthPath, piCredentialStore } from "./credentials.ts";
export {
	PiCredentialsError,
	type PiCredentialsErrorCode,
	ReviewError,
	type ReviewErrorCode,
} from "./errors.ts";
export {
	type Dismissal,
	dismissFinding,
	type ReadFindingsOptions,
	readFindings,
	recordRevision,
	upsertFinding,
} from "./findings.ts";
export * from "./harness.ts";
export type { ReviewModels } from "./models.ts";
export {
	createReviewRegistry,
	lensExtension,
	openReviewHarness,
	type ReviewOptions,
	renderChangePrompt,
	reviewChangeset,
} from "./review.ts";
export {
	injectionAttemptRule,
	quoteUntrusted,
	reviewNonce,
	type UntrustedLabel,
} from "./untrusted.ts";

export const packageName = "@melian-agent/pipeline";
