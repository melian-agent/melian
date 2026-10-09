# Active base decisions enter the design lens mechanically

The decisions package now parses written decisions and resolves their Supersedes graph. The design lens receives bounded paths, titles and active status from the comparison base. Omitted successors still deactivate their predecessors. The prompt rejects a conflicting new decision with no Supersedes line as criterion-selection-bias.

Tests cover chains, multiple successors, invalid graphs, base-only files and rendering bounds. The mutation inventory and gate results are recorded in tmp/design-lens-followup-report.md. Base search, remaining goldens and live measurement follow in separate commits on this branch.
