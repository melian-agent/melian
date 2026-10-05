# Verifier third-round fixes

[Pull request #80](https://github.com/melian-agent/melian/pull/80).

Verifier read-tool errors now use the same findings boundary and visible text as report errors. A fake-model regression reads an absent instruction-like path containing a newline. Before the fix, the model received the instruction as a raw diagnostic line. The shared read-tool error handler now quotes it.
