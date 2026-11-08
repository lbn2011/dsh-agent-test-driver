/**
 * Projection of caller-evaluated admission assertions into the canonical
 * `admission-evidence/0.1-draft.1` document shape.
 *
 * Why this module exists: the driver observes *operations* — an invocation
 * returned, a lifecycle action settled, a status was answered. A caller decides
 * what those observations *mean* for an admission case, and only the caller can
 * decide, because the meaning of an assertion is fixed by its id in the canonical
 * catalog (`projects/dsh-compat-spec/spec/admission-evidence.md` §6.2), not by
 * anything the driver can see. This module is the seam between the two: it takes
 * the caller's evaluated verdicts and emits a document the canonical validator
 * accepts or rejects, and it does nothing else.
 *
 * Four rules keep it honest, and none may be relaxed:
 *
 * 1. **Projection, never inference.** No assertion value is computed here. In
 *    particular a driver result whose `ok` is `true` is not evidence for anything
 *    (§6.4 rule 2): `ok: true` says a step returned, not that a claim was held,
 *    released or refused. The only status this module touches is the caller's own
 *    case `status`, which it copies verbatim and never evaluates, compares against
 *    an assertion list, or maps from an operation result.
 * 2. **No field of its own.** The document carries the closed field set of §4 and
 *    nothing else: no tier, no runner name or version, no timestamp, no plugin id,
 *    no counts, no messages, no paths, no URLs, no error objects (§6.4 rule 4).
 *    The projection is a whitelist, so an unknown input field cannot travel: it is
 *    dropped, never echoed, and never named in a diagnostic.
 * 3. **The catalog is not copied.** The case ids and the assertion sets live in the
 *    canonical spec and in the canonical validator. This module knows none of
 *    them, so it cannot drift from them; it copies whatever the caller supplied and
 *    lets the injected validator decide. The one vocabulary it does read is the
 *    four status words of §5, and only when checking that a *summary line returned
 *    by the validator* agrees with itself — a line's count and its failed-id list
 *    cannot be compared without knowing what its status word means. Nothing is
 *    mapped onto those words here. Ids are compared only with other ids of the same
 *    summary — `present` against the reported case ids, `required` and `unknown`
 *    against them — never against a catalog, so an id this package has never seen is
 *    still just an opaque string it carries.
 * 4. **It owns only what it built.** Objects and arrays this module creates are
 *    frozen, because they are the evidence it hands out. Values it merely carries
 *    through — a `limitations` entry, a wrongly typed `baseline` — stay borrowed:
 *    they are neither cloned, nor frozen, nor treated as the module's own state.
 *    Freezing a caller's object would be this module mutating the caller.
 *
 * What this module deliberately does not promise: it is not a sanitiser. §6.5
 * says validation is a grammar check, and `limitations[]` and `baseline.node` are
 * free-form strings that can hold an operation name, a path fragment or an
 * environment token while still validating. Publication-safe metadata is the
 * caller's explicit responsibility; the recommended default here is to omit
 * `labels` entirely, and the adapter applies no content heuristic of its own.
 *
 * It is also not a type checker for the caller's material. A wrong type is copied
 * as it stands so the canonical validator can report `WRONG_TYPE` against the right
 * path; the alternative — dropping the member — would turn a defect into a
 * `MISSING_FIELD` and hide where the fault really is.
 *
 * It is pure: no I/O, no clock, no environment, no randomness, no `eval`, no
 * dynamic import, and no import of any sibling module — the canonical validator is
 * injected by the caller, so this file has no dependency on the spec repository and
 * cannot accidentally acquire one.
 *
 * @module dsh-agent-test-driver/admission-evidence
 */

/**
 * Adapter-level diagnostic codes.
 *
 * These describe states of the *seam*, not of an admission document, so they are
 * deliberately outside the canonical closed code list of §6.7 and are prefixed to
 * stay disjoint from it. A consumer that maps codes must not present one of these
 * as a verdict about the run: every one of them means the document was never
 * judged, or was judged by something that did not answer as §6.6 requires.
 */
export const ADAPTER_CODES = Object.freeze([
  /** The input was not a plain object, or reading it threw. */
  'ADAPTER_INVALID_INPUT',
  /** No usable `validateAdmissionEvidence` function was injected. */
  'ADAPTER_INVALID_VALIDATOR',
  /** The injected validator threw. The thrown value is discarded, never projected. */
  'ADAPTER_VALIDATOR_THREW',
  /** The injected validator returned a thenable; this adapter is synchronous. */
  'ADAPTER_VALIDATOR_ASYNC',
  /** The validator's return value did not match §6.6 exactly. */
  'ADAPTER_VALIDATOR_CONTRACT',
]);

