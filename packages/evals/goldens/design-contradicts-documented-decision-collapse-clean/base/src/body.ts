export type Body = { blocking: string[]; advisories: string[]; notRun: string[] };

export function renderBody(body: Body): string[] {
	return [...body.blocking.map((finding) => `- ${finding}`), ...body.advisories.map((finding) => `- ${finding}`)];
}
