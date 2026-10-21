# Stratified builder probes use deterministic mutant hashes

Amends: [Builder mutant inventory](2026-10-21-builder-mutant-inventory.md), existing-kill sampling and mutant identity

Problem: a builder can satisfy one-in-five sampling with only bound mutants and miss every optional-chain claim. A reviewer cannot reproduce an unrecorded choice.

Choice: save the complete JSON inventory, with omitted zero and total equal to its row count. Each row keeps its identity fields and adds `claim` (`killed`, `new-test` or `equivalent`), `evidence` (a named test or equivalence reason) and `survivorClasses` (checklist labels, or an empty array). The builder assigns the classes: seeded defaults and negative tests describe test scenarios, which the instrumenter does not know.

`node scripts/enumerate-mutants.mjs --sample <inventory.json>` prints the selection as JSON. It includes every new-test and equivalence claim. Those probes count towards mandatory coverage. It fills uncovered file groups, then mutator groups, then represented checklist classes, taking each group’s lowest hash. Class groups follow their first appearance in hash order. It then chooses 20% of each file’s remaining killed-by claims, rounded up, including groups smaller than five. Every selected probe runs. Rejected entries remain in the output as unmutated; they have no mutant to select.

SHA-256 hashes the JSON tuple `[file, line, column, endLine, endColumn, mutatorName, replacement]`. Hash order decides ties within every group and the printed order. End positions matter: Stryker can produce whole-condition and operand mutants with the same start, mutator and replacement. The JSON and text inventory now include both positions. Sampling refuses old rows without end coordinates. It also refuses incomplete inventories, missing evidence and unknown claim or checklist labels. The enumeration output limit never truncates sampling.

The script still runs the checkout’s own code on trusted heads only, never a fork’s head. Its selection is a builder checklist, not evidence of a kill. The host’s static.mutation remains the authority.
