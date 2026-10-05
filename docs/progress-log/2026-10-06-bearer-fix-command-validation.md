# Command bearer validation

Unlocking now checks the selected command bearer against the seven-minute cutoff. An unusable token fails with a named `CredentialError` before review storage opens, even when Pi holds a usable login. It cannot misstate the verdict's credential source.

A CLI test uses a fake OAuth provider and a usable Pi credential to prove the review opens no storage and calls no model. Doctor still names the source without running its command.
