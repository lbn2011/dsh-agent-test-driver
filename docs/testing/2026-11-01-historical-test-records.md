# Historical test records — dsh-agent-test-driver (backfilled)

Date of backfill: 2026-11-01 (Asia/Shanghai). Status: documentation only.

This file backfills the driver's execution history. It exists beside — and does not
replace — [acceptance-report.md](../../acceptance-report.md) and
[test-report.md](../../test-report.md), which remain the direct records of their own
runs. Everything below describes a code snapshot from 2026-11-01; **no run was repeated
for this documentation backfill** — every number is transcribed from the retained reports
named in §6, not reproduced. §9 appends the later real-host guard stages that post-date
this file's first version. The failing and malformed runs are kept next to the passes.

## 1. How to read this record

Two different suites appear here and must not be merged:

- the **driver suite** — eight test files under `projects/dsh-agent-test-driver/tests/`:
  `entry`, `entry-lifetime`, `provenance`, `fixture-binding`, `core-agent-isolation`,
  `core-ownership-context`, `invoke-tool`, `loader-ops`;
- the **bundle-one suite** — `experiments/low-memory-build/test/bundle-one.test.mjs`, a
  different package that is **not** this one. Its red result is recorded here only
  because it was executed in the same acceptance session and is easy to misattribute.

## 2. Driver suite ledger (same eight files throughout)

| # | Unit | Tests | Pass | Fail | Exit | Bound actually enforced | Tier |
|---|---|---|---|---|---|---|---|
| 1 | `drv-diag-1` | — | — | — | — | — | **void** (see §3) |
| 2 | `drv-diag-2` | 209 | 189 | **20** | 1 | 768M, 120 s | bounded unit |
| 3 | `drv-postfix` | 209 | 206 | **3** | 1 | 768M, 120 s | bounded unit |
| 4 | `acc-driver-8` | 209 | 209 | 0 | 0 | 768M, 120 s; peak 51.5M | bounded unit |
| 5 | `drivergres-20261101t094341z` | 216 | 216 | 0 | 0 | **wall-clock cap not in force** — `Type=oneshot` ignores `RuntimeMaxSec` (see §3); memory/swap/PID/CPU controls were not shown absent | bounded except wall time |
| 6 | `drivergresbounded-20261101t094835z` | 216 | 216 | 0 | 0 | `Type=exec`, 120 s honored; peak 53.8M | bounded unit |

Row 4 detail: `tests 209 / suites 9 / pass 209 / fail 0 / cancelled 0 / skipped 0 /
todo 0`, duration 1596.7 ms, service runtime 1.848 s, CPU 874 ms, peak 51.5M. The TAP
tree parses to 218 entries (185 top-level + 33 nested) while the summary line says
`# tests 209` — the nesting is why counting `ok` lines disagrees with the summary.

Row 6 detail: 17:48:35 → 17:48:37 +08:00, `duration_ms 1628.095227`, service runtime
1.950 s, CPU time 945 ms, `memory.peak` 56 446 976 B (53.8 MiB), `pids.peak` 21 of 32,
`oom_kill 0`, Node rc captured via `${PIPESTATUS[0]}` = 0, `systemd-run` rc = 0. CPU
quota engaged but cost nothing measurable (`nr_periods 20`, `nr_throttled 17`,
`throttled_usec 1078473`; 1628 ms vs 1680 ms uncapped).

## 3. Failures, void runs and an invalid envelope — all retained

**Row 1 is not evidence.** Passing the directory `tests/` instead of the explicit file
list fails with `Cannot find module '.../tests'`. That attempted run is counted nowhere.

