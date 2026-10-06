# Pin the verifier version inputs

[Pull request #80](https://github.com/melian-agent/melian/pull/80), ninth Melian round.

The task replacement test changed an explicit version. Nothing tested whether
the production version changed with its instructions, schema or questions.

The production version now calls a hash function whose defaults are those
three production inputs. Tests edit one instruction, one schema constraint and
one question separately. Each must change the version. The instruction test
also ties the default computation to the version production uses.

Replacing any input with its unchanged production value fails its regression.
The version and hash format remain unchanged. No architecture decision changed.
