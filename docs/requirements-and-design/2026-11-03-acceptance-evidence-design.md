# Driver acceptance result — requirements and design (proposed, not accepted)

> **Status: PROPOSED DESIGN — NOT ACCEPTED. Partly implemented since 2026-11-04, in a
> different shape than §6 proposed; see §10 for the current state.**

**Current (2026-11-04).** Synchronised from source and records; this revision changed
documentation only.

- A standalone adapter module now exists: `src/admission-evidence.js` with
  `src/admission-evidence.d.ts` and `tests/admission-evidence.test.js`. It exports
  `projectAdmissionEvidence(input, { validateAdmissionEvidence })` and a frozen
  `ADAPTER_CODES`; it is pure and import-free, projects a closed field set, and calls
  the **injected** canonical validator exactly once. It takes caller-evaluated cases
  and never reads a raw driver receipt.
- It is **not wired into the plugin**: the driver still registers exactly the three
  tools it registered before (`src/index.js:282-328`), and no package export changed.
  No host control was widened.
- First full batch of the lane: **101 tests, 95 pass, 6 fail, 0 skipped**. The driver's
  own test file had no failures; the six failures lie outside this driver's source tree —
  one integration test, four platform analyzer diagnostics tests, one spec-repository
  test. Batch verdict: **FAILED — not accepted**
  ([record](../testing/2026-11-04-admission-evidence-batch.md)). That record stands.
- One authorized recheck after all authors froze their sources:
  **101 tests, 101 pass, 0 fail, 0 skipped**, node and `systemd-run` both rc 0, no
  residue ([record](../testing/2026-11-04-admission-evidence-recheck.md)). The driver
  module and its test were byte-identical across both runs; the six fixes were made by
  their authors in the other files.
- **Neither run is host certification.** Both executed four literal test files through one
  serial test-runner invocation inside a sandboxed process tree; neither proves anything about native host behaviour, and nothing
  here is wired into the plugin's tools.
- **Not implemented, and not claimed as done:** native raw-receipt capture; any
  conversion into `real-host` or any other evidence tier; a runner that turns receipts
  into assertions; the `driver-acceptance-result/0.1-draft.1` record sketched in §6.
  §6 remains a proposal, not a built artifact.

**History (as written 2026-11-03).** The plan below was written before any of the above
existed, and is kept unedited as the record of what was proposed: exactly one new file
(this document), no source file, no test, no export, no configuration field; the
adapter proposed only, with no implementation until a shared schema was approved by the
Lead; and no host-control widening then or now.

> **No mtimes-as-proof.** Every revision of this document was read/edit only. Any
> statement that an unchanged file is unchanged rests on not having written to it —
> *not* on file mtimes, hashes or a diff run. `mtime` is not evidence of content.

> **NOT RUN (this revision).** No command, test, build, install, host run or subprocess
> was performed while writing it. Statements about the module and the batch are read
> from source and from the retained record linked above; nothing here is measured.

> **Independence, restated.** This document's lane — a `driver-acceptance-result`
> projection of operation receipts — is still independent of the
> `coexistence-evidence/0.1` intake lane and was not built. The module that *does*
> exist targets the separate `admission-evidence` draft instead, so it satisfies none of
> §6 and does not advance §5's argument one way or the other.

> **Decided before writing (scope, 2026-11-03):**
> - Write scope was exactly one new file: this document.
> - The adapter was **proposed only**; no implementation until a shared schema was
>   approved by the Lead. (The module since built followed the `admission-evidence`
>   draft, which the Lead did approve — not this record.)
> - The exported report carries **no raw host error, no path, no tool value, no tool
>   argument**. That is a design constraint here, not a claim about existing code.
> - The *current* `coexistence-evidence/0.1` schema cannot directly ingest raw driver
>   receipts (§5); that is a statement about this schema, not a ban on future runners.

## 1. Objective

Answer one narrow question: **what can be exported, honestly, from a driver call —
and in what shape — without inventing a verdict the driver never produced?**

