import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ToolManifest } from "../packages/core/src/tool-manifest.ts";
import { readWindowDays } from "./check-release-age.mjs";

export async function verifyReleases({ tools, fetch: download = fetch }) {
	const failures = [];
	for (const [name, tool] of Object.entries(tools)) {
		try {
			const response = await download(
				`https://api.github.com/repos/${tool.source.repository}/releases/tags/${encodeURIComponent(tool.source.tag)}`,
				{
					signal: AbortSignal.timeout(30_000),
					headers: { "User-Agent": "melian-tool-manifest" },
				},
			);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const release = await response.json();
			if (release.draft || release.tag_name !== tool.source.tag || release.published_at !== tool.published)
				throw new Error("release tag or publication time differs from the manifest");
			for (const [platform, pin] of Object.entries(tool.platforms)) {
				const asset = release.assets?.find((asset) => asset.browser_download_url === pin.url);
				if (asset?.digest !== `sha256:${pin.sha256}`)
					throw new Error(`${platform}: asset digest differs from the manifest`);
			}
		} catch (error) {
			failures.push(`${name}: release unverified: ${error.message}`);
		}
	}
	return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const manifest = ToolManifest.parse(readFileSync("tools.yaml", "utf8"));
		const windowDays = readWindowDays(readFileSync(".npmrc", "utf8"));
		const problems = [
			...manifest.check(Date.now(), windowDays),
			...(await verifyReleases({ tools: manifest.toJSON().tools })),
		];
		for (const [name, tool] of Object.entries(manifest.toJSON().tools)) {
			if (tool.exception && (Date.now() - Date.parse(tool.published)) / 86_400_000 < windowDays)
				console.log(`tool release-age exception used: ${name}@${tool.version} (${tool.exception.reason})`);
		}
		if (problems.length) {
			console.error(problems.join("\n"));
			process.exitCode = 1;
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
