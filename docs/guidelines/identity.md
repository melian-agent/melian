# Identity guidelines

A key is any value Melian computes so that a later run can say "this is the same thing": reuse this result, attach to this task, skip this work, count this as the finding already dismissed. An ID, a fingerprint, a version hash, a cache key and an attach condition are all keys. Read this before adding or changing one, in any package.

Problem: each key was designed where it was needed, by listing the inputs its author thought of. Example: the lens task's attach key drew a finding in six fix passes on [pull request #296](https://github.com/melian-agent/melian/pull/296). It lacked the route, then the probing environment, then held the earlier findings it should not have, then sampled one branch of a prompt and missed the others. Solution: the rules below, a table of every key, and a question each brief asks.

## How a key goes wrong

- **An input is missing.** The key matches when the answer would differ, and Melian reuses stale work. This is the unsafe direction. A verification keyed without the dismissed findings its verifier was shown is never asked about a later dismissal.
- **Something is in it that should not be.** The key never matches, so work reruns, or a dismissal stops applying. A boundary nonce does this on every run. So did the round's overrides inside a verdict's policy fingerprint, which kept a dismissal from re-deciding its round.
- **An output or a label stands in for identity.** A finding ID that names a line cannot tell two mutants on that line apart. The model a run finished on is what happened, not what was asked.
- **One thing has two keys.** Two functions build a key for the same thing in different ways, and a caller that compares across them is wrong at the edges. The table's last section lists the pairs Melian has.

## Rules

1. **Say what a match decides.** Before the key, write the sentence: "when this matches, Melian does not …". If you cannot, there is no key to design yet. The sentence goes in the table below.
2. **Take the key from the value, never from a list beside it.** Build the request, the record or the input once, and hash that value. A second list of "the fields that matter" is the thing that goes stale. Where one function builds the value and returns the key with it, nothing can reach the producer that the key does not cover.
3. **Inputs only.** What the run did, the model it finished on, its attempt, its spend, its answer, is payload. A key that needs an output is computed too late to decide reuse.
4. **Write every exclusion down, with its reason, in one place.** Leave a field out by destructuring it away next to the hash, as `candidateIdentity` and core's `versioned` do, with one comment line saying why. An exclusion nobody wrote down is a missing input.
5. **When unsure, include.** A missing input reuses a stale answer and nobody sees it. An extra input costs a rerun and shows up as cost.
6. **Nothing random, and nothing that names the host.** No nonce, time, absolute path, process ID or credential. Render with a fixed nonce for identity, as the instruction fingerprint does. Where a host fact must enter, such as a tool's version or a platform, name it as an input and say so in the table.
7. **Nothing the head controls decides trust.** A key may cover the head's content. It may not let the head choose which earlier answer it attaches to, or whose record it replaces.
8. **Fixed text is an input.** Instructions, prompts, tool descriptions and schemas change what a model answers. Hash them as the build has them, whole, never a sample rendering of one branch. Hash the strings, never a function's source text: `String(fn)` differs between Vitest, Node's type stripping and a tsc build, so a run that crashes under one and resumes under another loses its key. Keep the wording in a table of strings and hash the table.
9. **Make the bytes canonical.** Sort keys, or hash an array in a declared order, and say which. A missing value is written one way: decide between leaving it out and an explicit none, and never let `undefined`, `null` and `""` mean the same thing in two places.
10. **One thing, one key function.** Before writing a key, find the existing one in the table and call it. Two functions for one identity are a defect even while they agree.
11. **A key is a stored shape.** Changing what goes in orphans or wrongly matches everything stored under the old one. Say in the pull request what happens to stored data, and ship the reopen test a version bump ships.

## Tests a key needs

