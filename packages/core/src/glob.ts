// Glob matching for lens `paths`: `**` crosses directories, `*` and `?` stay within one segment, and dotfiles match
// like any other name. Node's `path.matchesGlob` skips dotfiles under `**`, so `**` would miss `.github/`.
function globPattern(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i]!;
		if (char === "*" && glob[i + 1] === "*") {
			const slash = glob[i + 2] === "/";
			source += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	// `s`: a file name may hold a newline, and a pattern that skipped it would hide the file from every lens.
	return new RegExp(`^${source}$`, "s");
}

// Whether `path` is selected by `patterns`: it matches a pattern, and no `!`-prefixed pattern excludes it.
export function selectedBy(patterns: readonly string[], path: string): boolean {
	const included = patterns.filter((pattern) => !pattern.startsWith("!"));
	const excluded = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const matches = (pattern: string) => globPattern(pattern).test(path);
	return included.some(matches) && !excluded.some(matches);
}
