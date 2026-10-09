export type Section = { path: string; text: string };
export function render(sections: Section[]): string {
	if (sections.reduce((n, s) => n + Buffer.byteLength(s.text), 0) > 1024) throw new Error("too large");
	return sections.map((s) => `### ${s.path}\n${s.text}\n`).join("");
}
