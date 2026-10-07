# Prove publication identity lookups

[Pull request #86](https://github.com/melian-agent/melian/pull/86)’s publication tests now cover an absent author and an author who is also the publisher. They require no invented author permission and one permission request when the two identities match.

Invalid writer-trust inputs include null, a number and a string. Publication must return the typed notPublishable error before writing. Mutating these branches fails the corresponding assertion.
