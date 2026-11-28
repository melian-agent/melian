# design-contradicts-documented-decision-head-only-clean

The head adds a decision, and nothing else; no base decision or design governs retries. The scripted design lens cites the head's new decision as the baseline, and the scripted verifier refutes it, since text that exists only at the head is never a baseline. The review reports nothing.

The decision is worded as a proposal that a later pull request carries out. As first written it read "Choice: a failed upload retries at most twice" beside code that retries three times, so the change added a decision its own code contradicts, a real defect a live lens rightly reported; [issue #663](https://github.com/melian-agent/melian/issues/663) made it clean in fact.
