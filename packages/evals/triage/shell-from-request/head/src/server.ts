import { execSync } from "node:child_process";
import { createServer } from "node:http";

export const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://localhost");
	const name = url.searchParams.get("name") ?? "default";
	execSync(`convert uploads/${name}.png -resize 64x64 thumbs/${name}.png`);
	response.end("ok");
});
