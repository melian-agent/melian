export type Body = { blocking: string[]; advisories: string[]; notRun: string[] };

export function renderBody(body: Body): string[] {
	const lines = body.blocking.map((finding) => `- ${finding}`);
	if (body.notRun.length > 0) lines.push("Checks that did not run:", ...body.notRun.map((check) => `- ${check}`));
	if (body.advisories.length > 0) {
		const noun = body.advisories.length === 1 ? "advisory" : "advisories";
		lines.push(`<details><summary>${body.advisories.length} ${noun}</summary>`, "");
		lines.push(...body.advisories.map((finding) => `- ${finding}`), "", "</details>");
	}
	return lines;
}
