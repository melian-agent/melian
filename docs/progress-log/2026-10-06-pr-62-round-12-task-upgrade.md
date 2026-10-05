The twelfth review of [pull request #62](https://github.com/melian-agent/melian/pull/62) found the lens task's stored-shape upgrade inline in its migration callback. The callback now delegates to `LensTaskInput.upgrade`, and the task input carries its fields as an object.

The existing SQLite migration regression reopens a version-1 task with the current definition and checks that its findings retain the bare lens version. The upgrade still strips the run's level and leaves the checkpoint unchanged.

Pi Durable accepts only plain JSON objects as task inputs and migration results. Pass the task input's `toJSON()` result, rather than the class instance, at both boundaries.
