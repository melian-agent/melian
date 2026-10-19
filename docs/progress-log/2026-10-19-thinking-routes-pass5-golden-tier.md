# Thinking routes: fill thinking-only golden tiers

[Pull request #157](https://github.com/melian-agent/melian/pull/157), pass 5, fixes round 1 finding `746b42be`.
A live golden tier with only thinking now takes the eval’s supplied model and keeps its configured level.
An existing model or accept route stays in use.

The regression first failed with `noAvailableModel` on heavy before any finder request.
All three routing cases pass after the fix and assert the fake provider’s model and high thinking body.
Hand mutations remove each routing guard, each optional chain and thinking preservation; each fails its direct test.
The scripted override also has a failing mutation.
The pass report under `tmp/m2/scratch-thinking/` records the exact replacements and full gate result.
The implementation plan’s status stays unchanged.
