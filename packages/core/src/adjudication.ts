import type { MelianConfig, Resolution } from "./config.ts";
import type { Finding } from "./findings.ts";

/** The resolutions from strictest to most lenient. */
export const resolutionOrder: readonly Resolution[] = ["block", "acknowledge", "advisory", "silent"];

/** The configuration that applies at a repository-relative path, usually through `loadConfig` for that path. */
export type ConfigFor = (path: string) => Pick<MelianConfig, "resolution">;

function lenientOf(left: Resolution, right: Resolution): Resolution {
	return resolutionOrder.indexOf(left) > resolutionOrder.indexOf(right) ? left : right;
}

/**
 * What a finding requires under `config`, the effective configuration at the finding's path: the resolution configured
 * for its severity. A finding not shown to be caused by the change, `pre-existing` or `affected` without evidence, is
 * never above `advisory`, so an old defect cannot block an unrelated change.
 */
export function resolveFinding(finding: Finding, config: Pick<MelianConfig, "resolution">): Resolution {
	const { severity, cause, evidence } = finding.properties;
	const configured = config.resolution[severity];
	const caused = cause === "introduced" || (cause === "affected" && evidence !== undefined);
	return caused ? configured : lenientOf(configured, "advisory");
}

/**
 * Copies of `findings` with `properties.resolution` set by {@link resolveFinding}, each under the configuration
 * `configFor` returns for its path.
 */
export function applyResolutions(findings: readonly Finding[], configFor: ConfigFor): Finding[] {
	return findings.map((finding) => {
		const resolution = resolveFinding(finding, configFor(finding.properties.path));
		return { ...finding, properties: { ...finding.properties, resolution } };
	});
}
