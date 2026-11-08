# Raw acceptance runs — index only

No raw batch directories are committed here. Raw evidence for this project's
acceptance batches was produced under the **parent checkout**, so it was never
stored in this repository. This file exists so a reader who follows a link into a
missing `runs/` path can see where the bytes are.

## Copied to external storage

The parent checkout's `experiments/acceptance/runs/` — 8 batch directories — was
copied, unmodified, to
`/data/dsh-ecosystem-test-artifacts/experiments/acceptance/runs/<run-id>/`,
mirroring the parent-relative path exactly. So
`experiments/acceptance/runs/20261107T195433Z-driver-config-contract-batch-596697-7991/`
resolves at
`/data/dsh-ecosystem-test-artifacts/experiments/acceptance/runs/20261107T195433Z-driver-config-contract-batch-596697-7991/`,
the batch behind [the config-contract record](../2026-11-08-driver-config-contract.md)
(93 TAP tests, 93 pass).

The kit repository's own `docs/testing/runs/` (12 directories, 124 files) is
externalised the same way at
`/data/dsh-ecosystem-test-artifacts/projects/dsh-plugin-kit/docs/testing/runs/`.
That is where the manifests named in
[the history-conversion record](../2026-11-04-admission-history-conversion.md)
live.

A per-file manifest, `/data/dsh-ecosystem-test-artifacts/SHA256SUMS` (284 entries
across the three copied trees), was verified with
`sha256sum -c --quiet /data/dsh-ecosystem-test-artifacts/SHA256SUMS`.

That external directory is **local storage on the maintainer's machine, not a
downloadable resource**: not on GitHub, not in any archive, and not reachable by
someone who clones this repository. It preserves evidence outside Git; it is not a
reproduction input.

## Referenced but *not* copied

Two parent experiment trees cited by records here were outside the copy scope and
exist only in the parent checkout:

- `experiments/acceptance/admission-evidence-batch/runs/` — cited by
  [the admission-evidence batch record](../2026-11-04-admission-evidence-batch.md)
  and [its recheck](../2026-11-04-admission-evidence-recheck.md);
- `experiments/acceptance/admission-history-conversion/runs/` — cited by
  [the history-conversion record](../2026-11-04-admission-history-conversion.md).

Links into those do not resolve in a standalone checkout, and this index does not
claim that every piece of evidence behind these records has been externalised.
The external copy covers the three trees named above only; it is **not a complete
archive of the parent checkout's experiment history**. Other parent experiment
trees remain local to the maintainer's machine and are not distributed.

## Sibling repository dependency

This project's **tests** reach into a sibling repository:
`tests/acceptance.test.js:29` imports
`CASE_CATALOG` from `../../dsh-compat-spec/src/admission-evidence.js`. So
`projects/dsh-compat-spec` must be checked out next to this repository for the
suite to run, and that is why these numbers cannot be reproduced from this
repository alone. The shipped adapter `src/admission-evidence.js` takes
the validator injected, and its test checks that this one module contains no
`import` at all — a source-text check of one file, not a dependency graph of the
package.

## Parent harnesses are not distributed

The acceptance harnesses — systemd envelope, flock, hash accounting, payload
stages under `experiments/acceptance/<batch>/` — live in the parent checkout, are
not part of any of the four repositories, and are not part of the external
evidence root either, which holds run *outputs* only. A rerun would require
reconstructing the harness.

## Reading a record

Numbers quoted in `docs/testing/*.md` are **historical**: measured in the runs
named there, on the bytes recorded there. Nothing was re-run for this index.
