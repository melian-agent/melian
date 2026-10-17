# design-supersedes-its-own-decision

Written for the second fix pass on [pull request #93](https://github.com/melian-agent/melian/pull/93), from the review of record, which found the lens told to read only a changed decision at base and never a decision the head supersedes. The head adds a decision whose `Supersedes:` line names the writer-trust decision and makes an omitted trust answer default to trusted, and it leaves the old file as it was. The lens must read the superseded decision at base, treat its text as the baseline, and report the new decision's departure from it.
