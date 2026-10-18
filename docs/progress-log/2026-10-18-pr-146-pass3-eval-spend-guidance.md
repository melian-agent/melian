# Live-eval spend instructions

[Pull request #146](https://github.com/melian-agent/melian/pull/146), pass 3, addresses finding 4f0e9227341dcf68. The live-eval instructions now describe the tokens and USD cost printed with each score, and available spend on a no-score line. They link to Measurement cost and remove the obsolete advice to wrap a model collection.

The documentation consistency check first failed because line 63 still said live.ts printed no token counts. It passes after the edit. Logs: tmp/token-telemetry-pass3-doc-red.log and tmp/token-telemetry-pass3-doc-green.log. This prose-only fix adds no production guard or mutation.

The preceding durability fix, 5bbb9bde, ran the whole gate: 4,602 passed, four ps-dependent failures and 53 skips under the sandbox. The report lists the failures, the three ps-dependent skips and the required host rerun. The implementation plan and comparison record stay unchanged. No live model calls ran.
