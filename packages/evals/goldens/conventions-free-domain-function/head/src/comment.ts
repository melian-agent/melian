import type { Finding } from "./finding.ts";

/** The finding as one line of a pull request comment, linking to its line in `repository`. */
export function commentLine(
	finding: Finding,
	repository: string,
): string {
	return `${finding.severity} ${finding.rule} at ${repository}/blob/main/${finding.file}#L${finding.line}`;
}
