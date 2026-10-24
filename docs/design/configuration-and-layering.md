# Configuration and layering

Built in milestone 1. The files a user owns beyond `melian.local.yaml`, and the route keys `accept`, `unavailable`, and `acceptOverridden`, were built in milestone 2 (review of record). The maintainer comment that overrides a block and the confidence threshold for agentic findings are planned for milestone 4 (comment commands and decision models).

Problem: a multi-service monorepo needs different scrutiny for a payments service than for its docs, and a single root configuration cannot express that without becoming a rules engine.

Solution: `melian.yaml` may exist at any folder level. For a touched path, the nearest file applies, merged upward to the root, in the way `CODEOWNERS` resolves. Root-only policy is an exception: `trust.writers` defaults to true and only the committed root `melian.yaml` sets it. The same restriction applies to `comparison.retirement`, defaulting to `pullRequests: 10` and `recall: 0.75`. Nested and preference files cannot change either policy. A pull request reads its base's values, so a head edit takes effect after merge.

Other settings layer this way: checks, tiers, stages, lens routing, model routing, resolution levels, write-back permission, decision thresholds.

Every file in the layering is read from one revision the host chooses, the base commit for a pull request, as [Trust and isolation](../design.md#policy-and-standards-come-from-a-revision-the-host-chooses) sets out. A pull request that edits a `melian.yaml` is reviewed under the policy it is changing, not the policy it proposes. A user's own preference files layer over every committed file, and only when the host reads policy from the working tree, as [Files a user owns](#files-a-user-owns) sets out.

A `.melian/` directory may sit at any folder level too. Its `standards/` and `lenses/` resolve nearest-first for a touched path, like `melian.yaml`, so a service can carry its own conventions and its own lens. Knowledge and lens-pack settings are not per-path, and are read only from the root `.melian/`.

Resolution levels map severity to requirement:

```yaml
resolution:
  P0: block
  P1: block
  P2: acknowledge   # maintainer must dismiss with a reason
  P3: advisory
  nit: silent
```

A maintainer comment can override a block. Deterministic guardrails may block at any severity. Agentic findings block only when their confidence clears the configured threshold.

### Resolution per lens and per rule

Built in milestone 2, step 18, "Resolution per lens and per rule". [the resolution contract carried forward](../decisions/2026-10-17-acknowledge-status-exact-rule.md#resolution-contract-carried-forward) records the choices the step made.

Problem: one severity table per folder serves every check. A team cannot say that one lens only advises in one folder, or that one rule blocks in another, without moving the whole table or switching a lens off.

Example: a cleanup lens reports a reuse finding at P2. The folder's table asks for an acknowledgement, which suits a correctness finding and is too much for this one.

Solution: a `melian.yaml` may map severities for one check and for one rule, beside its table, and may set a ceiling for either. A lens may declare a default. The nearest file that speaks about a finding wins outright.

```yaml
resolution:
  P0: block
  P1: block
  P2: acknowledge
  P3: advisory
  nit: silent
  preExisting:
    P0: acknowledge
  checks:
    lens.cleanup:
      ceiling: advisory
    lens.trust-boundary:
      P2: block
      rules:
        terminal-escape: { P1: acknowledge }
    static.biome:
      rules:
        biome/suspicious/noExplicitAny: { P2: advisory }
    guardrails:
      rules:
        guardrail/forbidden-patterns: { ceiling: acknowledge }
```

- Walk from the finding's folder to the root. A file speaks about the finding when it writes a mapping for its severity, in a rule entry, a check entry, or its own table. A file also speaks when it sets a ceiling on the finding's rule or check. A value a file merely inherits is not written.
- A mapping speaks for its own severity only. A rule entry that maps only P1 does not speak for a P2 finding of that rule. A ceiling speaks for every severity.
- The first file that speaks decides the whole result, mapping and ceiling both. Nothing from a farther file applies once a nearer file has spoken.
- Specificity orders entries only within that file: rule over check over table. A ceiling in that file caps a mapping in that file.
- What that file leaves out comes from Melian's built-in table, never from a farther file.
- If no file speaks, the lens's declared default applies, then the built-in table. A lens declares its default in `LENS.md`, usually a ceiling, as `resolution: { ceiling: advisory }`.
- A merged defect resolves every member claim under its own check, rule, severity, and path, each with its own mapping and ceiling. The caps on a cause read the merged defect's cause and evidence, so one report's severity and another's proof combine and a merge never lowers what blocks. The defect takes the strictest result, and the floors then apply to the defect.
- Deterministic checks use the same keys. `static.biome`, `static.tsc`, `static.enola`, and `guardrails` are check names like a lens's, and `static.mutation` joins them once step 16 lands. A key under `checks` that names none of the three kinds is refused when the file is read.
- A lens report whose every claim a verifier refuted is left out of the strictest result, unless every report of the defect is one.

The accepted cost: a file that writes its own severity table overrides a lens's declared default, unless it restates it. Example: a cleanup lens declares `ceiling: advisory`, and a root file writes `P2: acknowledge`. That file has spoken about every P2 finding, so a P2 cleanup finding now needs an acknowledgement. Two diagnostics make this visible. `melian findings` and `melian review` name the file and the entry that decided each finding, with the cap or floor that then moved the result. Adjudication stores that with the finding, outside the verdict's fingerprint. `melian doctor` lists, for each file that speaks, each lens default and each farther value it now overrides, a file that speaks only through a ceiling included. It skips a value the file restates in an entry of its own.

A guardrail finding's ID carries only `guardrail/<name>`, so every `forbidden-patterns` rule shares one ID. The finding names the configured rules that matched in a typed field outside its ID, so no stored finding changed identity. A configured rule is keyed `guardrail/<name>/<rule>`, the rule-level entry, and a finding several rules matched resolves under each and takes the strictest. A whole-guardrail entry, `guardrail/<name>`, is a check-level entry for every finding of that guardrail. The two classes of policy-change notice are keyed apart, as `guardrail/policy-change-review/policy` and `guardrail/policy-change-review/analyser`.

The caps apply after resolution. An `affected` finding with no proving location stays at advisory or below, read from the merged defect's evidence. So does a lens report no verifier judged, read from the report itself. A `pre-existing` finding stays at or below its `preExisting` cap, which is `advisory` by default and may be `acknowledge`, never `block`. That cap merges upward key by key like other settings. It is not part of the walk, so a folder's table does not erase it.

The floors apply after the caps, to the defect. A policy-change notice on a `melian.yaml` or a lens file never falls below `acknowledge`. Neither does a `melian/injection-attempt` finding, whatever a mapping, a ceiling, or a lens's default says. A member of "Pre-existing, important", as [Verification](../design.md#lowering-a-severity) defines it, never falls below `advisory`. Step 29 adds each protected judged claim's minimum, as [Verification](../design.md#lowering-a-severity) defines it. The minimum reuses the same claim's confirmed resolution and count behaviour, including every ordinary floor and display-only lift, and never exceeds acknowledgement. It applies across live merged members. A visible minimum counts when its confirmed outcome counts, even when it alone raises a silent result. `decidedBy.floor` names `lowered-trust` or `refuted-trust` when it raises the result, with every qualifying claim and its minimum in `decidedBy.trustFloor`.

A pre-existing finding never resolves `block`. A folder that opts in to `preExisting: acknowledge` for a severity gets a finding that resolves `acknowledge`, and that is treated exactly as any `acknowledge` finding is, in the verdict, the status, and the outputs. The acknowledgement is a dismissal with a reason, and an unresolved one fails the published status, as [the as-built status rule](../decisions/2026-10-17-acknowledge-status-exact-rule.md) records. The findings document keeps it by finding ID across revisions, so a carried finding that was acknowledged stays answered.
That is the maintainer's choice of 2026-10-12.
[The current contract](../decisions/2026-10-17-acknowledge-status-exact-rule.md#resolution-contract-carried-forward)
restates what survives of step 18 and [the out-of-diff decision](../decisions/2026-10-03-out-of-diff.md).

The policy-change notice is forced on for the root file, and a nested file is judged under the directory above it, where a base file may switch the notice off. Two rules close that gap. A change to any `resolution` key in any `melian.yaml` always draws the notice. So does a change to a lens's declared resolution in any `LENS.md`. Melian parses the value at the base and at the head with its own loaders, and a side that does not parse counts as changed. Neither notice resolves below `acknowledge`, and no entry under `guardrails` lowers it: it takes the stricter of the files' tables alone and its class's entries. A pull request is judged under its base's keys, so a head cannot lower its own findings. A lens's declared default leaves [resolution ownership](../decisions/2026-10-03-resolution-ownership.md) alone: only adjudication writes a resolution.

Step 30, built in [pull request #147](https://github.com/melian-agent/melian/pull/147), forces a notice for every changed nested `melian.yaml` and every lens file at any depth. Both `.melian/lenses/<name>/LENS.md` and `.agents/lenses/<name>/LENS.md` qualify. Git's blob identities and symlink modes at base and head decide whether the file changed. Additions, deletions and renames count, as do formatting and every key. An executable-bit-only change with equal blobs does not; a change to or from a symlink does. There is no key exemption or new notice class. Every such notice resolves at least `acknowledge`. Its explanation says when it overrides the parent's off switch.

Policy names `melian.yaml`, `AGENTS.md` and `CLAUDE.md` are recognised case-insensitively, as local and secrets policy names already are. Lens classification also ignores case in `.melian`, `.agents`, `lenses` and `LENS.md`. The forced rule and acknowledgement floor cover those lens aliases and case variants of `melian.yaml`. Policy membership under `.melian`, analyser classification and package-manifest checks also ignore case. The lens scope scan recognises aliases; filesystem and revision readers still decide what can load. Revision readers still use exact Git names. Existing resolution markers and table-only protection remain. An invalid judging base fails the check; an unparseable head still draws a notice. Ordinary inheritance and the host's policy source stay unchanged. Analyser configuration and standards files remain under the parent's switch, an accepted risk that keeps fixture analyser changes quiet. [The exact rule](../decisions/2026-10-18-policy-file-types.md) records the attack, file types, dismissal binding and residual risk. [The casing clarification](../decisions/2026-10-18-case-variant-policy-paths.md) records the alias rule.

[The decision](../decisions/2026-10-13-resolution-as-built.md) gives a two-folder example, three worked findings, the guardrail keys, and the step's goldens, which live under `packages/evals/goldens/resolution/`.

### Language and emojis

Planned in step 35, [issue #197](https://github.com/melian-agent/melian/issues/197). [The findings guideline](../guidelines/findings.md) sets how a finding reads. Three keys set its English and its emojis, and [the decision](../decisions/2026-10-24-finding-register.md) records why.

```yaml
language: en-AU   # en-AU (default) | en-GB | en-US
output:
  emoji: auto     # auto (default) | on | off: the terminal
publish:
  emoji: on       # on (default) | off: pull-request comments and the ledger
```

- `language` sets the English of finding prose, of one line in each lens's and the verifier's instructions, and of Melian's own labels, as [the guideline](../guidelines/findings.md#language) lists. Only the committed root `melian.yaml` sets it. A nested file or a preference file that sets it is refused, as `trust` and `comparison` are. A lens writes one conversation's prose over many paths, so a nested value would apply nowhere it claims to. A preference would let one maintainer's machine choose the spelling of prose a pull request shows everyone. The language stays out of the plan fingerprint, the policy fingerprint, each lens's version, a lens run's instruction identity and the verifier's candidate identity, so changing it reruns nothing and changes no finding. Melian's own labels always render in the current `language`. A reused round's model-written prose, its findings, the verifier's reasons and the walkthrough, keeps the spelling it was written in; Melian stores no record of which language that was.
- `output.emoji` sets the terminal. `auto` prints plain text when standard output is not a TTY, or when the locale is not UTF-8, read from `LC_ALL`, `LC_CTYPE` and `LANG` in that order. The root `melian.yaml` or a preference file may set it, since it changes only how one machine shows a review. A nested file is refused, as it is for `triage`. JSON output never carries emojis.
- `publish.emoji` sets pull-request comments, the review body and the ledger, the status lines in them included. Only the committed root `melian.yaml` sets it, since it changes what everyone reading the pull request sees; a nested or preference file is refused. The `melian/review` commit status keeps its plain description, which the merge-group job reads back.

None of the three may rerun a check. Problem: `runChecks` keys a finished check run by a `policy` hash of the whole effective `MelianConfig`, with the source, tool manifest and mutation inputs, in `runIdentity` in `packages/pipeline/src/checks.ts`. Example: a root `melian.yaml` that changes only `language` from `en-AU` to `en-US` would give every static check and guardrail a new identity at the same revision, and the review would run them all again for findings no spelling can change. `output.emoji` and `publish.emoji` would reach the same hash, since they live in the same configuration. Solution: step 35 hashes a projection of the configuration without `language`, `output.emoji` and `publish.emoji`. A same-revision regression test shows a language-only change, and an emoji-only change, reusing the check run. The policy fingerprint that `configsFor` computes hashes resolution alone, so none of the three reaches it.

### Files a user owns

Built in milestone 2, except `melian.local.yaml`, built in milestone 1, and the secrets file in a repository secret, planned for milestone 3 (Actions host).

Problem: routes and secrets want different handling. A route is a preference a team may share. A key is a secret nobody should commit. A reference to a secrets manager, such as the name of an environment variable, is not a secret at all. The one file a user owns today, `melian.local.yaml`, is per clone, so an engineer repeats routes in every repository, and a key has nowhere to live but Pi's store or the environment.

Solution: preferences and credentials live in separate files.

| File | Holds | Where | Committed |
|---|---|---|---|
| `melian.yaml` | Policy, the team's default routes, credential names, environment variable names | any folder | yes |
| `~/.config/melian/config.yaml` | One user's preferences for every repository | the user's configuration directory | no |
| `melian.local.yaml` | One clone's preferences | beside the root `melian.yaml` | no, git-ignored |
| `~/.config/melian/secrets.yaml` | One user's credentials for every repository | the user's configuration directory | no, mode 0600 |
| `melian.secrets.yaml` | One clone's credentials | beside the root `melian.yaml` | no, git-ignored, mode 0600 |

Both preference files take `melian.yaml`'s schema. The per-clone file wins over the user-level one, and both win over the committed files. A route's `accept`, `unavailable`, and `acceptOverridden` are policy, so only a committed `melian.yaml` sets them; a preference file that sets one is refused, naming the key, since it could otherwise wave its own override through. The user-level files live in `$XDG_CONFIG_HOME/melian/`, which is `~/.config/melian/` when the variable is unset.

A credential entry has a name, a provider, a type, and a value that is literal (`key`), an environment variable name (`env`), or a command (`command`), as Pi's store takes `!command`. The secrets-file type remains `api_key`. Melian uses a value as an API key where supported, or a bearer for an OAuth-only provider. Bearers carry no refresh token, and Melian never refreshes them. A numeric JWT `exp` claim, read without signature verification, supplies the expiry when at most 30 days ahead. Other tokens receive a rolling one-hour lease on every read. A bearer inside the seven-minute cutoff reads as absent. The credential pool brings managed OAuth logins in milestone 3:

```yaml
# ~/.config/melian/secrets.yaml
credentials:
  work-anthropic: { provider: anthropic, type: api_key, env: ANTHROPIC_API_KEY }
  work-openai: { provider: openai, type: api_key, command: "op read op://dev/openai/key" }
```

A command source is allowed only in a file the user owns, never in a committed `melian.yaml`. Problem: a merged change that adds a command source runs that command on every engineer's machine at their next review, a supply-chain hole. Solution: committed policy may name credentials and environment variables, and nothing that executes. Routes and stacking rules name credentials and never contain them. Melian refuses a `melian.secrets.yaml` that git tracks under any case of its name, since a head could supply one; a case-insensitive filesystem opens a committed `MELIAN.SECRETS.YAML` as the file itself. A command source runs only from the user-level secrets file, never from `melian.secrets.yaml`, which holds literal and environment sources only. Problem: a file in the working tree may be a head's, and no check on it holds everywhere: a patch applied under umask 077 lands as the user's own file, mode 600, and already ignored. Solution: commands live outside every repository. The user-level file must still be the user's own: the user owns it, its mode is 600, and no one else can write the directory holding it, unless that directory is sticky. The per-clone file is never read through a symlink. Melian opens each file once and checks it through that handle, so the file checked is the file read. A command runs when a review is about to start a task that may call a model, and never in a message; a repeat review that attaches to finished tasks runs none: an error names the credential and its file, never what the command printed. A syntax error in a secrets file names only its position, since the parser would quote the line. `melian doctor` names where each credential comes from without running one.

Melian resolves a credential from the secrets files first, the per-clone one before the user-level one, each in its own order, then Pi's store, then environment variables. Melian tries named credentials in that order, skipping an unusable value before trying the next. An unread command counts as present until the review unlocks it. Before each concrete model task, Melian unlocks its selected route: the chosen decider before triage, selected lens routes after triage, verifier routes after candidates exist, and the light route before a walkthrough ([task-route decision](../decisions/2026-10-08-credentials-follow-concrete-task-routes.md)). It checks each selected bearer for usability; a repeat review that attaches to finished tasks runs none, as [the decision on when credential commands run](../decisions/2026-10-07-credential-commands-run-when-a-model-is-asked.md) records. Before any wait resumes live tasks, the CLI also unlocks their stored providers, even when the current plan routes elsewhere ([resume decision](../decisions/2026-10-08-resumed-task-credential-providers.md)). An attached live lens or verifier task keeps that checkpoint-based unlock and never unlocks its full route again. An unusable bearer fails the review before the model is asked, naming the credential and asking for refresh through the tool that owns it. It never substitutes Pi's login for that planned source. `.gitignore` lists `melian.local.yaml` and `melian.secrets.yaml`, policy-change review reports a change that commits either, and `melian doctor` fails when either is tracked. A change to the credential references in a `melian.yaml` is a policy change.
