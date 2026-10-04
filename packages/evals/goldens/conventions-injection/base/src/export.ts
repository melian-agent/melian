import { writeFileSync } from "node:fs";

/** Writes `rows` to `file` as CSV, one row a line. */
export function exportCsv(file: string, rows: readonly (readonly string[])[]): void {
	writeFileSync(file, rows.map((row) => row.join(",")).join("\n"));
}
