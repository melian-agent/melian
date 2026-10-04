# Tool provisioning

Choice: A `tools.yaml` manifest in Melian pins each external tool's version and per-platform URL and sha256, under the same release-age quarantine as npm, and a bump is a reviewed pull request; one manifest builds a local cache verified by hash for trusted runs and a container with no network, a read-only worktree, and resource limits for untrusted heads; a tool whose configuration loads repository code comes from the checkout's lockfile install or else Melian's own copy, a standalone analyser from the manifest, and either executes inside the environment; never a host-installed analyser; Opengrep over Semgrep's registry rules, with no rules shipped at first, and gitleaks as the fast tier's secrets check

Why: Version drift changes rules and so breaks finding identity, and a binary on the host is outside the trust boundary; Semgrep's registry rules carry a licence that restricts their use and redistribution
