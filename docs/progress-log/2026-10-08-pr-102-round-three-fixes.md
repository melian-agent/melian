# Design lens round three fixes

For [pull request #102](https://github.com/melian-agent/melian/pull/102), `fix(decisions): keep example links inside Markdown fences` addresses finding `5f7061d592f718d1`. Closing fences require matching markers, sufficient length and whitespace-only suffixes. Invalid backtick opening info strings leave prose links visible, and CRLF endings work. Regression tests cover linked-section loading and heading line numbers. The design-section test file passed all twelve tests; twelve scanner mutations failed.
