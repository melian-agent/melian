# Step 11: tool pins

Built the strict `ToolManifest`, four official Enola v0.4.27 pins, and an online release verification gate. Local tests use injected responses. A reviewed release-age exception names why the spike needs the fresh release. The cache and measurement remain in progress; there is no pull request yet.

Fix pass: pipeline builds copy the reviewer-owned root manifest into the package, and the files list ships that copy. CI now runs installed tools and doctor against the tarballs in an empty git repository, with isolated preference and Pi directories. The packed manifest matches the root bytes.
