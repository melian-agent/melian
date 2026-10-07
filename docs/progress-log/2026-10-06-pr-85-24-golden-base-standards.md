# Prove golden standards come from the base

[Pull request #85](https://github.com/melian-agent/melian/pull/85), thirteenth round, finding 95b6099eb75d4d8d. The nested standards test wrote identical rules to both commits, so its prompt assertion could not identify the source.

The fixture now gives base and head distinct rules. Every captured lens prompt must include the base rules and exclude the head rules. Loading standards from the head fails the assertion for the missing base rules. The original source passes. No design decision changes.
