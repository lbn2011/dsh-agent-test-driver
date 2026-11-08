# Acceptance Report — Sandboxed Re-execution (current)

Date: 2026-11-01 (Asia/Shanghai)
Scope: execution only. No source or test files were edited. Each command was run **exactly once**; no retries, no budget changes, no install/build/server steps.

## Verdict

| # | Command | Tests | Pass | Fail | Exit | Peak mem | Unit |
|---|---------|-------|------|------|------|----------|------|
| 1 | driver 8 test files | 209 | 209 | 0 | 0 | 51.5M | `acc-driver-8` |
| 2 | `experiments/low-memory-build/test/bundle-one.test.mjs` | 38 | 32 | 6 | 1 | 33.7M | `acc-bundle-one` |

- `tests 209 / suites 9 / pass 209 / fail 0 / cancelled 0 / skipped 0 / todo 0`, duration 1596.7 ms, service runtime 1.848 s, CPU 874 ms.
- `tests 38 / pass 32 / fail 6 / cancelled 0 / skipped 0 / todo 0`, duration 230.4 ms, service runtime 313 ms, CPU 175 ms.

The execution conditions for command 1 were satisfied in full: all eight
`projects/dsh-agent-test-driver/tests/{entry,entry-lifetime,provenance,fixture-binding,core-agent-isolation,core-ownership-context,invoke-tool,loader-ops}.test.js`
files passed together in one native `node --test --test-concurrency=1` run.

Command 2 did **not** pass. Per instructions, execution stopped after these two
commands; nothing was fixed.

## Failure detail (bundle-one, observed as-is)

Failing tests (6):

1. `the helper is called with concrete manifests, and the empty-directory bug is gone`
2. `a relative package directory is normalised and a ".." segment is refused`
3. `prepareBundle refuses everything before the bundler is reachable`
4. `a bundler export without build() is a typed refusal`
5. `the CLI prints a plan, states the bundler was not imported, and exits 0 without --execute`
6. `the CLI exits 2 with a typed code when a refusal fires`

Representative assertion (`bundle-one.test.mjs:475`), expected `/bundle-one: package-not-a-member:/`,
actual:

```
bundle-one: unexpected: Error: ENOENT: no such file or directory, lstat '/checkout'
    at realpathSync (node:fs:2862:29)
    at main (file:///root/dsh-ecosystem-spec/experiments/low-memory-build/src/bundle-one.mjs:588:18)
    at TestContext.<anonymous> (file:///root/dsh-ecosystem-spec/experiments/low-memory-build/test/bundle-one.test.mjs:468:22)
```

Observed shape: a fatal `realpathSync` failure on the fixture root `/checkout`
pre-empts the intended typed refusal, so the CLI prints usage instead of
`package-not-a-member`. Every observed failure is of this same fatal-versus-refusal
family; whether it is a test-harness path issue or a `src/bundle-one.mjs` defect
was **not** investigated (out of scope, no edits allowed).

## Execution envelope (every invocation, identical)

```
systemd-run --wait --pipe --collect \
  -p MemoryMax=768M -p MemorySwapMax=0 -p TasksMax=32 \
  -p CPUQuota=50% -p RuntimeMaxSec=120 \
  -- bwrap --ro-bind / / --dev /dev --unshare-pid --unshare-net \
     --proc /proc --tmpfs /tmp --die-with-parent \
     --chdir /root/dsh-ecosystem-spec \
     env -i PATH=/www/server/nodejs/v24.21.0/bin:/usr/bin:/bin HOME=/tmp \
     node --max-old-space-size=384 --test --test-concurrency=1 <files>
```

- Host: systemd 257 (257.13-1~deb13u1); bwrap and node v24.21.0 both present.
- Both units completed under the cap (`RuntimeMaxSec` never tripped); memory and CPU
  quotas were never approached.
- Filesystem was read-only except `/tmp`; network and PID namespaces were unshared.

## Explicit limitations

- This proves the suite passes **inside this sandbox envelope on this host**. It does
  **not** prove the native-hypervisor path; native host execution remains unproven.
- Coverage is the two commands above only — not a full-suite acceptance.
- The prior worker's claim that the 209-test suite was "verified individually" with
  residual tests fixed is confirmed only at the aggregate level by command 1; the
  bundle-one result contradicts any broader "all green" reading.
- Historical report `projects/dsh-agent-test-driver/test-report.md` is untouched.
