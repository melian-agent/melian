import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ToolManifest } from "@melian-agent/core";

export function toolArchive(entries: { name: string; text: string; kind?: string }[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const body = Buffer.from(entry.text);
		const header = Buffer.alloc(512);
		const field = (text: string, start: number) => header.write(text, start, "utf8");
		field(entry.name, 0);
		field("0000755\0", 100);
		field("0000000\0", 108);
		field("0000000\0", 116);
		field(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
		field("00000000000\0", 136);
		field("        ", 148);
		field(entry.kind ?? "0", 156);
		field("ustar\0", 257);
		field("00", 263);
		const sum = header.reduce((total, byte) => total + byte, 0);
		field(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

export function testTool(bytes: Buffer, binary: string | undefined = "enola") {
	return ToolManifest.parse(
		JSON.stringify({
			format_version: 1,
			tools: {
				enola: {
					version: "0.0.1",
					source: { repository: "test/enola", tag: "v0.0.1" },
					published: "2020-01-01T00:00:00Z",
					platforms: {
						"darwin-arm64": {
							url: "https://github.com/test/enola/releases/download/v0.0.1/enola.tar.gz",
							sha256: createHash("sha256").update(bytes).digest("hex"),
							...(binary === undefined ? {} : { binary }),
						},
					},
				},
			},
			misses: [],
		}),
	).tool("enola");
}
