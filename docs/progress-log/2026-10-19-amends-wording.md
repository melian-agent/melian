# Amends wording follow-up

Follow-up to [pull request #150](https://github.com/melian-agent/melian/pull/150), findings 1, 2, 3 and 5 of its review of record.

- An Amends edge to an absent file now reads "<file> amends absent <target>"; a Supersedes edge still reads "supersedes absent".
- The cycle error reads "The base decision graph contains a cycle", since either edge kind can form it. The code stays `invalid`. No test asserted the old text; the existing cycle tests match on "cycle".
- The decisions guideline and AGENTS.md say the Amends scope is optional, and that only a declaration's first sentence supplies edges, so each declaration goes on its own line. No decision file changed.

Each wording test failed on the old code for the reported reason, then passed. Hand mutations: forcing the verb to "supersedes" or "amends" fails the absent-target test; restoring "Supersedes graph" fails the cycle test.
