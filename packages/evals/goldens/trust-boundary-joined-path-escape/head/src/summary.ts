import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type Settings = { template?: string };

async function settingsOf(checkout: string): Promise<Settings> {
	const path = join(checkout, ".summary", "settings.json");
	return existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Settings) : {};
}

export async function summarise(checkout: string): Promise<string> {
	const settings = await settingsOf(checkout);
	const template = await readFile(join(checkout, ".summary", settings.template ?? "template.md"), "utf8");
	return template.replaceAll("{{repository}}", process.env.GITHUB_REPOSITORY ?? "");
}
