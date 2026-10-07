# Step 11: CLI and skills

Built tool listing and explicit fetch, plus doctor readiness for each bundled pin. Fake-archive tests prove no fetch on listing, verification, mismatch reporting and repair. The host's environment chooses storage. All three skills describe pinned Enola, advisory callers and the tool commands. The checked-in Claude skill equals its source.

Step 11's build and measurement are complete on tool-manifest. Search stays unrestricted; test coverage is unavailable pending container isolation. Final validation, external review and landing remain. No pull request has been opened.

The fix-pass gate found that the checkout doctor test inherited a shared cache path this sandbox refuses to inspect. It now uses fresh temporary state, so tool readiness cannot depend on a developer’s cache or its permissions. The failure assertion includes doctor’s output.
