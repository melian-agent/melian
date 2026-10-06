# Verifier fourth-round budget fix

[Pull request #80](https://github.com/melian-agent/melian/pull/80). Confirmed the per-candidate constants still allowed only 100,000 tokens and 20 tool calls.

Raised them to 300,000 tokens and 60 calls after GPT-6.1 Sol exhausted 20 calls on one candidate. No configuration key was added. The design, verifier decision and package guidelines record the values and reason.

Core and pipeline verification tests pass with fake models. No test pins the former shared limits; budget-exhaustion tests use their own small limits.
