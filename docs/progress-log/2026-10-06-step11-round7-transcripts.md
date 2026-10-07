# Step 11: correlate reused transcript call IDs

Confirmed finding 5d0d64ceafcea2e0 from [pull request #89](https://github.com/melian-agent/melian/pull/89). A global call map let another round’s reused provider ID change which file or tool received an earlier result.

ReviewTranscript now sorts durable entries by ID and updates calls while reading in chronological order. Results belong to the most recent preceding call. Regressions cover reads of two files and revisions, a later search, newest-first history across pages, and a result before its call. Pi Durable’s scan returns newest-first entries; sorting is required before correlating them.
