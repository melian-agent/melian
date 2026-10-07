# Fetched paths render visibly

For [pull request #89](https://github.com/melian-agent/melian/pull/89), confirmed c616cb61457127e5.
The successful fetch path bypassed visibleText. An ESC and BEL in MELIAN_STATE_DIR reached stdout.
The command now renders the path through visibleText. A local archive regression failed before the fix and passes after it.
All eight tool-command tests pass. No download contacted a release host.
