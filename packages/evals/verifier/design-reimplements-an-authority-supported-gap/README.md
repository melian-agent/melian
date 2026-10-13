# A stated gap that code supports excuses a hand-written answer that fails closed

The decoy beside `design-reimplements-an-authority-unsupported-gap`, from finding 2 of the review of record for [pull request #114](https://github.com/melian-agent/melian/pull/114). The trees are those of the lens golden `design-reimplements-an-authority-clean`. The claim says the hand-written range check refuses `^22`, which `semver` allows. `package.json` runs the check as `preinstall`, before `semver` is installed, and a refusal is the safe answer. The scripted judge asserts the instruction and refutes.
