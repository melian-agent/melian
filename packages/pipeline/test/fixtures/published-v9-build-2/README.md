# Build 2's version-9 publication recording

`published.json` holds the `melian.published` snapshot that the build-2 code wrote at the commit it names.
That code is the head of the delta-rounds pull request, whose publication document is main's version 9.
A recording test drove `publishReview` against `fakeGitHub`, with fake models and memory storage.
It published revision 1, with a blocking finding and an advisory.
It then pushed a change to `src/config.ts` alone, ran a delta round that carried the blocking finding, and published again.
The recorder is kept outside the repository.
