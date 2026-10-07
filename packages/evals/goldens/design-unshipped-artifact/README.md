# design-unshipped-artifact

Seeded from the packaging defect [pull request #89](https://github.com/melian-agent/melian/pull/89) fixed: a manifest read at the package root that the package's `files` list did not ship, so every test in the checkout passed and the published tarball failed at its first read. The head adds `readManifest`, which reads `manifest.json` beside `dist/`, and the manifest itself, and leaves `manifest.json` off the `files` list.
