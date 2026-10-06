# Thread importer mutation inventory

For [pull request #68](https://github.com/melian-agent/melian/pull/68), inverted the thread importer's guards and moved its bounds. Existing tests failed every executable mutation except removal of the details-depth clamp. A new case puts an unmatched closing tag before collapsed evidence. It asserts the visible headline and fails without the clamp. All 60 thread tests pass after restoration. No design decision changed.
