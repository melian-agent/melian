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
	type Marker,
	type MarkerKind,
	marker,
	markersIn,
	maxBodyLength,
	parseMarker,
	type RepositoryLinks,
	type ReviewBodyOptions,
	renderComment,
	renderProse,
	renderResolvedReply,
	renderReviewBody,
	verifyMarker,
} from "./publication.ts";

export const packageName = "@melian-agent/github";
