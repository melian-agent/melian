# Ask the authority

Problem: Melian sometimes re-derives by hand an answer that one of its dependencies already computes. The hand version handles the shapes its author thought of. Each review round then finds one more shape, and the fix for it is one more special case.

Example: [pull request #102](https://github.com/melian-agent/melian/pull/102) took eighteen Melian rounds. It rebuilt the lines of a paragraph by hand over the Markdown tree, to find where a declaration started. Each round met one more shape: a lone carriage return, a sentinel followed by a dot, a code span over several lines, a newline written as a character reference, a block-quote prefix. It ended when the code took decoded text and positions from the parser, which had known all five from the start.

A second example: [pull request #98](https://github.com/melian-agent/melian/pull/98), still under review, chose the tests for a mutated file from a hand parse of the Vitest configuration and a hand-built import graph. Over four rounds, review found five shapes the hand version misread: test files named as specs, `coverage.include` read as a test filter, a configuration object passed indirectly, a projects entry, and a CommonJS `require`. The maintainer ended it by deciding to ask Vitest which tests relate to a file.

Choice: ask the authority. Where a dependency already parses a format or answers a question, Melian asks it, and does not re-implement the answer by hand. The parser says what a document's text is. The test runner says which tests cover a file. The compiler says what a name resolves to. Git says what a diff holds.

An exception is fair when the authority cannot run where the answer is needed. Running it there may execute untrusted code, cost more than the step may spend, or need something the host lacks. The code then states the gap: what it re-derives, which authority would answer, and why that authority cannot be asked there. A partial hand answer fails closed. When it cannot be sure, it takes the safe wide answer, as test selection falls back to the whole suite.

The principle becomes a rule of the `design` lens, `reimplements-an-authority`, in a later step with a golden. The rule flags a change that hand-parses or re-derives what a dependency the repository already has would answer. Its goldens come from the two examples above: the line reconstruction, and the hand-built test selection. A clean twin shows a stated gap that the rule must leave alone.

Why a principle and not only a lens rule: the two pull requests cost twenty-two rounds between them, and no single round's finding named the cause. Each finding was a true defect in the hand version. Only the count showed that the hand version was the defect.

What this gives up: an authority is a dependency, with its own bugs, its own start-up cost, and its own version to pin. Asking Vitest means running it in the sandbox. Melian accepts that, because a pinned dependency's bugs are found by everyone who uses it, and Melian's hand copy's are found only by Melian.
