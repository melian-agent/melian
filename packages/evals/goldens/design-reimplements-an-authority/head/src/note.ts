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