/**
 * The decided version literal of §4. Authored here, never taken from the input:
 * an input-supplied `schemaVersion` is an unknown field and is dropped, so a
 * caller cannot relabel the document it is producing. It is also the value a
 * summary must carry, which is a check on the validator, not a catalog copy.
 */
const SCHEMA_VERSION = 'admission-evidence/0.1-draft.1';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Plain-object test.
 *
 * Deliberately narrow: only object literals and `null`-prototype objects count,
 * because everything else (a `Map`, an array, a class instance) would carry state
 * the closed field set cannot describe. Note that this test itself can run a
 * hostile `getPrototypeOf` trap; the caller owns that object graph, and the throw
 * becomes `ADAPTER_INVALID_INPUT` rather than an exception escaping this module
 * (§6.6 makes the same promise about parsed JSON).
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Copy an array while preserving holes, and freeze the copy this module owns.
 *
 * A hole must stay a hole: filling it with `undefined` would turn a sparse input
 * into a dense one and hide the very defect the validator reports as
 * `SPARSE_ARRAY`. Length is preserved for the same reason — a truncated array
 * would look complete. Only **own** indices count: an inherited member is not an
 * element of this array, and copying it would invent an entry.
 */
function copyOwnArrayLike(value, projectItem) {
  const out = new Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    if (hasOwn(value, index)) {
      out[index] = projectItem(value[index]);
    }
  }
  return Object.freeze(out);
}

/**
 * Copy a string list verbatim: no trimming, no deduplication, no dropping.
 *
 * §6.5 relies on this. The lane does not scan these strings, and an adapter that
 * silently trimmed one would be performing the sanitisation the lane says it does
 * not perform, while leaving the impression that it happened. Entries are carried
 * by reference, so a non-string entry (or an object smuggled into the list) is
 * preserved for the validator to reject and is never frozen by us.
 */
function copyStringList(value) {
  if (!Array.isArray(value)) {
    return value; // Not our type to judge: the validator reports WRONG_TYPE.
  }
  return copyOwnArrayLike(value, (item) => item);
}

function projectBaseline(value) {
  if (!isPlainObject(value)) {
    return value; // Wrong type is the validator's finding, not ours.
  }
  const out = {};
  if (hasOwn(value, 'commit')) out.commit = value.commit;
  if (hasOwn(value, 'node')) out.node = value.node;
  return Object.freeze(out);
}

function projectCoordination(value) {
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  if (hasOwn(value, 'coordinatorIdentity')) out.coordinatorIdentity = value.coordinatorIdentity;
  if (hasOwn(value, 'provisioning')) out.provisioning = value.provisioning;
  if (hasOwn(value, 'scopeVisibility')) out.scopeVisibility = value.scopeVisibility;
  return Object.freeze(out);
}

/**
 * Project the optional alias object.
 *
 * `coordinator` is the only member §4 allows, and it is copied exactly as given:
 * the grammar check belongs to the validator, an explicit caller choice of alias is
 * theirs to make, and stripping a non-conforming value here would be the privacy
 * heuristic this lane says it does not perform. Any other member of `labels` is an
 * unknown field and is dropped.
 */
function projectLabels(value) {
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  if (hasOwn(value, 'coordinator')) out.coordinator = value.coordinator;
  return Object.freeze(out);
}

function projectAssertion(value) {
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  if (hasOwn(value, 'id')) out.id = value.id;
  if (hasOwn(value, 'passed')) out.passed = value.passed;
  return Object.freeze(out);
}

function projectCase(value) {
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  if (hasOwn(value, 'id')) out.id = value.id;
  if (hasOwn(value, 'status')) out.status = value.status;
  if (hasOwn(value, 'assertions')) {
    out.assertions = Array.isArray(value.assertions)
      ? copyOwnArrayLike(value.assertions, projectAssertion)
      : value.assertions;
  }
  if (hasOwn(value, 'limitations')) out.limitations = copyStringList(value.limitations);
  return Object.freeze(out);
}

