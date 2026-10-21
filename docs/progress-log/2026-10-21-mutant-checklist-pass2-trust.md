# Builder inventory trust claim corrected

[Pull request #165](https://github.com/melian-agent/melian/pull/165), pass 2, Codex finding 1.

The enumerator runs the checkout’s own code. Help, the builder procedure and the design now require trusted heads only, never a fork’s head. This has the same trust as running the builder’s branch tests. A pinned implementation for review use is deferred.

The help assertion failed against the old claim before the change and passed afterwards. The fixture still proves that enumeration does not import the source being enumerated or load its Babel configuration. It makes no claim that Melian’s implementation is isolated. The pass report records both runs.
