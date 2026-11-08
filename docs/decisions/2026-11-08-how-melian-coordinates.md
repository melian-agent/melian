# How Melian coordinates concurrent work

The maintainer ruled on 2026-11-08 to adopt it.

## Context

Melian runs work that can collide in four ways, and until now each collision has been solved where it arose:

| Where | What collides | How it is solved |
| --- | --- | --- |
| [Pull request #294](https://github.com/melian-agent/melian/pull/294), verification waves | Waves verifying ended lenses while other lenses still run, in one process | Pi Durable documents and commits, with ownership checks on every commit |
| [Pull request #289](https://github.com/melian-agent/melian/pull/289), the probe sandbox | Probe sessions sharing sandbox-runtime's process-global manager | An in-memory queue around a session count |
| `packages/pipeline/src/static.ts`, static checks | Reviews of one clone adding and reaping worktrees | A worktree lock reason `melian-static pid <pid>`, reaped when the pid is gone |
| [Pull request #310](https://github.com/melian-agent/melian/pull/310), the state branch | Two hosts writing one changeset's storage | A lease in `index.json`, two hours long, counting how often it was taken, and a push with `--force-with-lease` |
| `melian publish` | Crash replays and retries against GitHub, which takes no idempotency key | Signed markers, the `published` document, and a provider re-read before each post |
| [Pull request #308](https://github.com/melian-agent/melian/pull/308), Actions status | An Actions round's status against a host publish of the same head | Read, then post; the race is accepted |
| [Pull request #274](https://github.com/melian-agent/melian/pull/274), the claim workflow | Comment runs that overlap, are cancelled, or arrive late | Each run recomputes the state the issue timeline implies and makes the labels match |

Two of these, #294 and #310, were built in parallel by different builders, and both had to invent their coordination. Left alone, the next change in this area invents a third. The static checks' lock already caused one incident of this kind: two builds disagreed about the lock's format, and the older build deleted the newer build's scratch as a crashed run's, as AGENTS.md's learning on a static tool's missing log records.

## Decision

Each kind of collision has one mechanism, and new code uses it.

1. **Within one process, Pi Durable's commit is the serialisation point.** State that must survive a crash lives in Pi Durable documents, and a writer proves it still owns the work in the same commit that writes. This is what #294 does. A process-global resource that dies with the process, such as sandbox-runtime's manager, may use an in-memory queue, and records nothing durable.
2. **Across processes or hosts on one changeset, a lease with a fencing generation decides the writer.** Core gains one `Lease` type. It names its holder (a run in a clone), when it was taken, when it expires, and a generation that rises every time the lease is taken. Taking a lease is a compare-and-set on the store that holds it. Every write made under a lease records the generation it was made with, and the store refuses a write whose generation is older than the store's latest. The lease is no lock: a holder that outlives its expiry can be raced, and the fencing generation is what keeps the older writer from overwriting the newer one. Two stores hold leases:
   - the state branch, in `index.json`, with `--force-with-lease` as its compare-and-set, as #310 builds;
   - a clone's git common directory, for the static checks' worktrees, which move onto the same type in place of the pid-in-a-lock-reason form.
3. **A write to an external system is idempotent and checked against that system before it is made.** GitHub takes no idempotency key, so publication keeps its signed markers, its `published` document and its re-read before each post. A status write carries the lease generation it was made under, and the merge-group copy of `melian/review` accepts a status only if its generation is the newest it can see for that head. That closes the race #308 accepts: an older Actions status can no longer replace a newer host publication, because the older one carries the older generation.
4. **Events that can be lost, repeated or reordered are handled by reconciling to the authority.** A handler recomputes the state the authority implies and makes the world match, as the claim workflow does, instead of applying each event as a delta.

## What this means for work in flight

- #294 already follows rule 1 and lands as it is.
- #289's sandbox queue follows rule 1's exception and lands as it is.
- #310 shapes its lease as core's `Lease`: its count of takings becomes the generation, and every push records it. That is a small change while #310 is open.
- Two follow-ups, after #310: publication, from the host and from Actions, holds the changeset's lease and stamps its generation on `melian/review`, and the merge-group check compares generations; and the static checks' worktree lock moves onto `Lease`.

## What this gives up

- The lease is advisory between its expiry and the next write; the fencing generation, not the expiry, is the safety.
- A store that offers no compare-and-set cannot hold a lease. GitHub commit statuses are such a store, which is why rule 3 fences by a generation the status carries, read back by the merge-group check, rather than by GitHub itself.