/**
 * Build the closed document from the input's own members.
 *
 * A member the caller omitted stays omitted. That is the whole point: §6.4 rule 5
 * and rule 6 forbid a manufactured `false` and forbid relabelling an
 * under-observed attempt as `not-run`, so this function never fills a gap with a
 * default, a placeholder or an empty string. A missing `baseline.node` reaches the
 * validator as a missing key and comes back as `MISSING_FIELD`.
 */
function projectDocument(input) {
  const document = { schemaVersion: SCHEMA_VERSION };
  if (hasOwn(input, 'baseline')) document.baseline = projectBaseline(input.baseline);
  if (hasOwn(input, 'coordination')) {
    document.coordination = projectCoordination(input.coordination);
  }
  // `labels` is optional and omitted by default (§4): the alias is caller-chosen
  // and can be linkable in ways no validator detects. When the caller does supply
  // it, only `coordinator` survives.
  if (hasOwn(input, 'labels')) document.labels = projectLabels(input.labels);
  if (hasOwn(input, 'cases')) {
    document.cases = Array.isArray(input.cases)
      ? copyOwnArrayLike(input.cases, projectCase)
      : input.cases;
  }
  if (hasOwn(input, 'limitations')) document.limitations = copyStringList(input.limitations);
  return Object.freeze(document);
}

const isThenable = (value) =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? typeof value.then === 'function'
    : false;

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/** A dense array of non-empty strings. Holes and non-strings are not elements here. */
function isNonEmptyStringArray(value) {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, index) || !isNonEmptyString(value[index])) return false;
  }
  return true;
}

/**
 * No id may be listed twice.
 *
 * Applied to every id list a summary carries. A repeated case id names one case as
 * two, and a repeated id in `failedAssertions` says nothing about which assertion
 * failed twice. Membership is still never checked against a catalog: this is a list
 * checked against itself.
 */
const hasDistinctEntries = (list) => new Set(list).size === list.length;

/** Does this id list name exactly the keys of `ids`, each once? */
function namesExactly(list, ids) {
  if (list.length !== ids.size) return false;
  for (const id of list) {
    if (!ids.has(id)) return false;
  }
  return true;
}

/**
 * Does this object own exactly `keys` — and nothing else?
 *
 * `Reflect.ownKeys` rather than `Object.keys`, because the closed-shape rule is
 * about *members*, not about enumerable members: a symbol-keyed or non-enumerable
 * entry is still a value travelling unread, which is what §4 refuses and what this
 * seam refuses for a validator's answer. With the counts equal and every expected
 * string key owned, no other key of any kind can be present.
 */
function hasExactlyKeys(value, keys) {
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) return false;
  for (const key of keys) {
    if (!hasOwn(value, key)) return false;
  }
  return true;
}

/**
 * Check one issue against §6.6: exactly `code` and `path`, both strings, with
 * `code` non-empty and `path` allowed to be `""` for the document root.
 *
 * The check is strict on purpose. An extra member would be a value travelling
 * unread — the same defect §4 refuses for documents, refused here for diagnostics
 * so an adapter cannot become the place a raw error message finally gets through.
 */
function isIssue(value) {
  if (!isPlainObject(value)) return false;
  if (!hasExactlyKeys(value, ['code', 'path'])) return false;
  return isNonEmptyString(value.code) && typeof value.path === 'string';
}

/**
 * Check one per-case line of the summary.
 *
 * Shape first, then the internal agreements a readable line has to hold: a case
 * reported `failed` has to name at least one failed assertion and cannot have run
 * none, a case reported `passed` or `refused` cannot name one, and a case reported
 * `not-run` ran no assertion at all and must say why. No line may name more failed
 * assertions than it ran, whatever its status. This mirrors the corrected rule set
 * of the platform lane. It is not a second opinion about admission semantics:
 * nothing here is compared against a catalog. `id` is opaque, and `failedAssertions`
 * only has to be a list of *distinct* ids — an id named twice says nothing about
 * which assertion failed twice.
 *
 * The status vocabulary is closed (§5), so an unfamiliar status is refused instead
 * of tolerated: an unknown label cannot be checked for agreement, and letting it
 * through would allow a summary to invent a verdict vocabulary of its own.
 */
