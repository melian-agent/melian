# Walkthrough fallback selection has regression coverage

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round nine, item 2: confirmed. Successful summary tests supplied one light model. None covered skipping an uncredentialed primary for a credentialed fallback.

The new test supplies two fake providers. The primary has no authentication; the fallback does. It checks that the fallback answers, a walkthrough is stored, and the indexed summary task records the fallback model for that revision. That durable task input is the walkthrough’s model provenance.

Validation: all walkthrough summary tests pass. No production change was needed.
