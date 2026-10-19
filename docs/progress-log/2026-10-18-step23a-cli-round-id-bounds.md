# Step 23a: CLI round ID bounds

A final diff review of [pull request 152](https://github.com/melian-agent/melian/pull/152) found missing CLI coverage. The tests passed with legacy and pull-storage IDs rejected, and with 17-character hashes accepted.

The follow-up reads a main-written legacy round and a pull-request round through the CLI. It also tests each 16-character hash at one character past its bound. Production code and original assertions stay unchanged.

The five narrow mutants survived the committed tests and fail the added cases. The unmutated suite passes all 26 CLI tests and type checking. The build now has 66 distinct hand mutations killed in 72 runs, including the six survivors killed after strengthening tests. These checks do not replace the host mutation round.

CI passed on the initial build for Node 22, 24 and 26. Both local whole gates passed 4,881 tests and failed the four known sandbox process tests. The local report records the gate and CI results for this follow-up separately. The plan status stays unchanged.
