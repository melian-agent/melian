# design-contradicts-documented-decision-diagnostic-clean

A clean case for the named-diagnostic rule. The base design keeps caller-context notes out of the review comment, with one exception: a single line saying no changed site had callers. The head adds exactly that line, once, when no lens saw callers, and still sends every note to the ledger. The positive twin of this shape would push the notes themselves into the comment. A review must report nothing. The scripted run proves the plumbing only; whether a live lens stays quiet is a live measurement.
