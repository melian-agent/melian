# design-reimplements-an-authority-no-dependency-clean

A clean golden for `reimplements-an-authority`, from [the ask-the-authority decision](../../../../docs/decisions/2026-10-12-ask-the-authority.md): hand-written parsing is fine where no dependency covers the format. The head parses a delay such as `90s` or `5m` with a pattern. The repository's one dependency is `yaml`, which parses no durations, so there is no authority to ask and a review must report nothing.
