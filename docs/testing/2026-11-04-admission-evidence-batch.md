# admission-evidence batch — dsh-agent-test-driver (RESULT: FAILED, not accepted)

STATUS: RAN ONCE — 101 tests, 95 pass, 6 fail, 0 skipped, 0 cancelled, 0 todo.
**Not accepted.** Any failure stops the batch: no fix, no retry, no second launch.

- Unit: `admission-evidence-batch-20261103T171140Z.service` (Type=exec), systemd-run rc 1,
  journal result `exit-code`, no residue (`--collect`; unit table empty afterwards).
- Raw evidence: `experiments/acceptance/admission-evidence-batch/runs/20261103T171140Z-admission-evidence-batch/`
  ([unit.log](experiments/acceptance/admission-evidence-batch/runs/20261103T171140Z-admission-evidence-batch/unit.log),
  [journal.txt](experiments/acceptance/admission-evidence-batch/runs/20261103T171140Z-admission-evidence-batch/journal.txt),
  [argv.txt](experiments/acceptance/admission-evidence-batch/runs/20261103T171140Z-admission-evidence-batch/argv.txt),
  [hashes-before.txt](experiments/acceptance/admission-evidence-batch/runs/20261103T171140Z-admission-evidence-batch/hashes-before.txt),
  [hashes-after.txt](experiments/acceptance/admission-evidence-batch/runs/20261103T171140Z-admission-evidence-batch/hashes-after.txt),
  [systemd-run.rc](experiments/acceptance/admission-evidence-batch/runs/20261103T171140Z-admission-evidence-batch/systemd-run.rc)).
- Batch runners: `experiments/acceptance/admission-evidence-batch/{payload.sh,run.sh,README.md}`.

## Command

```
systemd-run --wait --pipe --collect --unit=admission-evidence-batch-20261103T171140Z \
  --property=Type=exec --property=MemoryMax=768M --property=MemorySwapMax=0 \
  --property=TasksMax=32 --property=RuntimeMaxSec=120 --property=CPUQuota=50% \
  --property=WorkingDirectory=/root/dsh-ecosystem-spec/experiments/acceptance/admission-evidence-batch \
  -- /bin/bash .../admission-evidence-batch/payload.sh admission-evidence-batch-20261103T171140Z
```

Pre-launch preflight found no active `admission-evidence-batch-*` unit and no
competing `node --test` process; the GUI listener on 127.0.0.1:3080 was left running
throughout (read-only check, nothing stopped).

## Observed envelope (readback, not requested caps)

| Source | Observed |
| --- | --- |
| cgroup memory.max | `805306368` |
| cgroup memory.swap.max | `0` |
| cgroup pids.max | `32` |
| cgroup cpu.max | `50000 100000` |
| unit Type | `exec` |
| unit RuntimeMaxUSec | `2min` → resolved `120000000` µs (busctl readback `<unavailable>`, so the numeric value came from `systemctl show`, parsed) |

Gate (single sample, no polling): `MemAvailable=1314304 kB` (1283 MiB) vs required
`1228800 kB` (1200 MiB) → pass. Heap cap: `NODE_OPTIONS=--max-old-space-size=384`
(cap in effect; it is a ceiling, not observed heap usage).

## Workload

One `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-pid
--unshare-net --unshare-ipc --unshare-uts --die-with-parent` + `env -i` run of
`node --test --test-concurrency=1` over the four literal targets.

Result: node rc 1; tests 101, pass 95, fail 6, skipped 0, cancelled 0, todo 0;
duration 766.16 ms; workload wall 972 ms. Peak (observed): `memory.peak=44101632`
B (42.06 MiB), `pids.peak=20`, `memory.current` final 8126464 B,
`memory.events.local` all zero (no OOM). Journal: service runtime 1.046 s, CPU
time 528 ms, memory peak 42M (swap 0B).

## Driver-side result in this batch

`projects/dsh-agent-test-driver/tests/admission-evidence.test.js` — **all tests in
this file passed** in the single run; the adapter's 20-odd contract tests (closed
code list, injected validator handling, projection whitelist, immutability) are
among the 95 passing.

The 6 failures are outside this repository's test file:

- `experiments/admission-evidence-integration.test.mjs:538` — expected `[{code:'MISSING_ASSERTION',path:'cases[0]'}]`, actual path `cases[0].assertions`.
- `projects/dsh-compat-platform/packages/analyzer/tests/admission-diagnostics.test.js:121` — expected `['ADMISSION_CASE_FAILED']`, actual adds four `ADMISSION_COVERAGE_UNKNOWN`.
- same file `:146` — expected `['ADMISSION_CASE_REFUSED']`, actual adds four `ADMISSION_COVERAGE_UNKNOWN`.
- same file `:172` — expected `['ADMISSION_CASE_NOT_RUN']`, actual `[]`.
- same file `:406` — preserved hostile case id assertion failed (actual `undefined`).
- `projects/dsh-compat-spec/src/test/admission-evidence.test.js:651` — `ReferenceError: ISSUE_CODE_ORDER is not defined`.

Nothing in the source tree was edited by this batch.

## Hashes (before == after)

`hashes-before.txt` == `hashes-after.txt` for all seven inputs: spec module
`2bb37db7…`, platform module `df50d619…`, driver module `5826d293…`, spec test
`2c0c730b…`, analyzer test `fb11cdd3…`, driver test `7de2198d…`, integration test
`b1661a5b…`. Runner hashes unchanged: `run.sh` `32ebddff…`, `payload.sh`
`17c294af…` (identical before/after; the hash-mismatch non-acceptance condition
does not apply).

## Disclosure kept

The protocol author's earlier unrestricted `node --check src/admission-evidence.js`
(outside the envelope, self-reported exit 0) remains disclosed in the lane's
history. It is not a formal acceptance result and is not reproduced here; this
batch does **not** claim "no commands were run" for the lane. The only node
invocation in this batch is the single in-unit one above.

## Verdict

FAILED (batch-level) — not accepted. No retry, no fix, no inference of host
acceptance; a later attempt requires a new explicit GO after the source defects
are addressed.
