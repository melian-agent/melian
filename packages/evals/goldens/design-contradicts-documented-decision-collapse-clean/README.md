# design-contradicts-documented-decision-collapse-clean

A clean case for the open-or-collapsed rule. The base design says checks that did not run stay open and advisories are collapsed in `<details>` under a `<summary>` with a count and a noun. The head adds an open "Checks that did not run" section and collapses the advisories under "N advisories". The positive twin of this shape would collapse the checks that did not run, or leave the advisories open. A review must report nothing. The scripted run proves the plumbing only; whether a live lens stays quiet is a live measurement.
