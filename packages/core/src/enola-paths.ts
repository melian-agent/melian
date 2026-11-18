/** Files Enola 0.4.40 reads policy from, read from the base. */
export const enolaPolicyFiles = ["enola.yaml", "mcp-arch.yaml", "enola-intent.yaml", ".enola/suppressions.yaml"];
/** Directories whose every file Enola 0.4.40 may read as policy, read from the base. A recipe replaces a shipped one. */
export const enolaPolicyDirectories = ["enola/constraints", "enola/recipes"];

const literal = (path: string) => path.replaceAll(".", "\\.");

/** Enola's configuration paths, read from the base. A committed baseline is never policy. */
export const enolaPolicyPattern = new RegExp(
	`^(?:${[...enolaPolicyFiles.map(literal), ...enolaPolicyDirectories.map((directory) => `${literal(directory)}/.+`)].join("|")})$`,
);
