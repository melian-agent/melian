# Restore the review plan and credential clauses that partial supersessions retired

Amends: [2026-10-08-credentials-follow-concrete-task-routes.md](2026-10-08-credentials-follow-concrete-task-routes.md) and [2026-10-08-resumed-task-credential-providers.md](2026-10-08-resumed-task-credential-providers.md), restoring clauses that partial `Supersedes:` lines retired.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

Where a clause below conflicts with any other active decision, including the decisions this file amends, that decision wins. These clauses fill gaps the partial supersessions left; they override nothing.

[2026-10-05-review-plan-resolution.md](2026-10-05-review-plan-resolution.md) superseded [2026-10-04-review-plan-and-routes.md](2026-10-04-review-plan-and-routes.md) and [2026-10-04-credential-files.md](2026-10-04-credential-files.md) while changing two choices of each. [2026-10-06-named-bearer-credentials.md](2026-10-06-named-bearer-credentials.md) superseded the resolution decision for its API-key restriction alone. [2026-10-07-credential-commands-run-when-a-model-is-asked.md](2026-10-07-credential-commands-run-when-a-model-is-asked.md) superseded the bearer decision for its unlock timing alone. [2026-10-08-credentials-follow-concrete-task-routes.md](2026-10-08-credentials-follow-concrete-task-routes.md) and [2026-10-08-resumed-task-credential-providers.md](2026-10-08-resumed-task-credential-providers.md) each superseded the command decision for one part of how unlocking works. The index retired each target whole. The clauses below still hold on main; this file restates them and changes nothing.

## From [2026-10-04-review-plan-and-routes.md](2026-10-04-review-plan-and-routes.md)

- Which model plays which role is a lookup, never a model's judgement.
- A deterministic resolver over pi-ai's catalogue (name, context window, price), the credentials present, and later the calibration store's per-lens scores produces a review plan at intake, a durable document that `melian doctor` prints.
- The plan routes each lens's finder, each candidate's verifier (a different family from its finder when available), and the walkthrough.
- It routes no deduper in milestone 2: the mechanical merge by finding ID and across rules runs before verification, so one defect is verified once. Detecting duplicates by meaning on a decision model is milestone 4.
- A route's `unavailable` key is `fail` or `derive`, default `derive`.
- The outside-policy record a check keeps in its lineage appears in the CLI's output, `melian findings --json`, and the review body, and, once it lands, uncollapsed at the top of the ledger.
- In milestone 3, a host completing the manifest reruns a check that ran outside policy on a tier with `acceptOverridden: false`, instead of recording it failed.
- Policy, routes included, is read from the base for a pull request. Preference files apply only to a range review on the checked-out commit; a pull-request review takes the base's routes, a derived route, or `--model`.

## From [2026-10-04-credential-files.md](2026-10-04-credential-files.md)

- Credentials live in `melian.secrets.yaml`, git-ignored, mode 0600, beside the root `melian.yaml`, and in a user-level secrets file, so one file serves every repository an engineer works on.
- Preferences live in `melian.local.yaml` per clone and in a user-level configuration file in the same directory, with `melian.yaml`'s schema. The per-clone file wins over the user-level one, and both win over the committed file.
- A credential entry has a name, a provider, a type, and a value that is literal, an environment variable name, or a command, as Pi's store takes `!command`.
- Committed policy holds nothing that executes. Naming credentials and environment variables in a committed `melian.yaml` waits for the stacking rules of milestone 3's credential pool; today's schema has no key for either.
- Resolution order: the secrets files, then Pi's store, then environment variables.
- Routes name models, never credentials. The stacking rules planned with milestone 3's credential pool will name credentials and never contain them.
- On the Actions host planned for milestone 3, the secrets file will arrive in one repository secret and the preferences file in a repository variable, which stays readable where a secret does not; each will be optional.
- The credential references in `melian.yaml` join the policy-change list.
- `.gitignore` lists both local files.
- On the Actions host planned for milestone 3, Melian will register every credential value with the `add-mask` command at startup, since GitHub masks a secret's whole value and not its substrings, and the pool will never put a value in a message.
- User documentation says, neutrally, that whether a subscription may be used in automation or shared across a team is a question for the provider's contract, and that Melian takes no position.

## From [2026-10-05-review-plan-resolution.md](2026-10-05-review-plan-resolution.md)

