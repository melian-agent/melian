export {
	type GitHubRepository,
	type GitHubToken,
	ghAuthToken,
	parseGitHubRemote,
	resolveGitHubToken,
	type TokenSource,
} from "./auth.ts";
export { GitHubError, type GitHubErrorCode } from "./errors.ts";
export { createGitHubProvider, GitHubProvider, type GitHubProviderOptions, statusContext } from "./provider.ts";
export {
	blobUrl,
	type CommentContext,
	type Marker,
	type MarkerDetail,
	type MarkerKind,
	marker,
	markersIn,
	maxBodyLength,
	parseMarker,
	type RepositoryLinks,
	type ReviewBodyOptions,
	ReviewComment,
	renderProse,
	renderResolvedReply,
	renderReviewBody,
	verifyMarker,
} from "./publication.ts";

export const packageName = "@melian-agent/github";

export { Ledger, LedgerStamp } from "./ledger.ts";
