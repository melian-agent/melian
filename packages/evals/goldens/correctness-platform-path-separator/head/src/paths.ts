import { relative } from "node:path";

/** Classify absolute source paths on Windows and POSIX. */
export function isPipelineSource(root: string, file: string) {
  const path = relative(root, file);
  return path.startsWith("packages/pipeline/");
}
