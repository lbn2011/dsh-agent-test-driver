# admission-evidence recheck — dsh-agent-test-driver (RESULT: PASS, 101/101)

STATUS: RAN ONCE — 101 tests, 101 pass, 0 fail, 0 skipped, 0 cancelled, 0 todo.
One authorized recheck after all authors froze their sources; no retry, no fix, no
limit change. The first attempt's report (`2026-11-04-admission-evidence-batch.md`,
101 tests / 95 pass / 6 fail) is preserved unchanged.

- Unit: `admission-evidence-batch-20261103T171615Z.service` (Type=exec), systemd-run rc 0,
  journal `Deactivated successfully`, no residue (unit table empty afterwards).
- Raw evidence: `../../../../experiments/acceptance/admission-evidence-batch/runs/20261103T171615Z-admission-evidence-batch/`
  ([unit.log](../../../../experiments/acceptance/admission-evidence-batch/runs/20261103T171615Z-admission-evidence-batch/unit.log),
  [journal.txt](../../../../experiments/acceptance/admission-evidence-batch/runs/20261103T171615Z-admission-evidence-batch/journal.txt),
  [argv.txt](../../../../experiments/acceptance/admission-evidence-batch/runs/20261103T171615Z-admission-evidence-batch/argv.txt),
  [hashes-before.txt](../../../../experiments/acceptance/admission-evidence-batch/runs/20261103T171615Z-admission-evidence-batch/hashes-before.txt),
  [hashes-after.txt](../../../../experiments/acceptance/admission-evidence-batch/runs/20261103T171615Z-admission-evidence-batch/hashes-after.txt),
  [systemd-run.rc](../../../../experiments/acceptance/admission-evidence-batch/runs/20261103T171615Z-admission-evidence-batch/systemd-run.rc)).

## Command (identical launcher, new unit and run dir)

```
systemd-run --wait --pipe --collect --unit=admission-evidence-batch-20261103T171615Z \
  --property=Type=exec --property=MemoryMax=768M --property=MemorySwapMax=0 \
  --property=TasksMax=32 --property=RuntimeMaxSec=120 --property=CPUQuota=50% \
  --property=WorkingDirectory=/root/dsh-ecosystem-spec/experiments/acceptance/admission-evidence-batch \
  -- /bin/bash .../admission-evidence-batch/payload.sh admission-evidence-batch-20261103T171615Z
```

Preflight: no active `admission-evidence-batch-*` unit, no competing `node --test`;
the 127.0.0.1:3080 listener was left untouched.

## Observed envelope (readback, not requested caps)

| Source | Observed |
| --- | --- |
| cgroup memory.max | `805306368` |
| cgroup memory.swap.max | `0` |
| cgroup pids.max | `32` |
| cgroup cpu.max | `50000 100000` |
| unit Type | `exec` |
| unit RuntimeMaxUSec | `2min` → resolved `120000000` µs (busctl `<unavailable>`; parsed from `systemctl show`) |

Gate (one sample, no polling): `MemAvailable=1282148 kB` (1252 MiB) vs required
`1228800 kB` (1200 MiB) → pass. Heap cap: `NODE_OPTIONS=--max-old-space-size=384`
(a ceiling, not observed usage).

## Workload result

- node rc 0; tests 101, pass 101, fail 0, skipped 0, cancelled 0, todo 0
- duration 790.25 ms; workload wall 865 ms
- observed `memory.peak=38969344` B (37.16 MiB), `memory.current` final 2502656 B,
  `pids.peak=20`, `memory.events.local` all zero (no OOM)

## Driver-side recheck

`projects/dsh-agent-test-driver/tests/admission-evidence.test.js` passed in the
first run and passes again; the driver module and driver test are byte-identical
across both runs, so nothing in this repository changed between the failed attempt
and this recheck.

The six first-run failures were all outside this repository (integration path
expectation, four platform fixture/diagnostics cases, and the spec test's missing
`ISSUE_CODE_ORDER` import); all six now pass. Author-reported fixes: missing import
in the spec test, corrected integration path expectation, four platform fixture
corrections, plus a hidden-field implementation fix with regression coverage. This
record confirms the observable outcome only, not the mechanism.

## Hashes (before == after)

Within this run, `hashes-before.txt` == `hashes-after.txt` for all seven inputs.
Actual post-freeze values:

| Input | sha256 |
| --- | --- |
| spec module | `2bb37db73350a416d542de6d36fedc66f4cb8cc4870a42116d5f9e528aae14c7` |
| platform module | `7485f7240026bd53d2dca97a24ecf56ca17b503a29485e39495285ba83d475ad` |
| driver module | `5826d293e9a2d95c6bac4c9eecd670957b2c09dc2219ca7046dc7232106a06f3` |
| spec test | `9432e3150474aa17795b7d811ccb2f6921ad911617c7a50ccab6c7aeb0dde2cb` |
| analyzer test | `736d86bd56e0bd430741ddbce21dd4b5da4b05b697b805b0b0ad446aa6cc9ccd` |
| driver test | `7de2198db8cb283d6877fedb29c859d3fcca844be5103350239caf22eaabe098` |
| integration test | `3788e916ac74c42878bb94ceeca12d0fef4633df6c64e67fcc31914cee63df54` |

Cross-run: driver module and driver test unchanged (`5826d293…`, `7de2198d…`); the
platform module, spec test, analyzer test and integration test were edited by their
authors before this recheck. That is the fix diff, not an in-run mutation. Runner
hashes unchanged (`run.sh` `32ebddff…`, `payload.sh` `17c294af…`).

## Disclosure kept

The protocol author's earlier unrestricted `node --check src/admission-evidence.js`
(outside the envelope, self-reported exit 0) stays disclosed in the lane history;
this batch does not claim "no commands were run" for the lane. The only node
invocation here is the single in-unit one above.

## Verdict

PASS — 101/101 under the proven envelope, no residue, hashes stable within the
run. Scope is this batch's four literal test files in one serial node
test-runner invocation; it is not a host-level acceptance of the wider lane.
