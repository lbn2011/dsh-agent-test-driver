# Isolated test driver — corrected test report

> Date: 2026-11-01. Scope: `projects/dsh-agent-test-driver` tests + `test-report.md`.
> This report **replaces** an earlier version whose failure attributions were guesses. Every claim below
> was checked against the running code or the parsed TAP output, not against the previous report's text.

## 1. Envelope actually used

Every run went through one transient systemd unit wrapping `bwrap`:

```
systemd-run --collect --unit=<name> \
  -p MemoryMax=768M -p MemorySwapMax=0 -p TasksMax=32 -p CPUQuota=50% -p RuntimeMaxSec=120 \
  --wait --pipe /usr/bin/bwrap --ro-bind / / --dev /dev --proc /proc \
  --unshare-pid --unshare-net --unshare-ipc --unshare-uts --tmpfs /tmp --chdir <project> \
  /usr/bin/env -i PATH=/www/server/nodejs/v24.21.0/bin:/usr/bin:/bin HOME=/tmp \
  /www/server/nodejs/v24.21.0/bin/node --max-old-space-size=384 --test --test-concurrency=1 <files>
```

`<files>` is the explicit list of the 8 test files. Passing the directory `tests/` fails with
`Cannot find module '.../tests'`, which consumed one earlier attempted run (`drv-diag-1`) that is
therefore **not** counted as evidence anywhere in this report.

## 2. Measured results

| Run | Unit | Tests | Suites | Pass | Fail | Node duration | Service runtime | CPU | cgroup peak |
|---|---|---|---|---|---|---|---|---|---|
| Diagnostic (pre-fix) | `drv-diag-2` | 209 | 9 | **189** | **20** | 1769.776 ms | 1.941 s | 944 ms | 49.2 M |
| Post-fix | `drv-postfix` | 209 | 9 | **206** | **3** | 1648.207 ms | 1.723 s | 869 ms | 42.9 M |

Both runs: cancelled/skipped/todo 0, swap 0 B, no OOM, no `RuntimeMaxSec` kill, exit 1.
The TAP tree parses to 218 entries (185 top-level + 33 nested) and `# tests 209`; the nesting is why a
naive "count the `ok` lines" differs from the summary line.

Test files: `core-agent-isolation`, `core-ownership-context`, `entry-lifetime`, `entry`,
`fixture-binding`, `invoke-tool`, `loader-ops`, `provenance`.

## 3. What the previous report got wrong

1. **"Sparse-module slice preserved holes; `targetModules()` needed an indexed loop."** Not a live
   defect in this checkout: the indexed loop is already there and a hole is already rejected as
   unreadable. The report described an edit made *earlier* as if it were the cause of a current failure.
2. **"Receipt-renderer failure is `ReferenceError: TEXT is not defined`."** Wrong diagnosis. The real
   error is `SyntaxError: Identifier 'TEXT' has already been declared`: the test passes `textBlock`
   (which itself declares `const TEXT`) as the body **and** names `TEXT` as a parameter of the same
   `new Function`. Reproduced directly against the shipped source.
3. **"20 residual failures: 14 stale entry contract names, a provenance-vocabulary disagreement, and
   the ownership/cancellation fixtures."** That split did not survive inspection — see §4. Only the
   grouping below is evidence-backed.

## 4. The 20 failures, root-caused

### 4.1 Test-fixture defects (17 of 20)

