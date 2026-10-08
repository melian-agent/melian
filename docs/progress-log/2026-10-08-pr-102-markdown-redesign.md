# Markdown grammar redesign

[Pull request #102](https://github.com/melian-agent/melian/pull/102) now reads written decisions and design sections through one mdast adapter. It preserves the active-base graph, complete heading index, public API and lens prompt section. Front matter and HTML nodes supply no prose. Supersession and discovery share the complete Markdown filename domain.

The dependency commit is 9a17057f, build(decisions): pin the Markdown grammar toolkit. The redesign replaces the repeated grammar fixes with unified definition, text, front matter, visitor and slug helpers. The decision records their cost and GitHub’s slug rule.

The concern tables retain the earlier regression cases and pair positive and negative inputs. They cover destinations, fragments, reference styles, headings, fences and inline code, front matter, filenames, revision reads and byte bounds. Mutation results and the full gate’s verbatim summary are recorded in tmp/fix102-redesign-report.md. The full gate passed on its first run: 111 test files, 3,300 passed tests and 50 skipped tests. No formatting fix or timeout retry was needed. The documented workspace command passed all 324 package tests, including the repository-root read that failed when it used process.cwd(). Type checking passed after the final identifier spelling fix. All 110 retained mutation obligations fail a named test. The report retains every exploratory attempt and its corrected probe. The implementation commit is recorded below after it is created.

No implementation-plan status changed in this fix pass. The comparison record stays on its own branch. No real provider was called.
