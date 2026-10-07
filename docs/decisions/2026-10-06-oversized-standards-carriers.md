# Omit oversized nested standards from their chains

Date: 2026-10-06
Supersedes: 2026-10-06-rendered-standards-cap.md (individual-file failure rule only)

A 300 KiB vendor/x/AGENTS.md stopped every review touching that directory before lenses selected their files. Even a lens covering another package or opting out of standards could not run.

Standards.load now records oversized nested carriers and imports as omissions on each chain that reaches them. The lens runs with the remaining sections. Its check record names the omitted file and the 256 KiB limit, records ended, and leaves the verdict not reviewed.

An oversized root carrier remains an error when a lens requests its chain. Loading stores that error until forFiles, so an opted-out lens or an empty selection can still run. The legacy one-path loader and the single-chain total bound remain strict. Other read failures still throw.

The rendered cap's accounting, section ceiling, omission priority and incomplete coverage rule remain in force.
