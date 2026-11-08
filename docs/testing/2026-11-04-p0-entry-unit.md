# 2026-11-04 — P0 entry-unit (driver lane record)

STATUS: **RAN ONCE — FAILED** (66 tests: 65 pass, 1 fail, 0 skipped; unit exit 1).
The one failing test belongs to the platform analyzer target, not to this lane —
no test in `projects/dsh-agent-test-driver/tests/acceptance.test.js` failed. No
retry, no fix, no second launch.

Raw evidence: `experiments/acceptance/p0-entry-unit/runs/20261104T155634Z-p0-entry-unit-407485-22066/`
— `argv.txt`, `hashes-before.txt`, `unit.log`, `systemd-run.rc`, `journal.txt`,
`hashes-after.txt`, `status.txt`.

Slice contract, envelope rationale and process disclosures:
`experiments/acceptance/p0-entry-unit/README.md`.

## Unit

`p0-entry-unit-20261104T155634Z-407485.service` — one transient
`systemd-run --wait --pipe --collect` invocation, `Type=exec`, launched once from
`experiments/acceptance/p0-entry-unit/run.sh`. systemd's own report:
`Finished with result: exit-code`, `Main processes terminated with: code=exited,
status=1/FAILURE`, service runtime 1.038 s, CPU time 434 ms, memory peak 68.5 M
(swap 0 B).

`status.txt`: `systemd_run_rc=1`, `hash_status=identical`, `acceptance_exit=1`.

## Command (executed verbatim)

```
systemd-run --wait --pipe --collect --unit=p0-entry-unit-20261104T155634Z-407485 \
  --property=Type=exec \
  --property=MemoryMax=768M --property=MemorySwapMax=0 \
  --property=TasksMax=32 --property=RuntimeMaxSec=120 \
  --property=CPUQuota=50% \
  --property=WorkingDirectory=/root/dsh-ecosystem-spec/experiments/acceptance/p0-entry-unit \
  -- /bin/bash /root/dsh-ecosystem-spec/experiments/acceptance/p0-entry-unit/payload.sh p0-entry-unit-20261104T155634Z-407485
```

Inside the unit, one serial invocation (quoted from `unit.log`):

```
acc_workload_argv=node --test --test-concurrency=1 \
  /root/dsh-ecosystem-spec/projects/dsh-agent-test-driver/tests/acceptance.test.js \
  /root/dsh-ecosystem-spec/projects/dsh-compat-platform/packages/analyzer/tests/admission-cli.test.mjs \
  /root/dsh-ecosystem-spec/experiments/p0-acceptance-integration.test.mjs
```

## Observed envelope (readback, not requested caps)

| Field | Readback |
| --- | --- |
| cgroup path | `/system.slice/p0-entry-unit-20261104T155634Z-407485.service` |
| `memory.max` | `805306368` |
| `memory.swap.max` | `0` |
| `pids.max` | `32` |
| `cpu.max` | `50000 100000` |
| unit `Type` | `exec` |
| `RuntimeMaxUSec` | `2min` → resolved `120000000` µs |
| `MemAvailable` gate | `1681544 KiB` vs required `1228800 KiB` → pass (sampled once) |
| node heap cap | `--max-old-space-size=384` (`acc_node_options`) |

`acc_capture_ok=yes` and `acc_workload_started=yes`: no refusal path was taken, so
the workload really ran.

Post-run cgroup counters: `memory.peak=71917568`, `memory.current` final
`36827136`, `pids.peak=20`, `memory.events.local` = `low 0 high 0 max 0 oom 0
oom_kill 0 oom_group_kill 0` — no memory pressure event fired.

## Workload (this lane's share)

`projects/dsh-agent-test-driver/tests/acceptance.test.js` — contract tests over
`judgeAdmissionAcceptance` / `ACCEPTANCE_CODES` with the catalog supplied by the
test itself, plus a purity assertion that re-reads `src/acceptance.js` as text.

