# dsh-agent-test-driver

A host-only DSH plugin that exposes a **registered request surface** to an agent: read a sanitized status of **one isolated test DSH**, ask to enable or disable admin-allowlisted loader entries, and ask to invoke admin-allowlisted tools, all through native DSH surfaces. Read the word "ask" literally — the surface accepts the request and then decides; it does not promise the request is carried out. The invoke request in particular cannot succeed today (see [Ownership](#ownership-why-invocation-cannot-succeed)).

It is not a sandbox, not a general plugin manager, not an installer, and not a standalone CLI: the package declares no `bin`, no executable entry point and no command-line argument parsing. The plugin entry runs inside a DSH host that mounted it; the exported policy and evidence modules are plain importable functions that need no host at all.

> **This README is documentation only.** It was written on 2026-11-08 from the sources and records linked below. No test, build, install or export was run for it, and it changes no code. Nothing here is a compatibility claim.

## Status (2026-11-08)

Implemented and readable in this checkout: the plugin entry ([src/index.js](src/index.js)) with three registered tools, a pure policy module ([src/policy.js](src/policy.js)), a provenance module ([src/provenance.js](src/provenance.js)) that reads the filesystem and environment and is therefore **not** pure, and two pure evidence adapters ([src/admission-evidence.js](src/admission-evidence.js), [src/acceptance.js](src/acceptance.js)).

Executed evidence exists in two separate layers, and they are **not** additive:

- a unit suite over the policy, provenance and evidence modules plus a fake-host entry harness: eight test files in the 2026-11-01 recorded runs, **ten** files in [tests/](tests/) now. This round did not re-run the suite or diff current bytes against those runs, so no case count is claimed for the ten-file tree;
- real-host guard stages (2026-11-01) and two cross-repository batches (2026-11-04/05), each with its own scope.

Neither layer is an installation, a release or a host-compatibility certification. See [Tests](#tests) and [Evidence index](#evidence-index).

## Package surface

[package.json](package.json) is private (`dsh-agent-test-driver@0.0.0`), `type: module`, `engines.node >= 24.9.0`. It declares no dependencies: the entry imports the host's own `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`, which the host provides.

| Export | File | Contents |
|---|---|---|
| `.` | [src/index.js](src/index.js) | The plugin entry: `name`, `inject`, `Config`, `apply`, plus the receipt renderer and `ownershipUnavailable()` |
| `./policy` | [src/policy.js](src/policy.js) | Config normalization and the allowlist/gate helpers (`normalizeConfig`, `gate`, `findAllowedTarget`, `findAllowedTool`, `POLICY_CODES`, …) |
| `./admission-evidence` | [src/admission-evidence.js](src/admission-evidence.js) | `projectAdmissionEvidence(input, deps)` — projects caller-evaluated verdicts into the canonical `admission-evidence/0.1-draft.1` shape |
| `./acceptance` | [src/acceptance.js](src/acceptance.js) | `judgeAdmissionAcceptance(document, options)` — reads one already-validated evidence document |
| `./package.json` | [package.json](package.json) | Package metadata |

There is no `bin` field and no CLI module; [package.json](package.json)'s only script is the test command.

## What it registers

`apply(ctx, config)` mounts on the host's `tools` and `loader` services and registers exactly three tools. They are registered in every arm state — an unarmed driver refuses with a code instead of disappearing, so an operator can read *why* through the same tools.

| Tool | Effect | Notes |
|---|---|---|
| `test_driver_status` | Reports arm state, configured targets and live entry phases | Never throws; its receipt is bounded by `maxStatusBytes` |
| `test_driver_plugin_set_enabled` | Requests enable or disable of one configured loader entry | Requires an armed isolated test host |
| `test_driver_invoke_tool` | Registered request surface for invoking one allowlisted test tool through the native executor | Cannot succeed today; requests that reach the ownership check are denied — see [Ownership](#ownership-why-invocation-cannot-succeed) |

Configuration (`Config` in [src/index.js:129-147](src/index.js#L129-L147)):

| Field | Shape | Default |
|---|---|---|
| `pluginTargets[]` | `{ directory, entries[], modules[] }` — a bare directory name, its loader entry ids, and the module specifier each entry mounts (positional, one-to-one with `entries`) | `[]` |
| `testTools[]` | `{ name, module, expect }` — tools the **host** mounts; the driver only allowlists their names | `[]` |
| `maxStatusBytes` | integer 512–65536 | `8192` |
| `invocationTimeoutMs` | integer 1–60000 | `5000` |
| `testRoot` | string — absolute path to the test root; read by the probe, never returned by `normalizeConfig()` | none; absent means the probe refuses `NOT_CONFIGURED` |
| `profileMarker` | string — must equal `dsh-agent-test-driver.json`; read by the probe only | none; same refusal when absent |

The driver never mounts `testTools` itself. It cannot prove which plugin registered a tool, so mounting a placeholder under the configured name would manufacture exactly the name-equality evidence it must not accept.

## Arming and provenance

Provenance is read from startup-owned facts, never from tool arguments: the requester is the model, and an "is this a test host?" argument would always answer yes.

- **Switch:** admin-set `DSH_AGENT_TEST_DRIVER=1` (`1`/`true` accept; any other non-empty value refuses rather than reading as unset).
- **Startup binding:** `ctx.profileContext` must name an isolated home and profile directory canonically contained in the configured test root, and a root marker file must record that same canonical root.
- **Protected home:** the trusted launcher sets `DSH_AGENT_TEST_PROTECTED_HOME` to the production home this host must never overlap. It is deliberately not `DSH_HOME`, because an isolated host legitimately points `DSH_HOME` inside its test tree. An absent or malformed value refuses.
- **Fail closed:** every unresolvable fact becomes a `PROVENANCE_*` refusal code ([src/provenance.js:96-116](src/provenance.js#L96-L116)); none is a pass.

**Configuration boundary: `testRoot` and `profileMarker`.** [src/provenance.js:300-323](src/provenance.js#L300-L323) reads `config.testRoot` and `config.profileMarker`, and [src/provenance.js:659](src/provenance.js#L659) reads `config.testRoot` again when canonicalizing. The entry's `Config` schema now declares both as `z.string()` ([src/index.js:129-147](src/index.js#L129-L147)), with **no `.default()` and no `.required()`**.

The reasons are fail-closed. A default would pick an operator's trust root or marker inside the schema, rather than having the operator name it and letting the probe report an unnamed field. (A default would not by itself make `NOT_CONFIGURED` unreachable — a host can still supply `null`, an empty string, or omit the other field.) Declaring them `.required()` would turn an absent value into a *load* failure instead of the probe refusal that the receipt surfaces. Declaring them at all is also what keeps the values alive across a config rewrite: the host persists an updated entry config through `Config.simplify()`, and `simplify` drops keys the schema does not declare.

What this changes, and what it deliberately does not:

| Value supplied | Before (undeclared key, merged raw) | Now (`z.string()`, no default) |
|---|---|---|
| absent (no key), or an explicit `undefined` | probe refuses `NOT_CONFIGURED` | **unchanged** — probe refuses `NOT_CONFIGURED` |
| `null` | probe refuses `NOT_CONFIGURED` | **unchanged** — `null` passes the schema, probe refuses `NOT_CONFIGURED` |
| `''` | probe refuses `NOT_CONFIGURED` | **unchanged** — `''` passes `z.string()`, probe refuses `NOT_CONFIGURED` |
| relative path | `TEST_ROOT_NOT_ABSOLUTE` | **unchanged** |
| `/` | `TEST_ROOT_FILESYSTEM_ROOT` | **unchanged** |
| a marker name other than `dsh-agent-test-driver.json` | `MARKER_INVALID` | **unchanged** |
| **a non-null, non-`undefined` value of another type** (`42`, `{}`, `[]`) | merged raw; probe refuses `NOT_CONFIGURED` | **changed: host config parsing fails with a `ValidationError` (path `testRoot` / `profileMarker`), so the plugin does not load** |
| a valid absolute path | proceeds to the remaining checks | **unchanged** — a valid path is not an arming result |

The last row of the "changed" kind is not a security regression: such a value can never satisfy the probe anyway, so the change moves an impossible configuration from a runtime refusal to a load-time rejection. Nothing else about the probe, the policy or the ownership deny port moves.

**A valid `testRoot` is not an armed host.** It only lets the probe continue: the root must be canonical and not reached through a symlink, must not be the filesystem root, must not overlap `DSH_AGENT_TEST_PROTECTED_HOME`, the startup home and profile directory must resolve inside it and be bound by the marker, and the marker must parse and match. Only then is `armed` true.

**Historical note.** The historical fixtures passed these two as *undeclared* keys and relied on the host's schema resolver merging unknown keys — the fixture says so in its own comment ([overlay.patch.yml:83-86](../../experiments/dsh-live-lab/host-smoke/agent-guard/overlay.patch.yml#L83-L86)) and that run observed `armed:true` with `testRoot:"/data/tests"` ([host-smoke-entry-path.md:106](../../experiments/low-memory-build/reports/host-smoke-entry-path.md#L106)). That record does not pin the host or schemastery version it ran against, so this section establishes no schema-version range; it does not revise the host-version pin recorded elsewhere in this README. The merge and `simplify` behaviour described here was read from the installed `@deepseek-ai/schemastery` 3.18.5 source, which is the globally installed copy, not a per-repository `baseline`; this round did not dynamically test either path — no `parse` and no `simplify` was executed. Treat the fixtures as historical records, not as a ready-to-run recipe.

## Ownership: why invocation cannot succeed

No public host API maps a tool name to the plugin that registered it. `ctx.tools.get(name, scope)` returns a definition copied into the registry at registration time — it carries no registering plugin, no disposer and no owner handle — and a tool *name* is not provenance, because any loaded plugin can register or replace the same name.

So the entry installs a fixed deny port: `ownershipUnavailable()` ([src/index.js:158-160](src/index.js#L158-L160)) returns `{ ok: false, reason: DRIVER_TOOL_OWNERSHIP_UNVERIFIED }` for every request, and the module note at [src/index.js:43-57](src/index.js#L43-L57) states that an invocation refuses with that code until the host exposes a trusted exact definition binding. The code path is intentional and greppable; it must not be weakened into a name comparison.

Not every request reaches that port. `invokeTool` ([src/internal/driver-core.js:1119](src/internal/driver-core.js#L1119)) checks, in order: the arm state (`DRIVER_NOT_ARMED`), the allowlist (`TOOL_NOT_ALLOWED`), its own tool names (`KNOWN_TOOL_TARGET`), the presence of a real agent handle and signal (`NO_TURN`), an already-aborted signal (`BUSY`), and the claimed entry against the configuration — and only then asks the ownership port. Those earlier refusals are correct outcomes, not ownership findings, and a caller who sees one has not learned anything about ownership.

Consequences worth stating plainly:

- `test_driver_invoke_tool` is a registered, allowlist-gated request surface that **cannot succeed** against this entry: no successful invocation is possible while the deny port is installed.
- Of the real-host records examined for this README, none contains a successful invocation; the 2026-11-01 guard stages prove the *refusal* (`DRIVER_TOOL_OWNERSHIP_UNVERIFIED`) and the native guard denial. This says nothing about the internal mock-host unit tests, which exercise the surrounding gate logic by substituting the port.

## Evidence adapters

Both are pure: no I/O, no clock, no environment, no dynamic import, no import of a sibling module.

### `./admission-evidence` — `projectAdmissionEvidence(input, deps)`

Projects the caller's evaluated assertion verdicts into the canonical document shape and hands the document to the **injected** canonical validator. Four rules, none relaxable:

1. **Projection, never inference** — no assertion value is computed here; a driver result with `ok: true` is not evidence for anything.
2. **No field of its own** — the whitelist carries the closed field set only; unknown input fields are dropped, never echoed.
3. **The catalog is not copied** — case and assertion ids come from the caller's document and the injected validator.
4. **It owns only what it built** — its own objects are frozen; borrowed caller values are neither cloned nor frozen.

Adapter diagnostic codes (`ADAPTER_CODES`) describe the *seam*, not an admission verdict: a code like `ADAPTER_INVALID_VALIDATOR` means the document was never judged.

**Not a sanitiser.** `baseline` and `limitations[]` are free-form strings that can hold an operation name, a path fragment or an environment token while still validating. Publication-safe metadata is the caller's explicit responsibility ([src/admission-evidence.d.ts:66-77](src/admission-evidence.d.ts#L66-L77)); the adapter applies no content heuristic.

### `./acceptance` — `judgeAdmissionAcceptance(document, options)`

Answers one question: do the selected catalog cases report their expected status with exactly the assertions the catalog names, each of them `true`?

- It expects a document the canonical validator **has already accepted**; it is not the schema validator and does not re-implement grammar checks (`MISSING_ASSERTION`, `INVALID_STATUS`, …).
- The catalog is injected (`CASE_CATALOG` in practice); this module contains no case id, count or per-case table.
- `accepted: true` means the selected cases read as expected — **not** authentication, not certification, and not a claim about provenance, the run, the plugin or the host. `baseline` and `coordination` are caller assertions the document merely repeats ([src/acceptance.d.ts:90-104](src/acceptance.d.ts#L90-L104)).

## Tests

```sh
node --test "tests/*.test.js"
```

The suite is direct `node --test` over `tests/*.test.js` — ten files as of 2026-11-08: `acceptance`, `admission-evidence`, `core-agent-isolation`, `core-ownership-context`, `entry-lifetime`, `entry`, `fixture-binding`, `invoke-tool`, `loader-ops`, `provenance`. These are unit tests over the policy, provenance and evidence modules plus a fake-host entry harness; they do not mount a real DSH process, and the file count is not a test-case count.

**The command above is the invocation, not an approved run.** Any future run needs an approved resource envelope (bounded unit, memory and swap caps, task limit, CPU quota, wall-clock cap, one availability gate sample, serial execution). Do not treat this README as authorisation to run it unbounded. The historical figures were **not** all produced under one identical envelope: each one's caps and deviations are recorded in its own record, and they differ — for example, one 2026-11-01 row has no wall-clock cap in force (see the [historical test records](docs/testing/2026-11-01-historical-test-records.md)). Do not read the list above as a description of what those runs actually used.

## Limits

- **Not a sandbox.** The launcher is trusted and everything runs in one process; provenance stops a *model* from asserting identity, not the process from lying to itself.
- **One host version at a time.** The recorded real-host evidence is one pinned version `0.2.2-alpha.2` (pin `ce7073d51254c26cd63b22a60835b8f948deb447`). No compatibility range, upgrade path or cross-version claim.
- **No ownership allow path** (see above), so recorded invocation evidence is refusal evidence only.
- **No installation, publish, tarball or licence.** The package is private and unversioned at `0.0.0`; no npm identity is claimed.
- **Evidence is bounded per run.** Historic counts describe the code snapshot of their own date; they are not re-validated by this README.
- **The `testRoot`/`profileMarker` fields are declared** (see above). Declaring them changes one behaviour: a present, non-null, non-`undefined` value of another type now fails host config parsing instead of reaching the probe; `null`, `undefined` and `''` still reach it. The schema merge and `simplify` behaviour were read from source, not dynamically tested — this round executed neither `parse` nor `simplify`.

## Evidence index

| Record | What it is evidence for |
|---|---|
| [acceptance-report.md](acceptance-report.md) | 2026-11-01 sandboxed re-execution: driver suite 209/209 in one bounded unit; the separate `bundle-one` suite's red result (its own package) |
| [test-report.md](test-report.md) | The 209-test runs before and after the single production fix (189/20 and 206/3), including the TAP nesting note (218 entries vs `# tests 209`) |
| [Historical test records](docs/testing/2026-11-01-historical-test-records.md) | The six-row suite ledger (`209`, `209`, `209`, `216`, `216`), the void `drv-diag-1` run, the unbounded-wall-clock row, the real-host guard stages, and the resource incident |
| [Admission-evidence batch](docs/testing/2026-11-04-admission-evidence-batch.md) | Cross-repository batch, first attempt: 101 tests / 95 pass / 6 fail — not accepted, failures outside this package's test file |
| [Admission-evidence recheck](docs/testing/2026-11-04-admission-evidence-recheck.md) | The authorized recheck: 101/101, one bounded unit |
| [P0 entry unit](docs/testing/2026-11-04-p0-entry-unit.md) | 66 tests / 65 pass / 1 fail, failing test outside this lane |
| [P0 entry recheck](docs/testing/2026-11-05-p0-entry-recheck.md) | The recheck: 66/66, unit exit 0 |
| [Acceptance-evidence design](docs/requirements-and-design/2026-11-03-acceptance-evidence-design.md) | Why the two adapters exist and where their authority stops |
| [Driver config contract run](docs/testing/2026-11-08-driver-config-contract.md) | One bounded run of `entry` + `provenance` after `testRoot`/`profileMarker` were declared: 93/93, green, inputs unchanged. Not a schema `parse`/`simplify` test and not a host run |
| [Raw run artifacts index](docs/testing/runs/README.md) | Where the external evidence lives, why it is not downloadable, and the sibling-repository and parent-harness limits on reproducing it |

The **216/216** figures are 2026-11-01 historical results over the then-eight test files; they are not a current re-run, and one of those two runs had no wall-clock cap in force. The **101/101** and **66/66** figures are cross-repository batches from 2026-11-04/05 with their own scopes. None of them is a certification.

This round did run tests: **two of the ten test files** (`entry`, `provenance`) in one bounded unit on 2026-11-08, 93/93 green — see the [config-contract record](docs/testing/2026-11-08-driver-config-contract.md). That is not a full-suite run, and it does not establish byte equivalence with the tree for the other eight files.
