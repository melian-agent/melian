# Guard the CLI's base standards selection

[Pull request #85](https://github.com/melian-agent/melian/pull/85), sixth fix pass, finding 1c718b24a6c9d947.

The committed-head regression from 26d34e5 fails when Standards.load receives source instead of standardsSource. It already asserts that the lens instructions contain the committed nested rule and exclude checkout edits and imports.

That regression passes when standardsSource always selects the head. A new explicit-range fixture checks out the base and gives the base, head and checkout distinct nested rules and imports. Only the base's text reaches the lens instructions. The new fixture fails under the unconditional-head mutation.