Its tests passed. The driver package is also exercised indirectly by the
integration target, which imports `dsh-agent-test-driver/acceptance` and
`dsh-agent-test-driver/admission-evidence` through the package export map from a
private temp probe root — an ESM symlink into a temp `node_modules`, which is
**not** a packed or installed package and must not be described as installation
evidence.

This runner records only the aggregate `node --test` totals (66 / 65 pass / 1 fail
/ 0 cancelled / 0 skipped / 0 todo, duration 530 ms); per-file counts are not
printed by this invocation and are not reconstructed here. What is recorded
exactly is the failing-test section, which names one test at
`projects/dsh-compat-platform/packages/analyzer/tests/admission-cli.test.mjs:905`
and no test in this lane.

## Hashes (before == after)

23 selected inputs hashed individually before and after the unit:
`hash_status=identical`, and no `hashes-diff.txt` was produced. Full list and
digests: `hashes-before.txt` (byte-identical to `hashes-after.txt`).

This lane's share of that witness:

- `projects/dsh-agent-test-driver/src/acceptance.js` — `332b05e8f0f30d20585ba37cba6e56d1888aae62576c17943282f5ceb5f223d3`
- `projects/dsh-agent-test-driver/src/admission-evidence.js` — `5826d293e9a2d95c6bac4c9eecd670957b2c09dc2219ca7046dc7232106a06f3`
- `projects/dsh-agent-test-driver/src/acceptance.d.ts` — `f4d3bb53ebc2ae8806f3def40d186765e83f0d7dfa59de9bc8c821f4a0432ac7`
- `projects/dsh-agent-test-driver/src/admission-evidence.d.ts` — `60559f49f0c5893995412966b42b8270376305c1f2c071b91e02ff86da16cf32`
- `projects/dsh-agent-test-driver/package.json` (export map) — `a84b54a00ad6c2bc7d06dbc320ff698184bd0de23bcbe272fe7ab4bd3a864191`
- `projects/dsh-agent-test-driver/tests/acceptance.test.js` — `f362ac6497ed3092c179a6cea6ce465015e9b7abdece63314dbf4297b570d0d0`

This is a **selected witness, not a closure**: node builtins, driver modules the
three targets never load, and the analyzer's `tests/helpers/*` fixtures are
deliberately outside it, so a deeper unlisted change could not be caught.

## Disclosure kept (lane-relevant)

- The driver-lane author **violated the "no commands" rule** while preparing this
  work: read-only `cat`, `wc` and `grep` outside the envelope, plus a later
  read-only `ls -la`. No unit, test, build or acceptance evidence came from them,
  but they were commands. Nothing in this record claims the authoring history was
  command-free.
- The platform-lane author **expanded scope** to `src/index.d.ts`; the Lead
  accepted it, so it is inside the witness and the expansion stays disclosed.
- The preparing author of the slice also ran one read-only `pwd && ls` before
  switching to file tools; disclosed for the same reason.
- The historical artifact the integration target reads
  (`.../runs/20261104T151523Z-admission-loader-real-406112-8304/out/derived-document.json`,
  sha256 `29065c0996d25467065a818832eff78c2fc2bd08b112130362bc387755fa5109`) is an
  **input**, not new runtime evidence: this unit did not re-run the loader that
  produced it.
- `HEAD` is not a version of these inputs: several hashed paths are untracked or
  modified working-tree files, so the digests above are the only version
  identifier, not a commit.
- No real Loader, host boot, plugin runtime or browser was exercised by this lane;
  no build, install or network step ran. Tests wrote only under `/tmp`
  (`TMPDIR=/tmp`) and cleaned up their own temp roots; the only artifacts written
  to the repository are the runner's own run-directory files.

## Verdict

**NOT ACCEPTED — FAILED.** The unit exited 1 because one test in the platform
analyzer target failed (see
`projects/dsh-compat-platform/docs/testing/2026-11-04-p0-entry-unit.md`). This
lane's own tests all passed, but a single-unit result is not divisible: the
slice's outcome is FAILED, the failure was not fixed, and nothing was retried.