function isSummaryCase(value) {
  if (!isPlainObject(value)) return false;
  if (
    !hasExactlyKeys(value, ['id', 'status', 'assertionCount', 'failedAssertions', 'limitations'])
  ) {
    return false;
  }
  if (!isNonEmptyString(value.id)) return false;
  if (!isNonEmptyString(value.status)) return false;
  if (!Number.isInteger(value.assertionCount) || value.assertionCount < 0) return false;
  // Ids, not a count: the list of the assertions the validator found false.
  if (!isNonEmptyStringArray(value.failedAssertions)) return false;
  // A limitation is a sentence the reader is meant to read, so an empty string is
  // not one. This checks the entries, not their content: §6.5 forbids scanning it.
  if (!isNonEmptyStringArray(value.limitations)) return false;
  if (!hasDistinctEntries(value.failedAssertions)) return false;

  const failedCount = value.failedAssertions.length;
  // More failures than assertions run is arithmetically impossible whatever the
  // status says, so it is refused before the per-status rules are consulted.
  if (failedCount > value.assertionCount) return false;

  switch (value.status) {
    case 'failed':
      return value.assertionCount > 0 && failedCount > 0;
    case 'passed':
    case 'refused':
      return value.assertionCount > 0 && failedCount === 0;
    case 'not-run':
      return value.assertionCount === 0 && failedCount === 0 && value.limitations.length > 0;
    default:
      return false;
  }
}

/**
 * Check the validator's summary against the structure §6.6 fixes.
 *
 * Structural only, and deliberately so. This is a guard against a validator whose
 * success answer cannot be shown to a reader — an empty summary, a summary missing
 * its coverage, a coverage that disagrees with its own cases, a count that is not a
 * count, a line that contradicts itself — not a second opinion about admission
 * semantics.
 *
 * `certification` must be literally `false`: §6.6 fixes it, and a summary claiming
 * otherwise would be the one field that turns a grammar check into a certificate.
 */
function isSummary(value) {
  if (!isPlainObject(value)) return false;
  if (!hasExactlyKeys(value, ['schemaVersion', 'certification', 'coverage', 'cases', 'limitations'])) {
    return false;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) return false;
  if (value.certification !== false) return false;

  const { coverage } = value;
  if (!isPlainObject(coverage)) return false;
  if (!hasExactlyKeys(coverage, ['required', 'present', 'unknown'])) return false;
  if (!isNonEmptyStringArray(coverage.required)) return false;
  if (!isNonEmptyStringArray(coverage.present)) return false;
  if (!isNonEmptyStringArray(coverage.unknown)) return false;
  if (!hasDistinctEntries(coverage.required)) return false;
  if (!hasDistinctEntries(coverage.present)) return false;
  if (!hasDistinctEntries(coverage.unknown)) return false;

  const { cases } = value;
  if (!Array.isArray(cases)) return false;
  const caseIds = new Set();
  for (let index = 0; index < cases.length; index += 1) {
    if (!hasOwn(cases, index)) return false;
    if (!isSummaryCase(cases[index])) return false;
    caseIds.add(cases[index].id);
  }
  if (caseIds.size !== cases.length) return false; // one case id, named twice

  // Coverage has to describe the lines that follow it, or a reader is told a
  // coverage the cases do not show: `present` is exactly the set of reported case
  // ids, every `required` id is among them, and an `unknown` id is not also claimed
  // present. These compare the summary's own members with each other; no list of
  // admissible ids enters into it.
  if (!namesExactly(coverage.present, caseIds)) return false;
  for (const id of coverage.required) {
    if (!caseIds.has(id)) return false;
  }
  for (const id of coverage.unknown) {
    if (caseIds.has(id)) return false;
  }

  return isNonEmptyStringArray(value.limitations);
}

/**
 * Read the validator's return value against §6.6 and decide whether it may be
 * trusted as a verdict.
 *
 * Three rules, all of them about not reading a success that was not said:
 *
 * - The result's key set is closed: `valid`, `issues`, and `summary` only. A fourth
 *   member is a claim travelling unread, so it is refused rather than ignored.
 * - `summary` is present **if and only if** `valid === true`. When `valid === false`
 *   the key must be **absent** — a key holding `undefined` is still a key, and the
 *   contract says absent, so this is a violation and not a tolerated spelling.
 * - A success must be a success that can be read: `issues` empty and a `summary`
 *   matching §6.6. `{}` is not a summary, and `valid: true` with a non-empty issue
 *   list contradicts itself.
 *
 * A validator that answers off-contract has not judged the document, so the caller
 * must not be handed a document at all.
 *
 * @returns {{ valid: boolean, code?: string }}
 */
