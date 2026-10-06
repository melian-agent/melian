# Prove interrupted attribution can become unknown

[Pull request #86](https://github.com/melian-agent/melian/pull/86)’s crash tests now change publisher and author permissions from known values to unknown values separately. Resuming must supersede the interrupted task, name the changed field and omit the unknown permission from the new record.

Ignoring either change fails the supersession assertion. Existing cases still preserve a task whose previous attribution was unknown.
