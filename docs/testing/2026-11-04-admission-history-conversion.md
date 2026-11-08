# admission-history-conversion — dsh-agent-test-driver record (STATUS: REFUSED — preflight, workload NOT RUN)

STATUS: **REFUSED at preflight.** One authorised launch was attempted on 2026-11-04
(Asia/Shanghai; `20261103T190142Z` UTC) and the launcher refused at its first preflight
read (`exit 70`). The transient unit was never created, the payload never started,
`node --test` never ran. This is a **refusal**, which is distinct from `passed`, from
`failed`, and from "no attempt was made".

Anti-overclaim rules applied throughout:

- No value was filled by an expectation, a plan, or an earlier batch's number. Anything
  this attempt did not observe is marked **NOT OBSERVED** with the reason.
- Nothing below asserts anything about the physical host. The only claim made is about
  **this execution context**, which could not reach the system bus at the moment of the
  attempt.
- No conversion executed, so this record makes **no** claim about downstream calls,
  projection chains, or the module's conversion/refusal behaviour.

Record owner / sole executor: the batch's implementation agent (one attempt, one
executor). Reviewer: Lead.

## Batch identity

| Field | Value |
| --- | --- |
| Launch UTC timestamp | `20261103T190142Z` (`ts_utc=` in `preflight.txt`) |
| Unit name the launcher intended | `admission-history-conversion-20261103T190142Z` (never created) |
| Run directory (exists) | `experiments/acceptance/admission-history-conversion/runs/20261103T190142Z-admission-history-conversion/` |
| Files in that run directory | `preflight.txt` only |
| Launcher | `experiments/acceptance/admission-history-conversion/run.sh` |
| In-unit payload | `experiments/acceptance/admission-history-conversion/payload.sh` (never executed) |
| Sole executor | the batch's implementation agent (single attempt, no retry) |

The run directory was created by a bare `mkdir` on a fresh path: unique, not merged into
an existing root, and retained as the record of a refusal.

## Exact commands and exit codes

Two commands were issued. Each is given with its observed exit code **and the source of
that code**, so a reader can tell a file on disk from a tool's return value.

### Command 1 — source-binding recompute (read-only)

Purpose of the command as issued: re-hash the paths *listed* in the historical loader
run's own source manifest, and compare them with that manifest. Nothing was executed from
the manifest's contents, no directory was scanned, and no path outside this workspace was
touched.

**The command below is the full script as issued, not a summary of steps:**

```
cd /root/dsh-ecosystem-spec || exit 1
M=projects/dsh-plugin-kit/docs/testing/runs/20261102T150305Z-admission-loader/01-sources-before.sha256
echo "=== manifest: $M"
echo "manifest_lines=$(grep -cv '^#' "$M")"
echo "=== recomputed (only the files listed in the manifest, no discovery)"
awk '!/^#/ && NF==2 {print $2}' "$M" > /tmp/sb-files.txt
echo "listed_files=$(wc -l < /tmp/sb-files.txt)"
missing=0
while IFS= read -r f; do [ -f "$f" ] || { echo "MISSING $f"; missing=$((missing+1)); }; done < /tmp/sb-files.txt
echo "missing_count=$missing"
echo "=== recompute output"
sha256sum -- $(cat /tmp/sb-files.txt) 2>&1
echo "recompute_rc=$?"
echo "=== compare against manifest"
sha256sum -c "$M" 2>&1
echo "sha256sum_check_rc=$?"
```

**Provenance and limits of the evidence below.** This is the command tool's complete
stdout for that invocation, transcribed here verbatim because the invocation wrote it to
no native file — no such file exists on disk. It is therefore a **tool-output
transcript**, not an artifact produced by the workload. Two further honest caveats:

- the tool surfaced this stdout; the shell script's *process* exit status was not reported
  as a separate field, and since the script's last statement is an `echo`, a process exit
  status would be 0 regardless of the checks. The meaningful markers are the printed
  `recompute_rc=0` and `sha256sum_check_rc=0` inside the output, which are exit statuses
  of the `sha256sum` and `sha256sum -c` invocations themselves;
- `sha256sum -c` reports per-file `OK`, so the transcript is a per-file comparison, not an
  aggregate claim about anything the manifest does not list.

Complete stdout, verbatim:

