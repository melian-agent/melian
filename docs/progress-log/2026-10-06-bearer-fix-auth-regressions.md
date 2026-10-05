# Bearer authentication regressions

A cutoff test now supplies a usable Pi login and proves it applies after named bearers are exhausted. A separate test calls `createReviewModels` with a fake model collection and its real provider registry. It proves the factory adapts a named value to OAuth without injecting auth kinds.

The fake-model helper accepts a credential store so the test exercises the factory's own store. No test calls a real provider.
