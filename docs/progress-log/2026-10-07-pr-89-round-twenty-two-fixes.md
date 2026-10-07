# test and docs: close round twenty-two on the tool manifest

For [pull request #89](https://github.com/melian-agent/melian/pull/89), round 22. Seven fixes, one commit each.

- `dbb8e5c5`: the protocol, hostname and port URL cases now fail on their guard, not on the path prefix. Deleting each guard fails its case.
- `4a7472af`: the skill test pins the rule that `melian tools fetch enola` runs only when the user asks. Dropping the rule fails.
- `f0a858ae` and `6e23fccf`: a review with `static.enola` disabled never opens caller context and sends no caller section to the lens. Opening unconditionally fails.
- `d1a7ae3b`: the scratch sweep removes dead scratch six directories below a cache root and keeps scratch seven deep. Moving the bound to 5 or 7 fails.
- `20a941d5`: the coverage cache misses a 16 MiB + 1 byte artifact and hits one of 16 MiB, and misses an indexed graph artifact from another compiler. Removing the size or compiler check fails.
- `258b1c0d`: the guideline and design say `#sarif` fails closed when normalisation drops results.
- `c4a3ef0c`: the plan keeps one status sentence for step 11 and links every pull request number.
