# Raw review harnesses must supply check records

Date: 2026-10-06

A caller passed a capable ReviewHarness.harness and silently skipped deterministic checks. The public API accepted it without records.

Automatic checks require the ReviewHarness wrapper. ReviewOptions now requires records when its harness is raw. Runtime calls without them throw ReviewError notInstalled before tasks start. An explicit empty array still opts out and preserves missing-record manifest behaviour. A wrapper without checkout retains that behaviour too.

The golden runner passes its wrapper. Raw test harnesses state their supplied-record intent. Regression tests refuse both a capable wrapper's raw harness and an environment-only harness, and confirm the wrapper runs checks.
