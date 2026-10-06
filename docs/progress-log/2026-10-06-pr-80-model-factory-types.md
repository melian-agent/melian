# Merged model factory types

[Pull request #80](https://github.com/melian-agent/melian/pull/80) keeps Pi's MutableModels return type in the real and fake factories after merging bearer credentials. The verifier's shared fake collection needs provider registration; widening to Models hid it and broke type checking and factory mocks.