```
=== manifest: projects/dsh-plugin-kit/docs/testing/runs/20261102T150305Z-admission-loader/01-sources-before.sha256
manifest_lines=21
=== recomputed (only the files listed in the manifest, no discovery)
listed_files=21
missing_count=0
=== recompute output
34c837c00335959b59366d7261a2d9f1ced3c3b89c12b63b8c7be8a0cd2feff3  experiments/dsh-live-lab/admission/run-isolated.sh
fecf9e82578ccd50c958cf22a7b4ebab4fdab0520000460c88f9d36962c4f8d9  experiments/dsh-live-lab/admission/payload.sh
18e40dc918385f14523f5d3fb81bba0998c9233f485463795ba8ff3986f72fa5  experiments/dsh-live-lab/admission/arm.mjs
b5c09423aca3e31c80f3389d44d7661ad9cfe32923562cfa4a343f1249519fc6  experiments/dsh-live-lab/admission/prepare.mjs
edeadbe4231676c4b2064f3515bf2b08cb703e0995914a98e830857c781ec2c1  experiments/dsh-live-lab/admission/validate-records.mjs
7647c9aac6cfe89f1d097e01fc81d7e40c0d674b032db8c63286f5f7599e6b75  experiments/dsh-live-lab/admission/lib/duration.awk
ed93f27f42e3ce94ec96d2776b4e33eac4a1fa25df493fd086e20fe1dcafa150  experiments/dsh-live-lab/admission/lib/expectations.mjs
dbdb72845a23822439ef6b6c67a2078361acefbeb23cd30bbc1973a128c2450d  experiments/dsh-live-lab/admission/lib/layout.mjs
d68052102aab748b788de358cf81e03045e95f1e9b4e827127ad8ef3146e9f11  experiments/dsh-live-lab/admission/lib/record.mjs
4cdd740b8b3c2a991fcc11f09751af9dc7f3160c651229bef56af19ea0985745  experiments/dsh-live-lab/admission/fixtures/admission-alpha.plugin.mjs
54bb30ac8d640edf13d25c9109a48698c29764f0d758a979f138e0007b606176  experiments/dsh-live-lab/admission/fixtures/admission-beta.plugin.mjs
05211ed819e97098e9e92c74b17771832b91a01fb09bbc97de9d30101b6b6735  experiments/dsh-live-lab/admission/fixtures/admission-coordinator.mjs
fd19c55d094e67d6fd3cb85425e0521809ab9773d55319417fdba75552a28d3e  experiments/dsh-live-lab/admission/fixtures/admission-core.mjs
962334a0e4fff15430e87f9725f53d7fe99df867e39900a07f400e08d6346be6  experiments/dsh-live-lab/admission/fixtures/admission-fault.plugin.mjs
4c311c3c36327dfa166110108cd756fd0327eb7f04d3e5d73f4f2ccbc6f3f4c6  experiments/dsh-live-lab/admission/fixtures/admission-gamma.plugin.mjs
64cde9e457783044b3862375077d95abfdbf0f0b3b1d5f3c5884e67432fb1433  experiments/dsh-live-lab/admission/fixtures/admission-throw.plugin.mjs
a6b35fe0184dc0845a022b0698be2a731169bb92861c3f277d783395d59590e2  experiments/dsh-live-lab/admission/fixtures/admission-trace.mjs
9106ce67a98a79c755d65173719f3adbd8616b6bd65ace2c6dc55fa26e7fcdb9  experiments/dsh-live-lab/admission/fixtures/counted-disposer.mjs
0cd547b980a759fe67a25fb06665dc2c9b685b0b7eb699f367c90bb77e6a6561  experiments/dsh-live-lab/admission/fixtures/admission.patch.yml
d2f2a266b7b86537b7712df49b7b030e59e470253522001801f82fc53948f1c4  projects/dsh-plugin-kit/src/admission.js
5fab080e82c7f30523d28bdc8b3904be25ab5bf14a9580c2562f8fe7909f5d10  projects/dsh-plugin-kit/src/cleanup.js
recompute_rc=0
=== compare against manifest
experiments/dsh-live-lab/admission/run-isolated.sh: OK
experiments/dsh-live-lab/admission/payload.sh: OK
experiments/dsh-live-lab/admission/arm.mjs: OK
experiments/dsh-live-lab/admission/prepare.mjs: OK
experiments/dsh-live-lab/admission/validate-records.mjs: OK
experiments/dsh-live-lab/admission/lib/duration.awk: OK
experiments/dsh-live-lab/admission/lib/expectations.mjs: OK
experiments/dsh-live-lab/admission/lib/layout.mjs: OK
experiments/dsh-live-lab/admission/lib/record.mjs: OK
experiments/dsh-live-lab/admission/fixtures/admission-alpha.plugin.mjs: OK
experiments/dsh-live-lab/admission/fixtures/admission-beta.plugin.mjs: OK
experiments/dsh-live-lab/admission/fixtures/admission-coordinator.mjs: OK
experiments/dsh-live-lab/admission/fixtures/admission-core.mjs: OK
experiments/dsh-live-lab/admission/fixtures/admission-fault.plugin.mjs: OK
experiments/dsh-live-lab/admission/fixtures/admission-gamma.plugin.mjs: OK
experiments/dsh-live-lab/admission/fixtures/admission-throw.plugin.mjs: OK
experiments/dsh-live-lab/admission/fixtures/admission-trace.mjs: OK
experiments/dsh-live-lab/admission/fixtures/counted-disposer.mjs: OK
experiments/dsh-live-lab/admission/fixtures/admission.patch.yml: OK
projects/dsh-plugin-kit/src/admission.js: OK
projects/dsh-plugin-kit/src/cleanup.js: OK
sha256sum_check_rc=0
```

