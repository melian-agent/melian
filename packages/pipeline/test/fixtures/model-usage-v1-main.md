# Version-1 model usage from main

`model-usage-v1-main.json` was recorded at main `a96c5447`, before changing production code.

The recording used main's `RouteTextModel`, `FallbackDecider`, `decisionTask` and `ModelUsageDocument`, with `createFakeModels`. A complete decision answered the one `lens` question with `careful`. The recorder read the stored document's version and materialised value through Storage. It did not build the old usage shape by hand.

The reopen test writes that recorded value under the version-1 token, closes SQLite, and opens it under version 2. It preserves the counters and leaves reasoning absent.
