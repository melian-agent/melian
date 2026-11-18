# Issue 561: a resume refuses a miss that changed

Codex's adversarial review of [pull request #582](https://github.com/melian-agent/melian/pull/582) at 727d58bc found that a parity run resumed by miss name alone. A misses file edited between runs, to another head or other lines under the same name, would keep the old reviews and score them as the new miss. A changed `MELIAN_EVAL_VERIFIER_MODEL` would mix two verifiers in one run.

The results file now records each miss as first reviewed, by repository, resolved base and head, file, rules and lines, and the verifier's model. A resume refuses a miss it reviewed that now names anything else, and refuses another verifier. A miss with no review yet may change. A resume narrowed by `MELIAN_EVAL_PARITY_MISSES` keeps what the others named.

A test in `packages/evals/test/parity.test.ts` moves a reviewed miss's lines and resumes; before the fix the run went on with status 1, and after it refuses with status 2 and calls no review. Mutants that drop the reviewed-miss condition, the verifier check, or the earlier records on a narrowed resume each fail it.
