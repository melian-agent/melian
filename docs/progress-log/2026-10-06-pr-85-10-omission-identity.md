# Guard omission state in lens task identity

[Pull request #85](https://github.com/melian-agent/melian/pull/85), sixth fix pass, finding f38a23cfa16b468b.

Removing standardsOmitted from the instruction fingerprint passed all eleven existing standards pipeline tests. The new repeat-review fixture adds an oversized nested carrier without changing the revision, source or retained sections. It requires a new lens task, another fake-model request, an ended check naming the omitted path and a not-reviewed verdict.

The fixture fails under the mutation: the completed task attaches and the verdict stays passed. Restoring the fingerprint field passes all twelve standards pipeline tests. No production change or design decision is needed.
