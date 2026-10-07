# Prove CLI caller selection

[Pull request #89](https://github.com/melian-agent/melian/pull/89) now asserts the exact files passed from the CLI to caller queries. The fixture disables unselected lenses so an inverted selection filter cannot borrow their matching paths.

Both selection predicates failed the new assertion. The other three host guards and branches fail the same fixture. The restored test passes. An attachment trial that timed out across the full CLI suite failed the focused test alone; the timeout supplies no proof.
