import typescript from "typescript/package.json" with { type: "json" };

export const coverageCompiler = `typescript@${typescript.version}/unstable/sync`;
export const coverageMatcher = "enola-coverage@5/graph-coverage@1";