- **5 integration tests (#27–#31) — `makeRealCore` omitted `tools`.** The core's `createInvoker`
  contract is `createSingleToolInvoker`'s options *minus* the host service; the entry injects
  `tools: ctx.tools` by closure (`src/index.js`). The fixture called
  `createSingleToolInvoker(options)` with no `tools`, so the real helper threw
  `TypeError: tools must be the native tools service (ctx.tools)` and the core reported
  `DRIVER_HOST_UNAVAILABLE`. Fixed by injecting the fixture's fake executor.
- **#79, #80, #81, #104 — `status()` contract mispinned.** `status()` answers *before* the arm
  settles with `ok: true, armed: false` and an empty projection (`driver-core.js:920-936`); it never
  returns `NOT_READY` (that code belongs to `state()` and to operations that must refuse). Two tests
  asserted `ok: false`/`NOT_READY`, two asserted the armed projection without ever arming. Rewritten to
  the real contract; the arm-dependent ones now arm explicitly.
- **#70, #75 — refusal code/message.** `refuseFrom()` deliberately preserves the code the probe
  reported (`driver-core.js:157-159`), so an unarmed host says `PROVENANCE_NOT_TEST_HOST`, not
  `NOT_ARMED`; and `DESCRIPTIONS` has no sentence for the fine-grained `PROVENANCE_*` codes, so the
  message falls back to `the driver refused this operation` (`driver-core.js:120`). Both assertions now
  match shipped behaviour and additionally assert no path leaks into the text.
- **#71 — the source regex, and a worse bug behind it.** The test indexed the *raw* file, so
  `source.indexOf('ctx.tools.register(')` matched the docstring at `src/index.js:17`, thousands of
  characters before the arm — the ordering assertion could never pass. Fixed by scanning
  comment-stripped code (now `armAt 3956 < regAt 3993`) and by matching the call's *shape* rather than
  one exact spacing.
- **#19, #5, #31 — fixed microtask counts.** Reaching the invoker/executor takes 3 hops, not 2; the
  tests used hardcoded `await Promise.resolve()` pairs, and `dispose()` therefore ran before any
  invoker existed. #19 additionally read `signalsAtInvoke[0]` before `invoke()` had started. All now
  wait on the observable fact (`calls.created.length` / `tools.calls.length`).
- **#7, #96 — ownership fixtures without `modules`.** With no positional module the claim is refused
  earlier as `TOOL_OWNERSHIP_UNMAPPABLE`, so the tests never reached the ownership port they name.
  Added the positional module so they test `TOOL_OWNERSHIP_UNVERIFIED`; the unmappable branch keeps its
  own coverage.
- **`entry-lifetime` vocabulary list** omitted `TOOL_OWNERSHIP_UNMAPPABLE`, which is a declared,
  documented code beside `TOOL_OWNERSHIP_UNVERIFIED` (`driver-core.js:52,113-114`) and predates the
  lifetime work. List corrected; the test's real point (no code describes teardown) is now also
  asserted directly.

### 4.2 The one production change (1 verified bug)

- **An already-cancelled invocation still dispatched** (`src/internal/driver-core.js`, `invokeTool`).
  Reproduced: a call whose `exec.signal` was already aborted built an invoker, ran the helper into
  `tools.execute()`, returned `DRIVER_BUSY`, and left `invoke:<tool>` recorded as an *unsettled*
  mutation — so one abandoned call refused every later call. The helper checks `signal.aborted` only
  after entering the native batch, and `exclusive()` only maps its own wait, so nothing stopped the
  dispatch. Added a pre-dispatch guard returning the **existing** `DRIVER_BUSY` code
  (`waitBounded()` already reports an already-aborted signal that way); no code was invented, renamed
  or removed. The test now also asserts `queue.pending === 0`, `queue.unsettled === undefined`, and that
  the next call succeeds.

### 4.3 Corrected assumptions worth recording

- **Cancellation code after dispatch is `DRIVER_BUSY`, not `INVOKE_CANCELLED`.** `exclusive()` maps its
  own busy/timeout/cancel to `DRIVER_BUSY` and preserves only a code the operation itself returned
  (`driver-core.js:872-899`); this is already pinned at `tests/core-ownership-context.test.js:589-592`.
  Two tests in `core-agent-isolation` expected the helper's `INVOKE_CANCELLED` through the slot; they
  now assert `DRIVER_BUSY` while keeping the assertion that the abort really reaches the live invoker's
  signal. The helper's own code is still covered without a slot.
- **The invoker's signal is a per-call derived signal, not the caller's object.** `callSignal()`
  (`driver-core.js:204-249`) creates a fresh controller and *forwards* the caller's abort. Verified
  `built !== controller.signal`, `aborted === false` before, `true` after, reason preserved.

## 5. Unresolved decisions (not silently resolved)

1. **`status()` vs `NOT_READY` vocabulary.** The implementation lets `status()` answer before the arm
   with `ok: true, armed: false`. That is defensible, but `DRIVER_NOT_READY` now has no reachable
   producer through `status()` and is documented as though it did. Whether to keep the code for
   operations only, or to have `status()` refuse before the arm, is an operator-visible product
   decision; this task changed tests, not that behaviour.
2. **`PROVENANCE_*` messages fall back to one generic sentence.** Callers can distinguish causes only by
   `code`. Giving each provenance code a fixed sentence is a vocabulary addition this task was told not
   to make unilaterally.

## 6. State of the last validated run

The post-fix run recorded in §2 (`drv-postfix`, 206/209) was taken **before** the three remaining
failures (#19, #71, #75) were corrected, because the task budget — one diagnostic run plus one post-fix
rerun — was already spent. Those three corrections are verified individually against the running code
(the ordering indices, the derived-signal forwarding, and the `deny()` fallback sentence above);
no further suite run was performed.

**No failing assertion was deleted, skipped, or softened.**

## 7. Limits of this evidence

The tests read `src/index.js` as text and exercise `driver-core.js` through fakes; they are not proof
that a real DSH host mounts the plugin. Not covered: `Config` acceptance by the host parser,
`defineTool`/`ctx.tools.register` JSON-schema validation, the real guard pipeline behind
`tools.execute`, and whether the cgroup kills an over-long native call. Those need a real host run.

## 8. Disposition

No build, install, server start, `--force`, or delegation was used. `experiments/low-memory-build` was
not touched. Only one production file changed, for the one verified bug in §4.2.
