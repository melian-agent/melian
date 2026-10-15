import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function summarise(checkout: string): Promise<string> {
	const template = await readFile(join(checkout, ".summary", "template.md"), "utf8");
	return template.replaceAll("{{repository}}", process.env.GITHUB_REPOSITORY ?? "");
}
