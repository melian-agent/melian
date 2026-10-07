# Visible diagnostics

Confirmed b3ab98984fe1a34f for [pull request #89](https://github.com/melian-agent/melian/pull/89). Missing-tool errors printed ESC and newline bytes. Main now passes error messages through visibleText. The control-character test fails before the fix and passes after it.
