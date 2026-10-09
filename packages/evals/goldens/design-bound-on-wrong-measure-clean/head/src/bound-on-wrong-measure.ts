export type Section = { path: string; text: string };
export function render(sections: Section[]): string {
	const body = sections.map((s) => `### ${s.path}\n${s.text}\n`).join("");
	if (Buffer.byteLength(body) > 1024) throw new Error("too large");
	const bounded = body;
	return bounded;
}
