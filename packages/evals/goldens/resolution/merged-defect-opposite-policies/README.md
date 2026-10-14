# A merged defect with opposite policies, in both speaker orders, and with a speaker ruleAliases chose

A merged defect with opposite policies resolves alike in both speaker orders, and with a speaker `ruleAliases` chose. This is the decision's merged example. The root table writes `P1: block`, the cleanup entry sets `ceiling: advisory`, and the Biome entry maps `P1: acknowledge`. The cleanup report resolves `advisory` and the Biome report `acknowledge`, so each defect needs an acknowledgement. In `aliased/` a `ruleAliases` entry makes the cleanup report speak.