**Bounded interpretation — what this does and does not establish.** The manifest lists
21 paths, and those 21 paths are byte-identical to what it records. What that supports:

- the historical loader run's **source files** (its shell scripts, its `arm.mjs` /
  `prepare.mjs` / `validate-records.mjs`, its `lib/` modules, its fixtures, and
  `projects/dsh-plugin-kit/src/{admission,cleanup}.js`) are unchanged since that run;
- the manifest itself is internally consistent with the tree it describes.

What it does **not** establish:

- the manifest contains **no entry for `41-arm.json` or `42-run.json`**. Those two
  historical records are this batch's inputs, and their byte identity is **NOT verified**
  by this comparison. They are unverified by this attempt, and nothing here should be read
  as binding them to that run;
- nothing about the converter or its dependencies — those are this batch's inputs 1–7 and
  were never hashed by this batch (see §Input hashes);
- nothing about any file the manifest does not list, at any time.

So the correct sentence is: *the historical manifest's listed sources still match that
manifest*. Not: *the historical records are proven to be that run's output.*

### Command 2 — the single authorised runner invocation

```
bash /root/dsh-ecosystem-spec/experiments/acceptance/admission-history-conversion/run.sh
```

Observed exit code: **70** (`RUNNER_EXIT=70`). **Source: the execution tool's result for
this invocation.** `preflight.txt` does not contain the value 70 — it contains the scan
evidence that caused it. The launcher's refusal path (`die` → `exit 70`) is what the tool
reported.

Observed stderr (tool-output transcript; the same facts are recorded on disk in
`preflight.txt`):

```
unit_scan_rc=1
Failed to connect to system scope bus via local transport: No data available
refused: unit table read failed (see /root/dsh-ecosystem-spec/experiments/acceptance/admission-history-conversion/runs/20261103T190142Z-admission-history-conversion/preflight.txt)
```

No retry, no raised limit, no polling after the refusal.

## Preflight (observed; on disk)

`experiments/acceptance/admission-history-conversion/runs/20261103T190142Z-admission-history-conversion/preflight.txt`
— 12 lines, verbatim:

```
ts_utc=20261103T190142Z
unit_scan_cmd=systemctl list-units --state=active,activating admission-history-conversion-* admission-evidence-batch-*
unit_scan_rc=1
unit_scan_out_begin
Failed to connect to system scope bus via local transport: No data available
unit_scan_out_end
proc_scan_cmd=pgrep
proc_scan_pattern=node --test|(^|/)tsc( |$)|pnpm (run )?build|npm run build
proc_scan_rc=1
proc_scan_out_begin

proc_scan_out_end
```

