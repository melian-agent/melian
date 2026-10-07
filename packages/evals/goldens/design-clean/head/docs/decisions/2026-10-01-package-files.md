# The package ships what its files list names

Choice: the published package contains the `files` list of its `package.json` and nothing else. Code in the package reads only what that list ships.

Why: the tarball is the product. A file present in a checkout and absent from the tarball works in every test and fails for every user.