**Row 2 — 20 failures, root-caused (17 test-fixture defects, 1 production bug).** The
split that survived inspection: `makeRealCore` omitted `tools`, so five integration
tests got `TypeError: tools must be the native tools service (ctx.tools)` and the core
reported `DRIVER_HOST_UNAVAILABLE`; `status()` was mispinned against `NOT_READY` when it
actually answers `ok: true, armed: false` before the arm (`driver-core.js:920-936`);
`refuseFrom()` preserves the probe's code (`driver-core.js:157-159`), so an unarmed host
says `PROVENANCE_NOT_TEST_HOST`, and `DESCRIPTIONS` has no sentence for fine-grained
`PROVENANCE_*` codes, falling back to `the driver refused this operation`
(`driver-core.js:120`); a source-regex assertion matched a docstring at
`src/index.js:17` instead of the arm (fixed to `armAt 3956 < regAt 3993` after
comment-stripping); fixed microtask counts waited 2 hops where 3 are needed; two
ownership fixtures passed no positional module and were refused earlier as
`TOOL_OWNERSHIP_UNMAPPABLE`; and the `entry-lifetime` vocabulary list omitted
`TOOL_OWNERSHIP_UNMAPPABLE`. The single verified **production** defect: an
already-cancelled invocation still dispatched, building an invoker and leaving
`invoke:<tool>` unsettled so one abandoned call refused every later call — fixed with a
pre-dispatch guard returning the **existing** `DRIVER_BUSY` code, no code invented or
renamed.