- A route's `accept`, `unavailable`, and `acceptOverridden` come only from the root `melian.yaml`. A preference file that sets one is a configuration error naming the key, and so is a nested `melian.yaml`, until the plan resolves routes per path.
- A route with `acceptOverridden: false` must name a model or an `accept`. Without `accept`, a committed route accepts its own model and fallbacks.
- The resolver substitutes and derives only for a committed route. Every accepted model with credentials comes before any fallback outside `accept`, the route's own first, then `accept`'s. When no accepted model has credentials, `unavailable: fail` fails the tier. Otherwise `derive` takes the same model from another provider with credentials, matched by catalogue name. The match removes any provider prefix and parenthesised qualifier, and prefers a name without a qualifier. Failing that, it takes the model with credentials whose price, input plus output per million tokens, is nearest on a log scale. The candidate must match the wanted model in reasoning, and have a context window at least the wanted model's or 200,000 tokens. Ties go to the larger window, then by provider and ID. A route from a preference file or `--model` is never replaced.
- A check that `unavailable: fail` or `acceptOverridden: false` refuses never runs: it records `failed` with the reason. A refused route drops every fallback outside `accept`. A lens a preference file moves to another tier stays under its committed tier's policy, and records `failed` if it finishes on a model that policy refuses.
- A check records lineage on the model its lens finished on. It records it when a preference file, `--model`, or a derivation moved its tier off a committed route's model, inside `accept` or outside it, and whenever the model is outside `accept`. It records none where no committed route names the tier. A lens task is reused only for the same routes, so the lineage always names the route that ran. The plan's JSON is stored in the verdict's provenance, and `melian findings` reads it from there.
- A `melian.secrets.yaml` git tracks under any case of its name is refused. A command source runs only from the user-level secrets file, and only when the user owns it, its mode is 600, and no one else can write its directory unless it is sticky.
- Melian resolves the user-level path: its directory must not be a symlink, and its real path must not lead into the checkout, or the command is refused. `melian.secrets.yaml` holds literal and environment sources only, and is never read through a symlink.
- The user-level files live in `$XDG_CONFIG_HOME/melian/`, else `~/.config/melian/`.
- No blocking guardrail stops a commit of `melian.local.yaml` or `melian.secrets.yaml`. Policy-change review reports one, the loader refuses a tracked secrets file under any case of its name, and `melian doctor` fails on either.

## From [2026-10-06-named-bearer-credentials.md](2026-10-06-named-bearer-credentials.md)

- Secrets entries keep the `api_key` schema. Melian adapts their values to API keys where supported, or to bearer credentials for OAuth-only providers. Bearers carry no refresh token, and Melian never refreshes them.
- A numeric JWT `exp` claim, read without signature verification, supplies expiry when at most 30 days ahead. A larger claim or a token without a credible expiry gets a rolling one-hour lease on every read. A token inside the seven-minute cutoff is unusable.
- Melian tries named credentials in precedence order: per-clone before user-level, then each file's order. An unusable value yields to the next named credential. Pi's login applies only after all named values are exhausted.
- An unusable bearer fails the review with a credential error asking for refresh through the owning tool. It never silently replaces that planned source with Pi's login.
- `melian doctor` runs no credential command.

## From [2026-10-07-credential-commands-run-when-a-model-is-asked.md](2026-10-07-credential-commands-run-when-a-model-is-asked.md)

- Asking whether a provider holds credentials runs no command: `hasCredentials` counts an unread command as present, as planning does.
- The credential error stops the review before the model is asked, naming the credential and its file. It does not stop the review before the review storage opens, since the review must read the storage to know whether it has tokens to spend.
- The walkthrough reads its attempt count and known task ahead of its commit, so a review at `maxWalkthroughAttempts` without `rerun` runs no command and asks nothing. A repeat review that reads a stored walkthrough runs no command. A command that fails there leaves the fixed summariser note, which names no credential, since the walkthrough is published. The CLI's `unlockModels` prints `melian: <the credential error's message>` to stderr before the note is stored, and the exit code stays as the review left it.
- A host must supply `unlockModels`, or unlock before its first review, whenever it uses command credentials. `reviewChangeset` itself runs no command, so a host that does neither sees a failing command only inside the first model request, where pi-ai names the provider and not the credential. The live evals unlock through `liveModels`, which runs `unlockCredentials` over the providers of every named credential before the first review, so a failing command stops the run with its error naming the credential.