The driver observes an isolated DSH host through native surfaces. It is not the only
thing that can — real Loader harnesses observe native surfaces too — and this document
claims no exclusivity, only that the driver's *own* output is what it is. It emits
*operation receipts*. It does **not** emit pass/fail outcomes, assertion ids, an
evidence tier or a baseline revision. A reusable adapter is
therefore a projection with a deliberately small field set, not a converter that
upgrades receipts into test results.

## 2. Current state — what the sources actually say

### 2.1 The three receipt families (exact fields)

All outward values pass through `renderReceipt` (`src/index.js:151-163`), which
`JSON.stringify`s the whole payload into one text block; the core is what keeps that
payload closed (`src/internal/driver-core.js:141-147` `deny()`, `:649-687` `receiptOf()`).

| Tool | Receipt on success | Receipt on refusal |
| --- | --- | --- |
| `test_driver_status` (`src/index.js:283`) | `{ ok:true, armed, provenance:{ armed, testRoot?, profileName?, codes[] }, targets:[{directory,entries[]}], entries:[{target,id,phase,module,mismatch,present}], tools:[name] }` (`driver-core.js:412-478`) | `{ ok:false, code, message }`; `status()` itself only refuses `DRIVER_HOST_UNAVAILABLE` when disposed or `DRIVER_STATUS_UNAVAILABLE` on a throw (`:920-937`) |
| `test_driver_plugin_set_enabled` (`src/index.js:296`) | `{ ok:true, kind:'lifecycle', action, target, entry, module, before, after, changed:boolean, settled:boolean, persisted:'unknown' }` (`driver-core.js:667-681`) | `{ ok:false, code, message:<fixed sentence> }` |
| `test_driver_invoke_tool` (`src/index.js:318`) | `{ ok:true, kind:'invocation', code, status }` (`driver-core.js:683-688`); `code ∈ {INVOKE_OK, …}`, `status` is bounded text | `{ ok:false, code, message }` |

`entries[].phase ∈ {pending, loading, active, failed, disposed, unloading, unknown}`
plus the projection-only values `undeclared`, `unreadable`, `absent`,
`unavailable` (`loader-ops.js:52-72`, `driver-core.js:360-390`).

### 2.2 The closed refusal vocabulary (four owners, one shape)

| Owner | Codes | Where |
| --- | --- | --- |
| driver core | `DRIVER_NOT_READY`, `DRIVER_NOT_ARMED`, `DRIVER_BUSY`, `DRIVER_TOOL_OWNERSHIP_UNVERIFIED`, `DRIVER_TOOL_OWNERSHIP_UNMAPPABLE`, `DRIVER_STATUS_UNAVAILABLE`, `DRIVER_HOST_UNAVAILABLE` | `driver-core.js:43-59` |
| policy | `POLICY_PROVENANCE`, `POLICY_CONFIG_INVALID`, `POLICY_TARGET_NOT_ALLOWED`, `POLICY_TOOL_NOT_ALLOWED`, `POLICY_PATH_ESCAPE`, `POLICY_PRODUCTION_TARGET`, `POLICY_KNOWN_TOOL_TARGET`, `POLICY_ARGUMENT_INVALID`, `POLICY_NO_TURN` | `policy.js:41-51` |
| loader helper | `DRIVER_ENTRY_BUSY`, `DRIVER_CANCELLED`, `DRIVER_TIMEOUT`, `DRIVER_UPDATE_FAILED` | `loader-ops.js:152,194,437,478` |
| invocation helper | `INVOKE_DENIED`, `INVOKE_CANCELLED`, `INVOKE_OK`, `INVOKE_TOOL_ERROR`, `INVOKE_INTERNAL_ERROR` | `invoke-tool.js:33-39` |

Every refusal is `{ ok:false, code, message }` with the message replaced by a fixed
sentence (`driver-core.js:98-119`), so a *refusal* carries neither a path, host
exception text nor raw tool output. That property is what makes a closed export
possible at all. It does **not** extend to successful receipts, which do carry
path-bearing and free-form fields (§2.3(6)).

### 2.3 What the driver does **not** produce (read before designing any field)

