# Findings read in one register, with emojis and a set English

Status: accepted by the maintainer, 2026-10-24.

Amends: [Lens selection includes instruction identity](2026-10-06-lens-instruction-identity.md), the language line stays out of a lens run's identity.

## Problem

Melian's findings are long, hedge, and repeat themselves, and a reader cannot see a finding's weight at a glance.

An analysis of 241 findings from external reviewers, beside Melian's own, gave these counts:

- External findings ran at a median of 53 words. Melian's ran at medians of 174 to 393 words.
- A finding that quoted the repository's own rule was accepted 18% of the time, against 4% for one that did not.
- Findings later refuted used modal verbs at 1.51 per hundred words. Findings fixed as proposed used them at 0.84.
- 17 of 18 nitpicks drew no reply.
- Melian prints its headline twice. `report_finding` stores What as the finding's message, and the terminal prints the message and then What.

Example: a P2 on an unguarded cache write reads, in Melian's terminal, as the sentence "`saveRecord` calls `cache.set` without a `catch`", that sentence again after "What:", then a paragraph each for why here and the scenario. Nothing on the first line says whether it blocks, which lens found it, or whether the verifier confirmed it. Its spelling follows whatever English the model chose.

## Decision

[The findings guideline](../guidelines/findings.md) is the register for every finding: seven parts in a fixed order, length targets, no hedging, certainty stated through the verifier's word, and a status line of emojis beside words. Lens instructions, `report_finding`'s guidance and every renderer follow it. Plan step 35 builds it.

1. **Language.** `language: en-AU | en-GB | en-US` in the root `melian.yaml` only, `en-AU` by default. A nested or preference file that sets it is refused. It governs finding prose, one line in each lens's and the verifier's instructions, and Melian's own labels. It stays out of the plan fingerprint, the policy fingerprint, the check run's `policy` hash, each lens's version, a lens run's instruction identity and the verifier's candidate identity, and it must not change what Melian finds. A review reused from storage may therefore keep the spelling of the language it ran under.
2. **Emojis.** The guideline's table gives each emoji one meaning, and every emoji sits beside a word, never alone. Separators are ` | `.
3. **Switches.** `output.emoji: auto | on | off` sets the terminal, and `auto` prints plain text when standard output is not a TTY or not UTF-8. `publish.emoji: on | off` sets pull-request comments and the status lines in them. Neither switch enters the check run's `policy` hash or any other reuse identity. `output.emoji` defaults to `auto` and `publish.emoji` to `on`, so emojis stay in GitHub status lines unless a project turns them off. A screen reader reads each emoji's name, and the guideline says so.
4. **The emoji rule in `AGENTS.md`.** It covers contributors' own prose in commits, issues, pull requests and code comments. Melian's rendered output is exempt. In source, every emoji lives in one table module, written as `\u{...}` escapes beside their Unicode names, and a guardrail or Biome rule rejects a literal emoji anywhere else in source.
5. **Lens emojis.** A lens may declare its own emoji in `LENS.md` front matter. The loader refuses one that the table already uses or another lens declares. A lens that declares none takes 🔎.

## Why

Each count points at one habit. Shorter findings match what authors reply to. Quoting the rule is the strongest single signal of acceptance, so Why here quotes it. Modal verbs mark findings that turned out wrong, so a finding states the verifier's word and what it did not check instead of hedging. Nitpicks draw no reply, so a nit stays silent by default.

The language is root-only because a lens writes one conversation's prose over many paths, so a nested value would apply nowhere it claims to, and a review with two spellings reads as a mistake. A preference file would let one maintainer's machine choose the spelling of prose a pull request shows everyone. Keeping the language out of every reuse identity keeps a spelling change from rerunning lenses, at the cost that a stored round keeps its old spelling.

One table module keeps every emoji reviewable in one place, and escapes keep invisible variation selectors visible in source. The rule in `AGENTS.md` still governs what a contributor writes; it never governed what Melian renders.
