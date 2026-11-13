# The shared record decision, drafted

The maintainer asked on 2026-11-13, in the coordinator's session, for the design of durable state to be re-examined, after a review found its gaps traced to one cause: the state branch ships a changeset's whole Pi log, working state and record together.

[The shared record decision](../decisions/2026-11-13-shared-record-behind-a-store-port.md) proposes that working state stays on the host that runs and that hosts share a record of immutable facts behind a store port. It is proposed, not ruled, and must be attacked before a build.

Six spikes tested the first draft under [issue #368](https://github.com/melian-agent/melian/issues/368), on scripts and the fake model: [issue #369](https://github.com/melian-agent/melian/issues/369), [issue #370](https://github.com/melian-agent/melian/issues/370), [issue #371](https://github.com/melian-agent/melian/issues/371), [issue #372](https://github.com/melian-agent/melian/issues/372), [issue #373](https://github.com/melian-agent/melian/issues/373) and [issue #374](https://github.com/melian-agent/melian/issues/374). Every pass condition held, and each report named where the contract was wrong. The draft takes those corrections: a record that replaces another names it, a round names the rounds before it, `add` takes a batch, keys carry the route and the candidate, and the envelope is strict.

The coordinator measured the 67 pull-request stores on its host: record documents are 56.4 MB of 4,226 MB, counting every revision, and the largest pull request's is 4.6 MB.

After the spikes the maintainer directed, in the same session, that no writer holds a key. The store's write access is the trust, the trusted host holds the one key, and a dismissal counts from a writer by the store's access or by the provider's permission answer.

Three reviews then tested the draft with unit tests: [issue #378](https://github.com/melian-agent/melian/issues/378), [issue #379](https://github.com/melian-agent/melian/issues/379) and [issue #380](https://github.com/melian-agent/melian/issues/380), on scripts under `spike/record-378` to `spike/record-380`. With Melian's round, finding `3045335b9e5de9a9`, they raised seven P1s. The revised text answers each: nothing a verdict reads is chosen by a hash; a round names what it rests on and the cell names the rounds that stand; `supersedes` is limited to five kinds and one slot; the gate reads each revision's hunks; and a job that ran a head's code can add only a review's kinds. The maintainer ruled on 2026-11-13, in the coordinator's session, that a repository that takes fork pull requests pins the trusted host's key.

[Pull request #314](https://github.com/melian-agent/melian/pull/314) is frozen at `92faa656`. `docs/design.md` and the plan's new step 46 change with the decision. No code changed.

A third round, on `5a8e91cb`, raised one P1 and four P2s. Two rounds running had found a key that left out an input, so the maintainer ruled on 2026-11-13, in the coordinator's session, that a result's key is the hash of its whole request, and that an inheritance is computed at the gate and is no stored kind. The decision's table names the answer to each finding.