- Change each input in turn, and the key changes. One test per key, driven from the value's own fields so a new field joins the test without an edit.
- Change each exclusion, and the key does not.
- The reuse itself: two runs whose inputs agree attach, and two that differ in one input do not. A key test alone proves the hash, not the decision it gates.
- Each of these fails with its rule removed, as [Validation](../../AGENTS.md#validation) requires.

## In a brief and a pull request

A brief asks: does this change add or alter anything that decides reuse, attachment or sameness? When it does, the pull request description carries the key's row from the table, as changed, and names the tests above. A reviewer reads the row against the code.

## The keys Melian has

Surveyed at `a045356a` on 2026-11-13. A pull request that adds or changes a key updates its row in the same commit. Checksums that only verify a download, random nonces, and in-process lookup keys are not keys in this sense and are not listed.

### Core

| Key | Built in | When it matches, Melian | Left out, and why |
| --- | --- | --- | --- |
| Finding ID, `findingId` | `core/src/findings.ts` | treats two reports as one finding, so its dismissal and lifecycle carry | Line numbers, so an edit above keeps it. Failure scenario and evidence, so rewording keeps a dismissal. An Enola result's span past its first line, so an edit inside a symbol's body keeps it |
| `snippetHash` | `core/src/findings.ts` | keeps a dismissed finding dismissed | Whitespace, as the normaliser defines it |
| `Verdict.fingerprint` | `core/src/adjudication.ts` | skips posting a review it already posted | Dismissal reasons, past dismissals, which file decided, the guardrail match, check caveats |
| `dismissalVersion` | `core/src/publication.ts` | takes a dismissal's reply as given | The root, for a person's dismissal, so older versions still match |
| `replyKey` | `core/src/publication.ts` | takes a thread reply as posted | Nothing |
| Pull-request changeset ID | `core/src/changeset.ts` | gives every push of a pull request one changeset | Nothing; owner and name are lower-cased |
| Range changeset ID | `core/src/changeset.ts` | gives a range one changeset across revisions | The commits: it hashes the mode and the names of base and head |
| `Revision.key` | `core/src/changeset.ts` | reads the same sightings, index entry, verdict and round | Scope |
| Lens `version` | `core/src/lens.ts` | names a lens's findings as one producer's | Its file, nearer scopes, resolution and emoji, so an unchanged lens keeps its version |
| Verifier question set version | `core/src/verification.ts` | feeds the verifier's version | Nothing |
| `questionFingerprint` | `core/src/decider.ts` | accepts a recorded answer to a question | Nothing |
| `GraphSnapshot.key` and the Enola policy hash | `core/src/graph.ts`, `core/src/enola.ts` | reuses a cached graph | The repository's own `repos`, `providers`, `output` and `history`, which Melian overwrites first |
| External finding ID | `core/src/comparison.ts` | updates an imported finding and adds none | The reviewer, so renaming a reviewer orphans no hand record |
| Mutant `identityHash` | `core/src/mutation-inventory.ts` | treats two inventory rows as one mutant | Nothing |
| Coverage artefact IDs | `core/src/coverage-artifacts.ts`, `core/src/graph-coverage.ts` | names an artefact by its content | Nothing |
| Claim identity | `core/src/verification.ts`, `core/src/adjudication.ts`, `core/src/findings.ts` | counts one claim per sighting | Nothing |

### Pipeline

| Key | Built in | When it matches, Melian | Left out, and why |
| --- | --- | --- | --- |
| Lens run key | `pipeline/src/review.ts` | reuses a run's conversation and request IDs | Scope, which reaches it through the lens version |
| `instructionFingerprint` | `pipeline/src/review.ts` | keeps the lens task a review attaches to | The real nonce. The callers listing and enclosing functions, which are best effort |
| `selectionOf` | `pipeline/src/review.ts` | attaches a review to its existing lens task | Who set the route, and the credential, by [the run identity decision](../decisions/2026-11-08-lens-run-identity.md). What a probing run's read paths hold, such as a reinstalled `node_modules`, a gap the maintainer accepted on 2026-11-13. A probing run's environment names its host by one value, `probingHost`: the sandbox's platform and kind, and the CPU architecture and version of the Node that runs the probe. Left out of that value on purpose: the operating system's release, since the platform names the system and an update would rerun every probe; the CPU's model, since the architecture names the instruction set Node runs; the sandbox's own version, which ships with Melian's lockfile and confines a probe without changing what it computes; the host's locale and clock, which no probe should hang on; and what the system's programs and the read paths hold, the gap above. Melian's probe runner enters as `probeRunnerSample`, in the probing protocol: the modules it generates, the command and environment it starts, and the read and deny lists it builds, over fixed paths, so a release that changes any of them runs a probing level again. Left out of it: how `writeHead` writes the head's tree, since it writes the head's own tracked files, which the selection pins by commit. That reason fails if `writeHead` ever filters, adds or rewrites a file |
| Adjudication attach key | `pipeline/src/review.ts` | attaches to an existing adjudication task | Run details, which publication projects |
| Triage decision key | `pipeline/src/review.ts` | attaches to a recorded triage decision | The state, which carries the nonce |
| `candidateIdentity` | `pipeline/src/verification.ts` | lets an earlier wave's outcome stand for a candidate | `dismissals`, stored verdicts and the speaker's body |
| Verification task attach key | `pipeline/src/verification.ts` | resumes a verification task | The nonce and stored verdicts |
| `claimKey` | `pipeline/src/verification-waves.ts` | says which claims a wave owns | Nothing |
| `verifierVersion` | `pipeline/src/verification-instructions.ts` | lets wave outcomes stand | Nothing |
| `lensSource` | `pipeline/src/lens-tools.ts` | lets a producer replace its own sighting at a revision | The level, for an old conversation |
| Dismissal `identityOf` | `pipeline/src/findings.ts` | keeps an inherited dismissal linked to its root | Nothing |
| Resolution policy fingerprint | `pipeline/src/configurations.ts` | keeps an adjudication under its policy | Lens variants, so a budget or model change leaves it alone |
| Check run policy and `identityKey` | `pipeline/src/checks.ts` | waits for a running check and starts none | Display-only configuration |
| `mutationInstallation` and the mutation cache partition | `pipeline/src/mutation-static.ts`, `pipeline/src/mutation-cache.ts` | reuses an earlier judged head's mutation results | The head, with trust and ancestry checked at read |
| Coverage producer index | `pipeline/src/coverage-cache.ts` | reads cached coverage under a graph | Nothing |
| State directory hash | `pipeline/src/tool-provisioning.ts` | gives a clone its state directory | Nothing |
| Tool cache directory | `pipeline/src/tool-cache.ts` | reuses a materialised tool | Nothing |

### GitHub and evals

| Key | Built in | When it matches, Melian | Left out, and why |
| --- | --- | --- | --- |
| Ledger stamp | `github/src/ledger.ts` | leaves the ledger comment as it is | Dismissal identity |
| Triage questions fingerprint | `evals/src/triage.ts` | compares two triage measurements | Nothing |

### One thing with two keys today

Each is a defect by rule 10, listed so nobody adds a third. Fixing one is a stored-shape change.

- **Claim identity.** Core hashes `JSON.stringify([id, check, version])`. The pipeline's `claimKey` writes `<id> <check>@<version or "">`. A missing version reads `null` in one and `""` in the other.
- **Dismissal identity.** Core's `dismissalVersion` covers reason, dismisser and time. The pipeline's `identityOf` also covers severity, sighting and trigger, in another order. One versions replies and the other gates inheritance.
- **Canonical bytes.** `checks.ts` sorts keys. Every other JSON-hashed key relies on the order its fields are declared.
- **Length.** Keys are cut to 12, 16 or all 64 hex digits, with no rule for which.

## What is planned

[Pull request #377](https://github.com/melian-agent/melian/pull/377)'s shared record decision, once ruled, gives a result one key function in core: the hash of the whole request its producer was given, with named exclusions and the first test above built in. A guardrail then reports a new direct hash call in source, with today's callers on a list that shrinks.
