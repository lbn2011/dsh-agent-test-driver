# 2026-11-05 — P0 entry-unit recheck (driver lane record)

STATUS: **RAN ONCE — PASSED.** 66 tests, **66 pass**, 0 fail, 0 skipped, 0
cancelled, 0 todo; unit exit 0. One authorized recheck, launched once, no retry.

This file was created as a NOT RUN skeleton **before** the launch and filled from
the run's own output afterwards; nothing in it was written from expectation.

Run date: the unit's UTC stamp is `20261104T160325Z`, which is
**2026-11-05 00:03 Asia/Shanghai** — hence the 2026-11-05 filename.

Raw evidence: `experiments/acceptance/p0-entry-unit/runs/20261104T160325Z-p0-entry-unit-407801-11268/`
— `argv.txt`, `hashes-before.txt`, `unit.log`, `systemd-run.rc`, `journal.txt`,
`hashes-after.txt`, `status.txt`, plus two empty `hashes-*.err` captures.

The failed 2026-11-04 attempt stays frozen at
`projects/dsh-agent-test-driver/docs/testing/2026-11-04-p0-entry-unit.md`; this
page does not revise it, and a passing recheck does not make that attempt pass.

## Unit

`p0-entry-unit-20261104T160325Z-407801.service` — one transient
`systemd-run --wait --pipe --collect`, `Type=exec`, from the **unchanged**
`experiments/acceptance/p0-entry-unit/run.sh`.

`status.txt`: `systemd_run_rc=0`, `hash_status=identical`, `acceptance_exit=0`,
`systemd-run.rc` = `0`. systemd's own final state: `Deactivated successfully`
(no failure, no timeout, no OOM kill).

## Command (executed verbatim)

```
systemd-run --wait --pipe --collect --unit=p0-entry-unit-20261104T160325Z-407801 \
  --property=Type=exec \
  --property=MemoryMax=768M --property=MemorySwapMax=0 \
  --property=TasksMax=32 --property=RuntimeMaxSec=120 \
  --property=CPUQuota=50% \
  --property=WorkingDirectory=/root/dsh-ecosystem-spec/experiments/acceptance/p0-entry-unit \
  -- /bin/bash /root/dsh-ecosystem-spec/experiments/acceptance/p0-entry-unit/payload.sh p0-entry-unit-20261104T160325Z-407801
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
| cgroup path | `/system.slice/p0-entry-unit-20261104T160325Z-407801.service` |
| `memory.max` | `805306368` |
| `memory.swap.max` | `0` |
| `pids.max` | `32` |
| `cpu.max` | `50000 100000` |
| unit `Type` | `exec` |
| `RuntimeMaxUSec` | reported `2min` → resolved `120000000` µs (`<unavailable>` as a bare number) |
| `MemAvailable` gate | `1738176 KiB` vs required `1228800 KiB` → pass (one sample) |
| node heap cap | `--max-old-space-size=384` |

`acc_capture_ok=yes`, `acc_workload_started=yes`: the workload really ran, no
refusal path.

Post-run cgroup counters: `memory.peak=65351680`, `memory.current` final
`31461376`, `pids.peak=20`, `memory.events.local` all `0` (`high 0`, `max 0`,
`oom 0`, `oom_kill 0`) — no memory pressure event. Workload wall 1019 ms.

## Workload (this lane's share)

`projects/dsh-agent-test-driver/tests/acceptance.test.js` — unchanged, and this
time the whole unit passed. The driver package is also reached indirectly by the
integration target's export-map check — an **ESM symlink into a temp
`node_modules`**, which is not a packed or installed package and is never
packaging or installation proof.

The runner prints aggregate totals only (66/66/0/0); per-file counts are not
printed and are not reconstructed here.

## Hashes (before == after)

23 selected inputs, individually hashed before and after: `hash_status=identical`,
both files sha256
`fa9f2a7cb3ebf4d738489ab66668d4077aa1551a9c597e2df181feb9390db46b`, no diff file.

**Delta against the first attempt (selected files only, not a full-tree diff):**

```
2c2
< 4845f0b854bc802425e9680431ce09253e6952fdf6e4d869a674a827bf74ee50  .../analyzer/tests/admission-cli.test.mjs
> 16c4ff8007f32d3d8c1f24474c28ef3fed15e27b4cf680d8339eddde3886b18b  .../analyzer/tests/admission-cli.test.mjs
```

Exactly one of the 23 differs: the fixed test. `run.sh`
(`d135bd4a1e36f0353c3f798ad438c561945f00737bd616ba419cffedde7a6378`) and
`payload.sh` (`59f05e421f345f968ef5c34f4bb71996465aad89a6e5a9f1d6550076e38f333e`)
are byte-identical to the first attempt — the runner and envelope were frozen.

This lane's digests in this run are unchanged from 2026-11-04:
`src/acceptance.js` `332b05e8…`, `src/admission-evidence.js` `5826d293…`,
`src/acceptance.d.ts` `f4d3bb53…`, `src/admission-evidence.d.ts` `60559f49…`,
`package.json` `a84b54a0…`, `tests/acceptance.test.js` `f362ac64…`.

Selected witness, **not** a closure: node builtins, non-loaded sibling modules and
the analyzer's `tests/helpers/*` stay outside it.

## Disclosure kept (lane-relevant)

- The driver-lane author **violated the "no commands" rule** while preparing the
  2026-11-04 slice: read-only `cat`, `wc`, `grep` and a later `ls -la` outside the
  envelope. No record claims a command-free authoring history.
- The platform-lane author expanded the hashed surface to `src/index.d.ts`; the
  Lead accepted it.
- The preparing author of the slice ran one read-only `pwd && ls`; this recheck's
  author likewise used shell only for the authorized launch, the readback and the
  selected-file hash comparison.
- The historical artifact read by the integration target
  (`.../runs/20261104T151523Z-admission-loader-real-406112-8304/out/derived-document.json`,
  `29065c09…`) is an **input**: consuming it is not new host or Loader evidence,
  and this unit did not re-run the loader that produced it.
- The export-map check is an ESM symlink, not a packed installation.
- `run.sh`'s header still reads `STATUS: UNEXECUTED`; runners were frozen, so it
  was left untouched — run directories are the authoritative status.
- No build, install, network, host boot, plugin runtime or browser was involved.

## Verdict

**PASSED — single authorized recheck.** 66/66 in one serial in-unit invocation,
exit 0, envelope as requested, gate passed, 23 selected inputs unchanged across
the run, and the only input that differs from the first attempt is the corrected
test. The result is one sample: it establishes nothing about flakiness, and the
2026-11-04 failure record stands as written.
