# Tool quarantine window

Addressed Claude L11 for [pull request #89](https://github.com/melian-agent/melian/pull/89). Runtime and gate use the reviewer’s .npmrc. Both packing paths bundle it. A three-day release is rejected under four days and accepted under 2.5; rejection calls no downloader.