**Row 3 is red, not green.** 206/209 was taken *before* three remaining fixes (#19,
#71, #75) were corrected, because the task budget — one diagnostic run plus one
post-fix rerun — was already spent. Those three corrections were verified individually
against the running code; no further suite run was performed at that point. No failing
assertion was ever deleted, skipped or softened.

**Row 5 — an invalid envelope is not a pass.** 216/216 passed with rc=0 in 1.68 s, but
the journal says, verbatim:
`drivergres-20261101t094341z.service: RuntimeMaxSec= has no effect in combination with Type=oneshot. Ignoring.`
`Type=oneshot` both ignores `RuntimeMaxSec` and treats normal exit as success, so the
120 s bound **never existed** — the run was unbounded in wall time and an overrun would
not have failed the unit. **Precision, so this is not over-read:** *wall time* is the
only control that failed. `Type=` does not disable `MemoryMax`, `MemorySwapMax`,
`TasksMax` or `CPUQuota` — those cgroup controls were declared for the same envelope and
remained applicable; they were simply never read back inside that unit. "No wall-clock
bound" must **not** be restated as "no resource limits" or "no envelope at all". Its artifacts are preserved unchanged
(`driver-regression-20261101t094341z.log`, 18 224 B; `.log.exit` = `0`). Only the
envelope was corrected (`--service-type=exec`); workload, files and isolation flags were
identical, one launch only. Verified inside the unit afterwards: `memory.max`
805306368, `swap.max` 0, `pids.max` 32, `cpu.max` `50000 100000`, `Type=exec`,
`RuntimeMaxUSec=2min`, and zero `… Ignoring.` lines.

**Bundle-one (not this package) — did not pass.** `node --test
experiments/low-memory-build/test/bundle-one.test.mjs` gave 38 tests / 32 pass / **6
fail**, exit 1, peak 33.7M. All six are one family: a fatal `realpathSync` failure on
the fixture root `/checkout` pre-empts the intended typed refusal, e.g.
`bundle-one: unexpected: Error: ENOENT: no such file or directory, lstat '/checkout'`
at `main (…/src/bundle-one.mjs:588:18)` from `bundle-one.test.mjs:468`, against an
expected `/bundle-one: package-not-a-member:/`. Whether this is a harness path issue or
a `src/bundle-one.mjs` defect was **not investigated** (out of scope, no edits allowed).
Execution stopped after the two authorized commands; nothing was fixed.

## 4. Deviations and integrity notes

- **Isolation was genuinely read-only.** Row 6: `find projects/dsh-agent-test-driver
  -newermt '2026-11-01 17:48:30' -type f` returned empty; the workload ran under
  `--ro-bind / /`.
- **No builds, installs, servers or delegation** were used in rows 2–6.
- **Earlier claims corrected, not deleted:** a prior report's failure attributions were
  guesses and were replaced by the checked version now in
  [test-report.md](../../test-report.md); the earlier text is described there rather
  than quietly dropped.
- **Acceptance-report honesty point kept:** the bundle-one failure contradicts any
  broader "all green" reading of that session, and the report says so.

## 5. Provenance gaps (do not invent these)

- **Code revision at run time: NOT RECORDED** for rows 1–5. No commit accompanies those
  runs. This project's own repository has an initialized but commit-less git history
  (`git rev-parse --verify HEAD` → "Needed a single revision") and the parent workspace
  tracks no file under `projects/`, so no result here can be pinned to a revision or
  attributed to the current tree. **Two limits on that inference:** (a) the unborn HEAD
  explains only why no commit was *available at run time*; it does not establish that no
  per-file source digest was ever computed or retained elsewhere. A missing recorded
  revision is a gap in this record — it is **not** evidence that all source hashes are
  absent, and no such claim is made here. (b) Digests taken from the files present today
  are not run-time digests and must never be backfilled into these rows; equally, a commit
  that happens to exist in an enclosing repository does not retroactively pin a run whose
  tree state was never captured.
- **Row 6 did record per-file sha256** for all eight test files — e.g.
  `tests/entry.test.js` `5e2c9fa2…0b70db`, `tests/invoke-tool.test.js`
  `2be98f86…009fc8`, `tests/loader-ops.test.js` `844dc526…b0c0`, `tests/entry-lifetime.test.js`
  `33423025…2c22`, `tests/provenance.test.js` `4f0d2e4a…9559`, `tests/fixture-binding.test.js`
  `97b52ce1…4e0f`, `tests/core-agent-isolation.test.js` `3c6873d3…c0f1`,
  `tests/core-ownership-context.test.js` `4f87313e…2a6a`. It does **not** cover
  `src/`, so the source revision remains unpinned even there.
- **209 vs 216 is not a regression or a fix.** The file list is the same eight files;
  the count changed between sessions, so the two totals annotate different code
  snapshots. Neither number may be used to claim the other suite is current.
- **Wall time / peaks for rows 2–3:** recorded as service runtime and cgroup peak in
  [test-report.md](../../test-report.md) (49.2 M and 42.9 M respectively); exit code 1
  for both. Row 4's caps were verified but its exact requested-vs-observed table is not
  restated in the acceptance report.
- **Node version:** `v24.21.0` appears in the recorded argv of rows 3–6; rows 1–2 do not
  state it.

## 6. Links to the original reports

Relative from this file; targets outside this repository are in the **parent
workspace** and are traceability only, not portable artifacts.

- [acceptance-report.md](../../acceptance-report.md) — row 4 and the bundle-one result; also the explicit limitation that this proves the suite only inside that sandbox envelope, not native host execution.
- [test-report.md](../../test-report.md) — rows 2–3, the 218-entry/209-test parsing note, the root-caused 20 failures and the single production fix.
- [Driver regression, bounded (final)](../../../../experiments/low-memory-build/reports/driver-regression-bounded-final.report.md) — rows 5–6, the `Type=oneshot` defect and the corrected envelope.
- [low-memory-build reports README](../../../../experiments/low-memory-build/reports/README.md) — the serial compile campaign; see §4 for the unauthorized `--force` incident.
- [host-smoke refusal (guard) record](../../../../experiments/low-memory-build/reports/host-smoke-refusal.md) — a later real-host guard run, 7 assertions, `MemoryMax=1536M`, peak 185.6M.

## 7. Resource incident relevant to this history (recorded, not excused)

In the same low-memory-build campaign, forced whole-graph runs were executed **against
an explicit prohibition**: `--force` runs reached 115/317 steps (591.6 s, 846.5 M peak)
and 276/317 steps (1682 s, 905.3 M peak). The Lead explicitly stopped
`lmb-force-rest-5983.service` and `lmb-force-rest2-1793471000.service`, and those stops
must **not** be attributed to an automatic timeout. Those forced runs are **not
accepted verification**; their counts and resource values are worker-reported. Partial
forced output may have overwritten artifacts from the accepted incremental run
(317/317 steps, 97.7 s of step time, 643.6 M peak, `"compilation": "not-claimed"`), and
the remaining 41 roots (steps 277–317) have incremental evidence only. The claimed
1900–2000 s estimate is not a completed-run measurement. The runner's own planning
tests were separately green: `node --test test/compile-serial.test.mjs` → 24/24, 5.5 s,
289.8 M peak.

## 8. Checklist for future test records (mandatory)

Any subagent that executes tests for this repository must write its outcome into a new
dated file under `docs/testing/` and satisfy every item below. The Lead reviews it
before the result is cited.

1. **Outcome first.** `PASS`, `FAIL`, `REFUSED` or `NOTRUN` before any narrative.
   Written-but-unexecuted cases are `NOTRUN`, never pass.
2. **Never replace red with green.** Append attempts; never edit an older row. Rows 2,
   3 and 5 stay visible next to the passes.
3. **Name the exact workload**, file by file. Passing the directory instead of the file
   list is a void run, and a different package's suite (bundle-one) is labelled as such.
4. **Envelope validity is part of the result.** Record `Type=exec` explicitly and quote
   any `… Ignoring.` journal line; a run under an unenforced bound is `UNBOUNDED`, not
   `PASS`.
5. **Timestamps with time zone** and the transient unit name; start and end.
6. **Exact commands, verbatim** — full `systemd-run` argv, bwrap flags, `env -i` set,
   Node argv. Unknown from evidence → "not retained", never reconstructed.
7. **Caps requested vs observed**, read inside the unit: `memory.max`,
   `memory.swap.max`, `pids.max`, `cpu.max`, `RuntimeMaxUSec`; plus `memory.peak`,
   `pids.peak`, `oom_kill`, throttle counters.
8. **Revision:** commit + dirty state, or per-file sha256 for tests **and** the `src/`
   files touched. If uncaptured, say so — the row is unpinnable.
9. **Counts and exit codes** exactly as printed, including skipped/cancelled/todo, and
   note when TAP nesting makes a naive `ok` count disagree with the summary.
10. **Raw logs retained, by path and size**, including the `.exit` capture; otherwise
    mark "summary only".
11. **Scope and tier:** fake/double-driven unit tests are not proof a real host mounts
    the plugin. State the uncovered surfaces (host `Config` parsing, schema validation of
    `defineTool`/`ctx.tools.register`, the real guard pipeline, cgroup kill of an
    over-long native call).
12. **Deviations disclosed**, including budget exhaustion, partial fixes verified only
    individually, and any out-of-envelope host probe.
13. **Refusals separate from failures**, and no cross-attribution: never attribute an
    old suite result to newer code, and never let a green run imply another package or
    module passed.

## 9. Appended later — real-host guard stages and the two scopes they separate

Appended 2026-11-01. These five rounds post-date rows 1–6 and are **not** part of the
216-test suite: they are integration/host stages. They must never be added to the suite
counts, and none of them re-runs the eight test files. Rows 1–6 stay the suite ledger.

### 9.1 One distinction that the earlier rounds could not make

Three different refusal gates were exercised, and they are not interchangeable:

| Scope | Mechanism | Code / evidence | Proven by | **Not** proven by it |
|---|---|---|---|---|
| **agent-absent gate** | `findAllowedTool` runs first (`driver-core.js:1122`), then the agent gate (`:1128`) | `POLICY_NO_TURN` | the 16:45 guard run — `test_driver_invoke_tool` refused with exactly that code and the fixture body never ran | nothing about ownership or guard policy |
| **ownership scope** | the driver's own ownership port, fixed `ownershipUnavailable()` deny (`driver-core.js:1152`) | `DRIVER_TOOL_OWNERSHIP_UNVERIFIED` | agent-guard stage A on a real `AgentLoop.create(SessionId(...))` agent (17:22 and 17:40) | that a real ownership **allow** path works — the port is still the fixed deny |
| **native guard scope** | the host's native guard gate, not the driver | `GUARD_DENIAL_REASON` text `Error: <reason>`, `info: null` (a guard denial manufactures no info code) | agent-guard stage B (17:22 and 17:40): `bodyCalls: 0` while `guardObserved: 2`, `guardSawProbe: 1` | any driver-side policy behaviour; the guard is a different layer |

So: the 16:45 run proves **agent absence only** (it says so itself: "not ownership
evidence and not guard-policy evidence", and `DRIVER_TOOL_OWNERSHIP_UNVERIFIED` is
unreachable without a real Agent, remaining covered by the driver's own unit tests).
Stage A proves the **ownership** refusal; stage B proves the **native guard** denial.
Quoting one for the other is a category error.

### 9.2 The rounds, in order

**16:45:07 +08:00 — guard run, GREEN, 7 assertions.**
[host-smoke-refusal.md](../../../../experiments/low-memory-build/reports/host-smoke-refusal.md),
unit `hostsmoke-guard-20261101t1622z-a7f3.service`, pinned build-checkout
`ce7073d51254c26cd63b22a60835b8f948deb447` (clean before and after), log
`host-smoke-refusal-unique.log` (67 lines). `# guard-rc=0`, unit `success` in 2.999 s,
CPU 1.966 s, **memory peak 185.6 M**, swap 0 B, `systemd-run rc` 0;
`MemoryMax=1536M MemorySwapMax=0 TasksMax=32 RuntimeMaxSec=120`, `bwrap --ro-bind / /`,
exactly one rw bind (`/data/tests`). All seven assertion ids `ok:true`:
`fixture-tool-via-native-executor`, `driver-armed`,
`declared-entry-is-include-prefixed`, `invoke-refused-agent-absent`,
`unlisted-target-mutation-refused`, `unconfigured-entry-mutation-refused`,
`fixture-entry-survives-refusals`. Honest limits recorded there and kept here: the target
was **handwritten**, so it says nothing about plugin-kit output; the two mutation refusals
share one enum (`POLICY_TARGET_NOT_ALLOWED`), so the entry-gate case is a code-flow
argument, not a distinct code; and the guard echoes assertion ids but not the refusal
receipts.

**17:22 — agent-guard: both stages green, envelope RED (timeout).**
[agent-guard-20261101t1622z-a7f3.report.md](../../../../experiments/low-memory-build/reports/agent-guard-20261101t1622z-a7f3.report.md),
unit `hostsmoke-agentguard-20261101t1622z-a7f3`. The stage evidence is real: on a real
`AgentLoop.create` agent, `code: DRIVER_TOOL_OWNERSHIP_UNVERIFIED` matched the expected
code, `POLICY_NO_TURN` was absent, `messageLength 99`, public receipt
`{ok:false,code,message}` with no private maps and no direct body call. Stage B:
`bodyCalls: 0`, `guardObserved: 2`, `guardSawProbe: 1`, `error.message` equal to the exact
reason, `nativeDenialText` = `Error: agent-guard: stage B denies this tool at the native
guard gate`, `nativeErrorInfo: null`. But the **unit** is `timeout`
(`code=killed, status=15/TERM`, runtime 2 min 71 ms, CPU 2.304 s ≈ 118 s idle, peak
202.7 M) and **Node rc is unknown** — bash never reached `# agent-guard-rc=`, because
`runner.mjs` held no `process.exit` and never called `ctx.fiber.dispose()`, while
`driver/host.mjs:276` states the caller owns disposal. The 90 s internal deadline could
not catch a leak that happens after the work promise settles. Nothing was retried.

**17:30 — lifecycle fixed, stages NOT re-executed.**
[agent-guard-lifecycle-teardown.md](../../../../experiments/low-memory-build/reports/agent-guard-lifecycle-teardown.md),
unit `hostsmoke-agentguard-20261101t1730z-2012.service`. The root dispose was called and
awaited to settlement (`teardown.attempted/awaited/ok: true`, 27 ms) and the unit reached
its own status — `exit-code`, `code=exited, status=1/FAILURE`, 3.050 s, peak 178.9 M —
instead of being killed at 120 s. But `stages: {}`: it failed in `agentLoop.create` with
`SessionAlreadyExistsError` (session `"agent-guard-stage-a"` already exists) because the
staged store still held the 17:22 sessions, so **the stage greens are still only as of
17:22**. Two honest limits: `residualResources` reported `["FSEventWrap", "FSReqPromise"]`
and the runner refused to call that a pass — and it is **unknown** whether those two would
have kept the loop open on their own; and `dispose()` settling is not proof that each
mounted plugin's teardown finished (no post-condition probe of the service registry was
added). The `node --check runner.mjs` syntax check ran **outside** the envelope.

**17:39 — aborted launch, no workload.**
Unit `…1739Z-4952` died inside bwrap in 28 ms (`bwrap: setenv failed`, 8 ms CPU): the argv
passed `--setenv VAR=VALUE`, which `setenv(3)` rejects. A launcher defect, disclosed rather
than dropped, and it consumed one of the two launches despite the one-launch limit.

**17:40 — stage re-assertion: A + B + teardown green, natural exit.**
[agent-guard-stage-reassertion.md](../../../../experiments/low-memory-build/reports/agent-guard-stage-reassertion.md),
unit `hostsmoke-agentguard-20261101t1740Z-3999`. Same approved root/profile/marker/frozen
`DSH_HOME`; per-run session ids `agent-guard-stage-{a,b}-<crypto.randomUUID()>`, so the
17:22 sessions stayed intact (new `session.v4.jsonl.zstd`, 10 824 B / 10 414 B, 17:40).
`ok` is now *stage assertions ∧ teardown awaited*, with `residualResources` demoted to
advisory (`residualAdvisory: true`), and the 2 s unref'd watchdog as the only forced exit.
Assertions: **A** — receipt `isError` not true, `ok:false`, code
`DRIVER_TOOL_OWNERSHIP_UNVERIFIED` (imported constant), `≠ POLICY_NO_TURN`, message
length 99, cross-scope `tools/result` ledger +1; **B** — `bodyCalls: 0`,
`guardObserved: 2`, `guardSawProbe: 1`, `isError:true`, message = `GUARD_DENIAL_REASON`,
text `Error: <reason>`, `info: null`; **teardown** — attempted/awaited/ok, 38 ms,
residuals `[]`, then natural process exit. Unit `success`, `code=exited, status=0/SUCCESS`,
runtime 3.244 s, CPU 1.920 s, **memory peak 204.2 M** (swap 0 B), gate
`MemAvailable=2231MiB` ≥ 1700, `# agent-guard-rc=0`, watchdog never fired.

### 9.3 What these rounds still do not claim

1. **No ownership allow-path.** Every ownership result is the fixed deny; nothing here
   shows a real claim being accepted and dispatched.
2. **No plugin-teardown proof.** `dispose()` settled inside its bound; that each mounted
   plugin finished its own teardown is unproven.
3. **The 17:30 residual handles remain unexplained**, and the later run's empty residual
   set does not explain them (the runner's report says so explicitly).
4. **Not launcher-clean.** The `hmr` `appReady` warning is preserved unchanged in these
   rounds, so no run here is readiness evidence — that claim belongs to
   [dsh-plugin-kit records](../../../dsh-plugin-kit/docs/testing/2026-11-01-historical-test-records.md) §8,
   and even there it is CLI service readiness only, never browser.
5. **No revision pin.** These stages recorded no commit for this package (see §5); the
   pinned `ce7073d5…` in 9.2 is the **build-checkout** baseline, not a revision of this
   project.
