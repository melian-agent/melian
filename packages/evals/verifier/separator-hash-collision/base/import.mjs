import { createHash } from "node:crypto";
export function importFindings(findings) {
  const stored = new Map();
  for (const finding of findings) {
    const id = createHash("sha256").update(JSON.stringify([finding.path, finding.ref])).digest("hex");
    stored.set(id, finding);
  }
  return [...stored.values()];
}
