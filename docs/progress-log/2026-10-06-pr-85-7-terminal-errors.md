# Render standards errors as visible text

[Pull request #85](https://github.com/melian-agent/melian/pull/85), fifth fix pass, finding d8307f058e23aa52.

A committed directory name containing BEL or ESC followed by [2J reached stderr unchanged when its standards exceeded the chain bound. Both CLI regressions failed before the fix. The final error handler now passes diagnostic text through visibleText, as decision-provider diagnostics do. The CLI retains the line break it adds itself.

The restored tests print visible Unicode escapes, exit 2, and produce no verdict. This applies the existing terminal rendering rule; no design decision changed.
