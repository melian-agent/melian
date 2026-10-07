# Step 11: call coverage

Defined compiler ground truth, explicit fact matching, and impact matching. Added a reusable compiler reader and a measurement script under evals. Tiny fixtures prove package aliases, re-exports, repeated-call deduplication, test callers, unresolved dynamic calls, multiline function bindings, and exit-2 refusal. The spike measures the branch point ad303b56fac7e40b13a1a7e51140fa05a9a4b570. Search remains unrestricted.

Fix pass: impact-only import coverage excludes facts-only edges. A compiler-resolved package import and re-export prove positive fact and impact matches, per-file ratios, and rejection of wrong targets or declaration lines. No-answer queries cannot claim impact coverage.