1. **No assertion evaluation.** `testTools[].expect` is accepted and normalized to
   *equal the tool name* — it pins the registered name, not an expected result
   (`policy.js:143-153`). No module evaluates an expectation: `driver-core.js` and
   `invoke-tool.js` contain no comparison of tool output against anything.
2. **No pass/fail verdict.** `ok:true` means *the operation was performed, or the
   native call completed*, never *the behaviour under test is correct*
   (`invoke-tool.js:55-68`: `isError:false` → “completed”, nothing else is read).
3. **No evidence tier.** No tier string, no signature, no attestation exists in the
   driver.
4. **No baseline.** No commit, no Node version, no UTC timestamp is emitted; the
   retained records say revision is unrecorded for most rows
   (`docs/testing/2026-11-01-historical-test-records.md:115-133`).
5. **No schema version** for its own receipts.
6. **Several identifier-bearing fields occur** in successful payloads — more than the
   one path the driver's own comment admits (`driver-core.js:399-401`). They are *not*
   all the same kind of value, and the differences matter:
   - `provenance.testRoot` is a **real absolute path** (bounded 200,
     `driver-core.js:444-446`; asserted present at `tests/entry.test.js:556`);
     `provenance.profileName` is free-form text, bounded 64.
   - `targets[].directory` and entry `id` are **validated identifiers, not paths**:
     `policy.js:99-100` rejects `.`/`..`, any `/`, `\`, NUL or leading dot, and
     `policy.js:108,28` requires `ENTRY_ID_PATTERN` (`/^[a-z0-9][a-z0-9._:-]*$/`). They
     cannot be a filesystem path — but they can still name a project, a client or a
     person, which is disclosure even without a separator.
   - lifecycle `target`/`entry` come from that allowlist, while lifecycle `module` is
     **unvalidated admin text**: `normalizeTarget()` keeps only
     `{directory, entries}` (`policy.js:90-115`), so the modules mapping is re-attached
     unexamined (`driver-core.js:307-320`) and read positionally (`:299-305`). It may
     therefore be an arbitrary specifier, including a relative path.
   - invocation `status` is bounded prose, 120 characters (`:686`), not an enum.
   Either way, none of these is dropped for being short: all are excluded from the
   proposed export unless a trusted alias supplies a substitute (§6.2a, §6.3).
7. **No persistence claim**: `persisted` is the literal `'unknown'`
   (`driver-core.js:679`, pinned by `tests/entry.test.js:665`).

### 2.4 Existing assertion-shaped evidence (different lanes, never merged)

| Lane | Artifact | What it can say | Where |
| --- | --- | --- | --- |
| unit tests | `node:test` files | assertion ids are test names; 209 tests in the last accepted run | `tests/*.test.js`; `acceptance-report.md` |
| run records | hand-written Markdown | `PASS / FAIL / REFUSED / NOTRUN` per row, envelope validity, revision gaps | `docs/testing/2026-11-01-historical-test-records.md:172-207` |
| platform intake | JSON document + pure validator | three fixed cases, `passed/failed/not-run`, tier `real-host`, `certification:false` | `projects/dsh-compat-platform/packages/analyzer/src/runtime-evidence.js:62-78,235` |
| host-smoke runs | scripts under `experiments/low-memory-build/` (parent workspace) | ad-hoc assertion ids (`invoke-refused-agent-absent`, …) | historical records §9.2 |

None of these is a driver output. The adapter therefore maps *receipts* only, and says
so; it does not mint assertion ids.

## 3. Gaps

| ID | Current | Required for a reusable acceptance result | Source of the gap |
| --- | --- | --- | --- |
| D1 | receipts are tool-call shapes | one stable record shape per call | §2.1 |
| D2 | `ok` mixes “performed” and “completed” | explicit `outcome` with no verdict implication | §2.3(2) |
| D3 | no assertion concept anywhere | an explicit *not-evaluated* slot, never a guessed boolean | §2.3(1) |
| D4 | tier absent | a tier that names the receipt, never `real-host` | §2.3(3) |
| D5 | baseline absent | either an explicit gap field or refusal — not a fabricated commit | §2.3(4) |
| D6 | identifier-bearing fields are model-facing: one real path (`testRoot`), one free-form name (`profileName`), validated names (`directory`, entry `id`/`target`), one unvalidated mapping (`module`), one prose field (`status`) | export drops all of them unless a trusted alias is supplied; each is dropped for what it is, not for its length | §2.3(6), §6.2a |
| D7 | no shared schema | one proposed schema id, versioned and separately owned | §5 |

## 4. Three tiers that must not be conflated

| Tier | Definition | Who can produce it today | May the adapter upgrade it? |
| --- | --- | --- | --- |
| **operation result** | what the driver did: performed / refused, with a closed code | driver receipts only | — (this is its input) |
| **test assertion** | “expected X, observed Y” about the behaviour under test | the caller's own runner; unit tests and run records | **No.** The adapter writes `assertion: null, assertionEvaluated: false` |
| **host evidence** | a claim about a real host, with tier and baseline | an external runner; platform lane as *reported claim* | **No.** A receipt is `driver-reported`, never `real-host` |

Reading rule for any future consumer: *a record saying `outcome:"completed"` says the
tool ran, not that the test passed.*

## 5. Why the current `coexistence-evidence/0.1` cannot ingest raw driver receipts

**Scope of this section.** It shows that the *schema as it stands today* has no slot
for a raw driver receipt. It does **not** claim that a runner could never translate
driver observations into justified assertions for the three existing cases — a runner
may do that, but only by adding real assertions and a real baseline of its own. The
adapter is not such a runner, and nothing here forbids one from existing.

| Platform rule | Driver reality | Consequence if reused |
| --- | --- | --- |
| exactly three case ids, each once (`runtime-evidence.js:65-71,402`) | arbitrary operations over configured targets/entries/tools | every driver record would be forced into a wrong case, or refused |
| `status ∈ {passed,failed,not-run}` (`:72`) | `outcome ∈ {performed,refused}`; no verdict | `passed` would be fabricated |
| `failed` requires ≥1 recorded `false` assertion | driver records no assertions | a `failed` case is inexpressible without inventing ids |
| `evidenceTier` accepts only `real-host` (`:78`) | receipt is an in-process tool result | would auto-label a non-real-host claim as `real-host` |
| `baseline.commit` must be 40 hex (`:108`, doc “Rules enforced”) | driver emits no commit | would require a fabricated or borrowed revision |
| closed field sets, `UNEXPECTED_FIELD` (`:102-106`) | lifecycle/invocation fields have no home | silent drift or refusal |

Conclusion: the acceptance result is a **separate lane with its own schema id and its
own vocabulary**; it must not reuse `status`, `cases`, `passed`, `evidenceTier` or
`certification`. If a downstream step ever wants the platform lane, an *external*
runner composes the coexistence document from these records **plus** real assertions
and a real baseline of its own — never the validator, never the adapter. Whether such
a runner can one day justify an existing case from driver observations is that
runner's decision and is out of scope for this document.

## 6. Proposed adapter (API and fields) — for Lead review

> *History note (2026-11-04): nothing in this section was built. The module that now
> exists follows the `admission-evidence` draft instead and satisfies none of these
> fields; see §10. The section is kept unedited as the proposal.*

### 6.1 Shape

One pure, import-free function in one new file, e.g.
`src/internal/acceptance-result.js` (not wired into `src/index.js`, not exported from
`package.json` until approved):

```js
adaptDriverResult(value) ->
  { accepted: true,  record: Readonly<Record> }
| { accepted: false, code: 'ADAPT_*', message: '<fixed sentence>' }
```

Rules: no I/O, no clock, no environment, no random, no `eval`/dynamic import, no
mutation, deterministic; unknown or malformed input **fails closed** (`accepted:false`)
rather than being partially summarized.

### 6.2 Proposed record fields (closed set; anything else is not emitted)

```jsonc
{
  "schema": "driver-acceptance-result/0.1-draft.1",   // proposed id, pending
  "source": { "plugin": "dsh-agent-test-driver" },     // constant
  "operation": "status" | "lifecycle" | "invocation",
  "outcome": "performed" | "refused",                  // never "passed"/"failed"
  "code": "<one of the four closed vocabularies in §2.2, or ADAPT_*>",
  "assertion": null,                                   // always
  "assertionEvaluated": false,                         // always
  "evidence": { "tier": "driver-reported" },           // never "real-host"
  "host": { "armed": true|false, "provenanceCodes": ["PROVENANCE_*"] },
  "entry": { "alias"?, "action", "before", "after",
             "changed", "settled", "persisted": "unknown" },   // lifecycle only
  "invocation": { "tool", "completed": true|false },          // invocation only
  "limits": { "truncated": true|false }
}
```

`alias` is the only identity field, it is optional, and it comes from a caller-owned
trusted map; `target`, `entry` and `module` are omitted (see §6.2a).

Field provenance: `operation`/`outcome`/`code` from the receipt discriminant
(`driver-core.js:649-688`); `host.armed` and `host.provenanceCodes` from
`status.provenance` (`:444-458`), with `codes` sliced to 8 and each bounded to 64 as the
driver already does; `entry.action`/`before`/`after`/`changed`/`settled` from the
lifecycle receipt; `invocation.completed` is `code === 'INVOKE_OK'`, `tool` from the
configured allowlist name.

### 6.2a Free-form entry identifiers are a privacy problem, not a length problem

Two different reasons apply here, and neither is length.

*Bounds are not sanitization.* `target` (64), `entry` (128) and `module` (160) are
`boundedText`-truncated (`driver-core.js:667-681`); truncation does not classify, so a
128-character value is ample room for a path, a specifier, a host name or a user name.

*Validation is not uniform.* `target` and `entry` were validated as names before they
reached the receipt (`policy.js:99-115`), so they cannot be absolute paths — but they
are still chosen identifiers that can disclose a project or a person. `module` was
**not** validated on this path at all: it is the admin's raw mapping, re-attached and
read positionally (`driver-core.js:307-320`, `:299-305`), so it may be any specifier,
relative path included. The exporter must therefore not treat "validated name" as
"harmless", nor call every one of these a path.

Default: **omit** `module`, `entry` and `target`. Identity is supplied only by an
explicit trusted alias map (e.g. `alias:'fixture-a'` chosen by the caller from a
configuration the caller owns) — never derived from, or echoed out of, the receipt.
Where a consumer needs identity, the alias is the only exported form; the raw value
stays inside the driver. Two further points: (a) an absent identifier is honest,
whereas a truncated one can look like an identity while being ambiguous; (b) alias
uniqueness and scope are the caller's responsibility and must be recorded, or two
different targets can share a label.

### 6.3 Deliberately excluded (never in an exported report)

| Excluded | Why |
| --- | --- |
| `provenance.testRoot`, `profileName` | a filesystem path / profile name. **`host.armed` does not replace them**: armed is an authorization boolean, not identity proof and not evidence of *where* the run happened. Omitting them is a deliberate privacy tradeoff that loses run-identity and reproducibility (open decision 7) |
| `targets[].directory`; entry `id`, `target`, `module`; lifecycle `target`, `entry`, `module` | not one class: `target`/`entry`/`directory` are validated names (no separators, `policy.js:99-115`) that still disclose project or person names, while `module` is unvalidated admin text that may be a specifier or relative path (`driver-core.js:307-320`). Omitted by default; an alias replaces them only when the caller supplies a trusted mapping (§6.2a) |
| `message` (any refusal) | fixed sentence today, but a future code could widen it — not copied |
| invocation `status` text | bounded prose, not a closed enum (`invoke-tool.js:167`) |
| tool arguments, tool output, `callId`, batch ids | raw tool values; never read by the adapter |
| host exception text, entry-id error strings | `describeEntry` swallows them on purpose (`driver-core.js:362-373`) |
| commit, node, wall-clock, duration | driver never emits them (D5) — a `null` gap is allowed only if the shared schema defines it |
| `testTools[].expect` | a registered-name pin, not an expected outcome (§2.3(1)) |

### 6.4 No widening, no side effects

The adapter reads values; it does not call `ctx.tools`, does not import the platform
lane, does not retry, does not open a slot, and cannot change an arm state. Trust is
unchanged: the only thing exported is what the driver already decided to report.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| a consumer reads `outcome:"performed"` as “test passed” | `assertion:null` + `assertionEvaluated:false` are mandatory fields; the schema doc states it |
| a future receipt field leaks a path/default | closed allowlist projection; a field the adapter does not know is dropped, and `ADAPT_UNKNOWN_FIELD` is *not* used to echo it |
| code drift between driver and adapter | the adapter owns a frozen copy of the four vocabularies; a drift test compares sets, added only when approved |
| `ADAPT_*` codes becoming a second refusal vocabulary | fixed, documented list; unknown codes never pass through |
| a caller assumes omitted identity is recoverable | the record says nothing about *which* target ran unless an alias was supplied; the absence is explicit in the schema note, not an empty string |
| a bounded free-form string carries a path or secret | §6.2a: omit by default; alias only from a trusted caller-owned map; length bounds are not treated as sanitization |

## 8. Open decisions (pending Lead approval)

1. Schema id and version namespace, and which repository owns it (D7).
2. Whether `evidence.tier` should be `driver-reported` or omitted entirely.
3. Whether a record may carry an external `runRef` (opaque, non-path) for correlation;
   the driver emits none.
4. Whether the missing baseline is `null` with a documented gap, or a refusal.
5. Whether assertion ids come from a runner contract, and who defines the vocabulary.
6. Which codes are `ADAPT_*` versus “unknown code → refuse”.
7. Whether the driver should stop exposing identifier-bearing fields at all — the real
   path `testRoot`, the free-form `profileName`, the validated names
   `directory`/`entry`/`target`, the unvalidated `module`, the `status` prose (a driver
   change, not this adapter) — out of scope here; note that dropping them from the
   export while they stay in the receipt does not remove them from the model's view.
8. Where records are retained, and their size bound.
9. Whether a trusted alias map is allowed at all, who owns and validates it, and
   whether it must live outside the driver configuration (it must not be inferable
   from receipt content).

## 9. Non-goals

No assertion engine, no runner, no coexistence-document composer, no host control
widening, no schema validator, no new tool, no change to `src/` or `tests/`, and no
claim that any driver call proves host correctness.

*(2026-11-04 aside: `src/` and `tests/` did gain one module afterwards — the
`admission-evidence` projection in §10.1 — so the list above is accurate only as a
statement about **this** design, which would still add no source file of its own.)*

## 10. Status sync (2026-11-04)

Documentation only; no source, test, export or package change, and **no command run
while writing this section**. Everything below is read from files and from the batch
record, not measured here.

### 10.1 What exists now

| Artifact | State |
| --- | --- |
| `src/admission-evidence.js` | implemented: `projectAdmissionEvidence(input, { validateAdmissionEvidence })`, frozen `ADAPTER_CODES`, pure, import-free, closed projection, injected validator called exactly once |
| `src/admission-evidence.d.ts` | implemented: input/result/summary types and the adapter-level refusal contract |
| `tests/admission-evidence.test.js` | written; passed in both the failed batch and the 101/101 recheck |
| `src/index.js`, `src/internal/*`, package exports | unchanged — still the three registered tools (`src/index.js:282-328`), no widening |
| native raw-receipt capture; any evidence-tier or `real-host` conversion; a receipt→assertion runner | **not implemented, not claimed** |

The module is therefore *not* the adapter this document designs. It accepts
caller-evaluated cases and an explicit baseline/coordination/limitations set, builds an
`admission-evidence/0.1-draft.1` document and hands it to the injected validator. It
never sees a driver receipt, so §6's record fields, `ADAPT_*` vocabulary and
`driver-accepted`/`driver-reported` tier are all still unbuilt proposals.

### 10.2 What the two runs say

**First attempt** — `docs/testing/2026-11-04-admission-evidence-batch.md`: 101 tests,
95 pass, **6 fail**, 0 skipped. Verdict **FAILED, not accepted**; any failure stopped
the batch and no retry was attempted. All six failures were outside this driver's test
file (one integration path expectation, four platform analyzer diagnostics cases, one
spec test raising `ReferenceError: ISSUE_CODE_ORDER is not defined`). This record is
preserved unchanged — it is not superseded by the recheck.

**Authorized recheck** — `docs/testing/2026-11-04-admission-evidence-recheck.md`:
101 tests, **101 pass, 0 fail, 0 skipped**, node rc 0, `systemd-run` rc 0, unit
deactivated, hashes stable within the run, no residue. The driver module and its test
were byte-identical across both runs, so this repository contributed no fix between
them; the six fixes landed in the other files.

Four limits that survive the green run, all of which this document keeps:

1. A green recheck does not retract the failed attempt. Both are part of the lane's
   history, and the first one was a real batch result, not a rehearsal.
2. A passing test file is not evidence that anything ran on a real host. Both runs
   executed four literal test files through one serial test-runner invocation inside a sandboxed process tree; neither certifies
   native host behaviour, and no `real-host` label follows from either.
3. The recheck confirms an observable outcome (101/101), not a mechanism, and not the
   correctness of any fix it did not itself perform.
4. Neither run says anything about §5. The module still consumes caller-evaluated cases,
   never a driver receipt, so `coexistence-evidence/0.1` intake is untouched and the
   §6 record remains unbuilt.

### 10.3 Unchanged by this sync

The open decisions in §8, the risks in §7, the non-goals in §9 and the exclusions in
§6.3 still stand, and the privacy constraint is still unmet by the built module in one
respect worth naming: its `limitations` and `baseline.node` fields are free text, so
publication safety remains the caller's explicit responsibility (§6.5 of the
`admission-evidence` spec), not something any validator or adapter guarantees.

## Appendix A. File:line quick reference

| Reference | Content |
| --- | --- |
| `src/index.js:151-163` | `renderReceipt` — closed payload to one text block |
| `src/index.js:282-328` | the three registered tools |
| `src/index.js:129-131` | `ownershipUnavailable()` — fixed deny port |
| `src/internal/driver-core.js:43-59` | `DRIVER_CODES` |
| `src/internal/driver-core.js:70-76` | `STATUS_LIMITS` |
| `src/internal/driver-core.js:98-147` | fixed sentences, `REFUSAL_SHAPE`, `deny()` |
| `src/internal/driver-core.js:360-390` | `describeEntry` projection |
| `src/internal/driver-core.js:412-478` | `buildStatus` (incl. `testRoot`) |
| `src/internal/driver-core.js:649-688` | `receiptOf` — lifecycle vs invocation |
| `src/internal/driver-core.js:920-937` | `status()` |
| `src/internal/driver-core.js:954-1000` | `pluginSetEnabled()` |
| `src/internal/driver-core.js:1119-1215` | `invokeTool()` |
| `src/internal/loader-ops.js:52-99` | phase vocabulary and `entryPhase` |
| `src/internal/invoke-tool.js:33-39,55-68,167` | `INVOKE_CODES`, `inspectResult`, `report` |
| `src/policy.js:41-51,143-153` | `POLICY_CODES`; `expect` must equal `name` |
| `tests/entry.test.js:552-575,665` | status projection and `persisted:'unknown'` pins |
| `docs/testing/2026-11-01-historical-test-records.md:115-133,172-207` | revision gaps; record checklist |
| `acceptance-report.md` | 209/209 driver suite; sandbox-only limitation |
| `dsh-compat-platform/packages/analyzer/src/runtime-evidence.js:62-108,235` | closed coexistence schema and pure validator |
| `src/admission-evidence.js` (`projectAdmissionEvidence`, `ADAPTER_CODES`) | the module built since this design; targets the `admission-evidence` draft, not §6 |
| `docs/testing/2026-11-04-admission-evidence-batch.md` | 101/95/6 batch under `systemd-run` + `bwrap`; FAILED, not accepted |
| `docs/testing/2026-11-04-admission-evidence-recheck.md` | authorized recheck 101/101 under the same envelope; still not host certification |
