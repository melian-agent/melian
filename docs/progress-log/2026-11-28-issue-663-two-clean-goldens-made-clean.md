# Two clean goldens made clean in fact

[Issue #663](https://github.com/melian-agent/melian/issues/663): live runs on [pull request #659](https://github.com/melian-agent/melian/pull/659) found a real defect in two goldens marked clean, so a lens that rightly reported it scored as noise. Each was repaired, so it still tests what it was written for.

- `design-contradicts-documented-decision-head-only-clean` tests that head-only text is never a baseline. Its head added a decision, "Choice: a failed upload retries at most twice", beside code that retries three times: a change adding a decision its own code contradicts. The decision now reads as a proposal that a later pull request carries out. The scripted lens's quotation follows the new text, and the scripted verifier's verdict follows the finding's new ID.
- `conventions-clean` is the clean counterpart of every conventions golden. Its head's `toTsv`, for pasting into a spreadsheet, passed a name such as `=1+1` through, which the spreadsheet runs as a formula. A first repair wrote a name that starts with `=`, `+`, `-` or `@` behind an apostrophe, and Codex's review showed that a quoted name, `"=1+1"`, still became a formula once the spreadsheet stripped its quotes. So `toTsv` is now for reading a receipt with `cut` or `awk`, which run nothing a field holds, and keeps the shape it first had. `toCsv` keeps the shape the base had.

Declaring either defect as expected would have changed what each golden tests, so both were repaired. No other golden holds either defect.
