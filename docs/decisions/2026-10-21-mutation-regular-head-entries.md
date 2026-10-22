# Mutation selectors accept regular head entries only

Amends: [Builder mutant inventory](2026-10-21-builder-mutant-inventory.md), source entry selection
Amends: [Mutation reruns, as built](2026-10-16-mutation-reruns-later-changes.md), source entry selection

Problem: Git stores a symlink’s target path as its blob. The enumerator parsed that text, while Stryker followed the checked-out link and read another file.

Choice: both selectors use `Revision`’s `newKind`. Only `file` and `executable` entries qualify. A changed production path with another head kind is unmutated, with its kind in the reason. Neither selector reads or instruments its target. A skip retains the unmutated finding even when no regular file remains to mutate.

Tests exercise the script and static.mutation’s real selector. The backend fake records Stryker’s actual arguments; it does not repeat the selector’s decision.
