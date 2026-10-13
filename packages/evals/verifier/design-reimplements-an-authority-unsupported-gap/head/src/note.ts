// Re-derives by hand what yaml's `parse` answers for a note's header.
// yaml cannot be asked here: this module runs before the dependencies are installed.
export type Header = Record<string, string>;

export function readHeader(note: string): Header {
	const [, block = ""] = note.split("---\n");
	const header: Header = {};
	for (const line of block.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		header[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	return header;
}
