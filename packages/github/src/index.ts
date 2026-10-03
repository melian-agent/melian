export {
	type GitHubRepository,
	type GitHubToken,
	ghAuthToken,
	parseGitHubRemote,
	resolveGitHubToken,
	type TokenSource,
} from "./auth.ts";
export { GitHubError, type GitHubErrorCode } from "./errors.ts";
export { createGitHubProvider, type GitHubProviderOptions, statusContext } from "./provider.ts";
export {
	blobUrl,
	type Marker,
	marker,
	markersIn,
	parseMarker,
	type RepositoryLinks,
	renderComment,
	renderResolvedReply,
	renderReviewBody,
} from "./publication.ts";

export const packageName = "@melian-agent/github";