function readValidatorResult(result) {
  const contract = { valid: false, code: 'ADAPTER_VALIDATOR_CONTRACT' };
  if (!isPlainObject(result)) return contract;
  if (!hasOwn(result, 'valid') || typeof result.valid !== 'boolean') return contract;
  if (!hasOwn(result, 'issues') || !Array.isArray(result.issues)) return contract;

  for (let index = 0; index < result.issues.length; index += 1) {
    if (!hasOwn(result.issues, index)) return contract;
    if (!isIssue(result.issues[index])) return contract;
  }

  if (result.valid) {
    if (!hasExactlyKeys(result, ['valid', 'issues', 'summary'])) return contract;
    if (result.issues.length !== 0) return contract;
    if (!isSummary(result.summary)) return contract;
    return { valid: true };
  }

  if (!hasExactlyKeys(result, ['valid', 'issues'])) return contract;
  if (result.issues.length === 0) return contract;
  return { valid: false };
}

/**
 * Copy the validator's issues into fresh two-member objects.
 *
 * Copied rather than passed through so the adapter's output never aliases an
 * object the validator still owns, and so no third member can ride along.
 */
function copyIssues(issues) {
  const out = new Array(issues.length);
  for (let index = 0; index < issues.length; index += 1) {
    out[index] = { code: issues[index].code, path: issues[index].path };
  }
  return out;
}

function refuse(code) {
  // Root path: an adapter-level refusal is a statement about the document as a
  // whole, and it never names a member, because naming one would mean reading the
  // caller's value into a diagnostic.
  return { valid: false, issues: [{ code, path: '' }] };
}

/**
 * Project caller-evaluated admission cases into a canonical document and have the
 * injected validator judge it exactly once.
 *
 * The input is the caller's evaluated material — cases with per-assertion
 * booleans, a baseline, the three coordination states, limitations, and optionally
 * `labels.coordinator` — and never a raw driver result. Every value is copied from
 * that input. Nothing is derived from an operation's status or from an `ok` flag:
 * the case `status` is copied, and its legality against the assertion list is the
 * validator's finding, not this function's.
 *
 * The validator runs once, synchronously, on the document. A validator that throws,
 * returns a thenable, or answers off-contract yields `valid: false` with `ADAPTER_*`
 * and **no document**: an unjudged document must not leave this function, because a
 * caller holding one would render it as evidence. The thrown value is discarded
 * rather than described, since an error message is exactly the free text that can
 * carry a path or a token.
 *
 * @param {object} input Caller-evaluated cases plus baseline, coordination,
 *   limitations, and optionally `labels.coordinator`.
 * @param {{ validateAdmissionEvidence: (value: unknown) => object }} deps The
 *   canonical validator from the spec lane, injected; this module imports nothing.
 * @returns {{ valid: true, issues: [], document: object, summary: object }
 *   | { valid: false, issues: Array<{ code: string, path: string }> }}
 *   `document` and `summary` exist only when the validator judged the document
 *   valid; there is no partial document and no raw exception on any path.
 */
export function projectAdmissionEvidence(input, deps) {
  try {
    if (!isPlainObject(input)) {
      return refuse('ADAPTER_INVALID_INPUT');
    }
    const validator =
      deps !== null && typeof deps === 'object' ? deps.validateAdmissionEvidence : undefined;
    if (typeof validator !== 'function') {
      return refuse('ADAPTER_INVALID_VALIDATOR');
    }

    const document = projectDocument(input);

    let outcome;
    try {
      outcome = validator(document);
    } catch {
      // The thrown value is intentionally not inspected: only its existence is a
      // fact this seam may report.
      return refuse('ADAPTER_VALIDATOR_THREW');
    }
    if (isThenable(outcome)) {
      return refuse('ADAPTER_VALIDATOR_ASYNC');
    }

    const agreement = readValidatorResult(outcome);
    if (agreement.code !== undefined) {
      return refuse(agreement.code);
    }
    if (!agreement.valid) {
      return { valid: false, issues: copyIssues(outcome.issues) };
    }
    // The summary is returned as the validator produced it: this module never
    // rebuilds, extends or recounts it, and `failedAssertions` stays a list of ids.
    return { valid: true, issues: [], document, summary: outcome.summary };
  } catch {
    return refuse('ADAPTER_INVALID_INPUT');
  }
}