- **Unit table read: failed** (`unit_scan_rc=1`, "Failed to connect to system scope bus via
  local transport: No data available"). Treated as a refusal by design: "I could not see
  the unit table" is not "nothing is running".
- **Process scan: no match** (`proc_scan_cmd=pgrep`, `proc_scan_rc=1`, empty output) — the
  normal "no competing `node --test` / `tsc` / `pnpm build` / `npm run build`" result,
  distinct from the failed unit read.
- **Scope:** this evidences that *this execution context* could not reach the system bus
  when the attempt was made. It does **not** establish that the host has no systemd, and
  does **not** establish that the condition is permanent. A future executor in a context
  that can reach the bus starts from this record, not from a conclusion it cannot support.
- Whether the converter lane was frozen by its author at that moment was **not**
  independently verified by this attempt; the launcher refused before it mattered.

## Envelope readback — NOT OBSERVED

No unit was created, so no cgroup existed and no `systemctl show` / bus read was possible.

| Source | Required | Observed |
| --- | --- | --- |
| cgroup `memory.max` | `805306368` | NOT OBSERVED (no unit) |
| cgroup `memory.swap.max` | `0` | NOT OBSERVED (no unit) |
| cgroup `pids.max` | `32` | NOT OBSERVED (no unit) |
| cgroup `cpu.max` | `50000 100000` | NOT OBSERVED (no unit) |
| unit `Type` | `exec` | NOT OBSERVED (no unit) |
| unit `RuntimeMaxUSec` (resolved µs) | `120000000` | NOT OBSERVED (no unit) |
| `acc_capture_ok` | `yes` | NOT OBSERVED (payload never started) |

The numbers in the `Required` column remain the launcher's *requested* properties.
Nothing here claims they were ever enforced, because no sandbox was ever created.

## Capacity gate — NOT EVALUATED

- `acc_gate_memavailable_kib`: NOT EVALUATED
- required (`1200 MiB`): `1228800` kB (as written; never read)
- `acc_gate`: NOT EVALUATED
- Ratio: NOT COMPUTED

The gate lives in `payload.sh`, which never started. The executor did **not** sample
`MemAvailable` before or after the refusal: that would have been an out-of-envelope probe
and the first step of polling. There is no memory number in this record — not because the
gate passed, but because it was never reached.

## Workload result — NOT RUN

| Field | Value |
| --- | --- |
| `acc_workload_started` | never printed (payload never executed) |
| node rc (`acc_node_rc`) | NOT OBSERVED (no node process created) |
| `systemd-run` rc (`systemd-run.rc`) | file absent — the launch was never reached; the launcher's own exit was 70 |
| TAP totals: tests / pass / fail / cancelled / skipped / todo | **NO TAP OUTPUT EXISTS** |
| Node duration | NOT OBSERVED |
| `acc_workload_wall_ms` | NOT OBSERVED |
| `acc_memory_peak` (bytes) | NOT OBSERVED |
| `pids.peak` | NOT OBSERVED |
| `acc_memory_current_final` | NOT OBSERVED |
| `memory.events.local` | NOT OBSERVED |
| journal service result / runtime | NOT OBSERVED (`journal.txt` absent) |

**Do not read this as "0 tests failed".** Zero tests ran. Any TAP statistic written here
would be fabricated; there is none.

## Input hashes — NOT COMPUTED (by this batch)

The launcher hashes its inputs at step `0c`, after the competing-work preflight. The
refusal happened before that step, so:

- `hashes-before.txt`: **absent**
- `hashes-after.txt`: **absent**
- `hashes-diff.txt`: **absent**
- `batch.rc`: **absent**

The seven inputs the batch would hash — `converter.mjs`, `converter.test.mjs`, the three
libraries, the two historical records (`41-arm.json`, `42-run.json`) — plus `run.sh` and
`payload.sh` therefore have **no hash from this batch**. They were not hand-computed
afterwards: the authorisation covered one light source-binding recompute over the
historical manifest plus the single runner call, and a hand-computed "before" hash with no
"after" hash would be a weaker artifact dressed as an acceptance pair. They stay unhashed
until a run gets past preflight.

What Command 1 did hash is narrower: the historical loader run's own **listed source
files**, compared against that run's manifest. That is a statement about those 21 source
paths only. Because the manifest lists neither `41-arm.json` nor `42-run.json`, Command 1
does **not** tie this batch's two historical input records to that run — their byte
identity remains unverified — and it is not a hash of this batch's inputs either.

## Expected-refusal handling — UNOBSERVED

The design expectation is unchanged: the first batch of the history-conversion module is
expected to **refuse incomplete real records**, and such a refusal is a business
expectation, not a test failure.

This attempt exercised none of it. No converter code ran, so:

- **no refusal code or message from the module was observed** — there is nothing to
  quote, and none is invented here;
- **no "converted anyway" behaviour was observed** either, so the escape hatch this record
  exists to catch is neither confirmed nor excluded;
- the proposition "this batch is historical-conversion refusals plus zero downstream
  calls" is a **design expectation of the slice**, not a result of this attempt. Since no
  conversion executed, **this record does not claim zero downstream calls were verified**.
  Verifying that needs a run that reaches the workload.

## Test scope vs real host scope

- The intended workload is **one** `node --test --test-concurrency=1` invocation over one
  test file of a pure transformation module inside a transient unit. It is a test-harness
  result: it boots no Loader, registers no plugins, exercises no live runtime.
- Even had it run, a TAP line would describe the converter's behaviour **on the fixtures
  and historical JSON records present in this workspace**, inside a bwrap sandbox with a
  read-only root. It would say nothing about live plugin traffic, real host state, or
  records not in this workspace.
- This attempt went further and produced nothing: it stopped at host-side preflight —
  before the unit, before the sandbox, before node.
- The refusal observed is an **execution-context** fact (no reachable system bus at that
  moment). It is not evidence about the converter, not evidence about the host's
  packaging, and not a verdict on the module.

## Raw evidence inventory

| Path | State |
| --- | --- |
| `.../runs/20261103T190142Z-admission-history-conversion/preflight.txt` | **present** (12 lines; transcribed in §Preflight) |
| `.../argv.txt` | absent — written after the refusal |
| `.../hashes-before.txt` | absent — written after the refusal |
| `.../unit.log` | absent — no unit |
| `.../journal.txt` | absent — no unit |
| `.../systemd-run.rc` | absent — no launch |
| `.../hashes-after.txt` | absent |
| `.../hashes-diff.txt` | absent |
| `.../batch.rc` | absent — the launcher refused before writing its verdict file |

Retention: the run directory stays as-is. Nothing was deleted, overwritten or relabelled,
and the refusal was not retried into a cleaner-looking result.

## Deviations and disclosures

1. **Pre-audit read-only audit agent violated the file-only constraint.** Before this
   batch existed, a read-only audit agent performing reconnaissance on this lane used
   `bash`, `ls`, `find`, `grep`, `sed`, `cat`, `wc` and `python` to read JSON records
   instead of the permitted `read`/`glob`/`grep` file tools. It made **no writes**, ran
   **no node**, and ran **no tests**. Consequences that must stay recorded:
   - that invocation is **not** acceptance evidence, satisfies no envelope, no gate and no
     readback, and is not reproduced by this batch;
   - this lane must **not** be described as "no commands were run" for its whole history;
   - the only authorised node invocation for this batch remains the single in-unit one —
     and it did not happen.
2. **Out-of-envelope history of the neighbouring lane** (carried forward, unchanged): the
   earlier protocol author's unrestricted `node --check src/admission-evidence.js` remains
   disclosed in the admission-evidence lane's records. It is unrelated to this batch's
   verdict and is not inherited as evidence here.
3. **Authoring of the runner and this record** ran no node, no `bash -n`, no test, no
   build, no install; see disclosure 4 for the one shell read during authoring.
4. **Implementation agent's authoring-time read-only `ls`.** While preparing this batch,
   the implementation agent — whose constraint was the file-only one — issued one
   read-only directory listing through the shell (`ls`) instead of `glob`. No writes, no
   node, no tests. It produced no hash, readback, gate sample or verdict, so it is not
   acceptance evidence, and the authoring of this batch must not be described as "pure
   file operations".
5. **This execution used bash exactly twice**, both authorised: (a) the read-only
   source-binding recompute of Command 1, restricted to manifest-listed workspace files;
   (b) the single `run.sh` invocation of Command 2. No other shell was issued — in
   particular no `bash -n`, no bare `node`, no build, no install, no hand `systemctl` call,
   no `MemAvailable` probe, and no retry of the refused launch.
6. **Refusal, not absence.** The attempt refuses at preflight because the unit table could
   not be read from this execution context. It is recorded as a refusal with raw evidence
   and is explicitly **not** a claim that the host lacks systemd, that the condition is
   permanent, or that the batch is unrunnable.
7. **Prior-batch state is not inherited.** The admission-evidence batch's
   `runs/20261103T171615Z-*` / `20261103T171140Z-*` results describe different modules and
   different test files; they are neither re-used nor re-summarised as a pass — or as a
   failure — for this batch.

## Verdict

**REFUSED (preflight), workload NOT RUN.** One attempt; the first competing-work read
could not reach the system bus; the launcher exited 70. No unit, no sandbox, no node, no
TAP, no hashes, no gate sample.

- Not `passed`: nothing converted, no test ran.
- Not `failed`: no workload executed, so no workload failure exists.
- Not "no attempt": the attempt and its refusal are evidenced, and the refusal is a real
  observable outcome of this context.

For a future authorised attempt, in order: an execution context with a reachable system
bus; a frozen converter lane; then one launch, one workload, no retry. The runner and
payload are unchanged by this attempt and remain frozen.

## Freeze

`run.sh`, `payload.sh`, `converter.mjs`, `converter.test.mjs` were **not modified** by
this execution. This record documents the attempt; it does not adjust the harness to make
a future attempt look different. Any change to the runner, payload or the input hash list
requires a Lead decision and a new round — the executor does not edit the harness to make
a run go green.
