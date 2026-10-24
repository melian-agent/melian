# 2026-10-24: zod 4.6.7 for its memory advisory

A high-severity advisory, [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), covers `zod` below 4.6.6: it can exhaust memory while validating oversized constrained collections. `npm audit --audit-level=high` in `npm run check` failed on it, which fails every gate and merge group.

`zod` is transitive only, through pi-ai's Anthropic and OpenAI SDKs and through Stryker's mutation-server protocol. `npm update zod` moved every copy from 4.6.5 to 4.6.7 within their declared ranges. The lockfile diff is that one entry: version, resolved URL and integrity. The release-age check passes.

This follows the learning from [pull request #160](https://github.com/melian-agent/melian/pull/160): fix an audit-blocking dependency in its own pull request first, then requeue the others.
