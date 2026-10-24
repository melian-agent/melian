# Findings read in one register, with emojis and a set English

Status: accepted by the maintainer, 2026-10-24.

Amends: [Lens selection includes instruction identity](2026-10-06-lens-instruction-identity.md), the language line stays out of a lens run's identity.

This decision also changes default 11 of [Verifier as built](2026-10-05-verifier-as-built.md), the verifier version's recipe. That decision is inactive, retired whole by partial supersessions that step 26's audit has yet to repair, so the decisions graph refuses an amendment of it. This decision therefore restates the rule in full: the verifier version is a 16-hex hash of the verifier's instructions, its report schema and its question set, with only the rendered language line left out of the instructions.

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

[The findings guideline](../guidelines/findings.md) is the register for every finding. A lens finding has seven parts in a fixed order: status line, headline, What, Why here, failure scenario, evidence and What to do, with the verifier's reason when one ran. A deterministic finding, from a static check or a guardrail, has no failure scenario, evidence or verifier, and has five: status line, headline, What, Why here and What to do. Each renderer omits a part whose field does not exist, with one exception: in the review body, an advisory is a projection of its status line, headline, location link and footer, as [the advisory decision](2026-10-22-advisories-in-review-body.md) sets. A protected refutation whose minimum is `advisory` keeps the verifier's reason and its floor note in that body entry, under the footer. A repeated shape stays one finding per instance, each with its own proof first and as many peers as `context` evidence as fit in `report_finding`'s ten locations, its explanation giving the full count and naming the instances it could not cite. The register reshapes what renderers show and never removes it: every element a current renderer prints under an active decision keeps a defined place, which the guideline's table lists with the test that proves it. The current renderers' tests and goldens are the contract for what each renderer shows and in what order: where the guideline disagrees with behaviour they pin, the tested behaviour wins, unless this decision names the change. The changes it names are the status line, the emojis, the headline printed once, the two shapes and their omissions, the review-body advisory projection and the protected-refutation lines in it. The status line keeps a lowering as `🟡 P2, lowered from P1`, with the reason on one line. The guideline also sets length targets, no hedging, certainty stated through the verifier's word, and a status line of emojis beside words. Lens instructions, `report_finding`'s guidance and every renderer follow it. Plan step 35 builds it.

1. **Language.** `language: en-AU | en-GB | en-US` in the root `melian.yaml` only, `en-AU` by default. A nested or preference file that sets it is refused. It governs finding prose, one line in each lens's and the verifier's instructions, and Melian's own labels. It stays out of the plan fingerprint, the policy fingerprint, the check run's `policy` hash, each lens's version, a lens run's instruction identity, the verifier's version and the verifier's candidate identity, and it must not change what Melian finds. The verifier's version is `computeVerifierVersion`'s hash of its instructions, report schema and questions, and the verification task's key includes it, so the recipe leaves out only the rendered language line and keeps every semantic instruction: a language change reuses verification, and any other edit to the instructions does not. A lens's version hashes its `LENS.md` fields and body, which never hold the language line, so it is unchanged. Triage asks its questions with no language line, so its decision key is unchanged. Melian's own labels always render in the current `language`. A reused round's model-written prose, its findings, the verifier's reasons and the walkthrough, keeps the spelling it was written in; Melian stores no record of which language that was.
2. **Emojis.** The guideline's table gives each emoji one meaning, and every emoji sits beside a word, never alone. Separators are ` | `.
3. **Switches.** `output.emoji: auto | on | off` sets the terminal, and `auto` prints plain text when standard output is not a TTY or not UTF-8. `publish.emoji: on | off` sets pull-request comments and the status lines in them. Neither switch enters the check run's `policy` hash or any other reuse identity. `output.emoji` defaults to `auto` and `publish.emoji` to `on`, so emojis stay in GitHub status lines unless a project turns them off. A screen reader reads each emoji's name, and the guideline says so.
4. **The emoji rule in `AGENTS.md`.** It covers contributors' own prose in commits, issues, pull requests and code comments. Melian's rendered output is exempt. In source, every emoji lives in one table module, written as `\u{...}` escapes beside their Unicode names, and a guardrail or Biome rule rejects a literal emoji anywhere else in source.
5. **Lens emojis.** A lens may declare its own emoji in `LENS.md` front matter. The loader refuses one that the table already uses or another lens declares. A lens that declares none takes its table row when it has one, and 🔎 otherwise. The emoji stays out of the lens's version, as its declared resolution does.

## Why

Each count points at one habit. Shorter findings match what authors reply to. Quoting the rule is the strongest single signal of acceptance, so Why here quotes it. Modal verbs mark findings that turned out wrong, so a finding states the verifier's word and what it did not check instead of hedging. Nitpicks draw no reply, so a nit stays silent by default.

The language is root-only because a lens writes one conversation's prose over many paths, so a nested value would apply nowhere it claims to, and a review with two spellings reads as a mistake. A preference file would let one maintainer's machine choose the spelling of prose a pull request shows everyone. Keeping the language out of every reuse identity keeps a spelling change from rerunning lenses, at the cost that a reused round's model-written prose keeps the spelling it was written in, while Melian's labels follow the current setting.

One table module keeps every emoji reviewable in one place, and escapes keep invisible variation selectors visible in source. The rule in `AGENTS.md` still governs what a contributor writes; it never governed what Melian renders.
