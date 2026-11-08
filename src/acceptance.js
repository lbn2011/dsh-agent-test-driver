/**
 * Acceptance judgement for ONE already-validated admission-evidence document.
 *
 * ## What this function is, and what it is not
 *
 * It answers exactly one question: does this document show that every case the
 * caller selected reported its expected status with exactly the assertions the
 * catalog names, each of them `true`? That is a *reading* of a document, not a
 * judgement of a run, a plugin, a host or a repository.
 *
 * It is **not** the schema validator. It reads a document that the canonical
 * validator has already judged (`projects/dsh-compat-spec` `validateAdmissionEvidence`)
 * and says nothing about grammar: `MISSING_ASSERTION`, `INVALID_STATUS` and the
 * rest of §6.7 are not its business and are not re-implemented here. Call it on a
 * refused document and it will judge the wreckage as if it were evidence.
 *
 * It is **not** authentication and not certification. `baseline` and
 * `coordination` are caller assertions the document merely repeats; a hash is a
 * witness to selected bytes, not provenance. `accepted: true` here means the
 * selected cases read as expected — nothing more. It does not upgrade a missing
 * optional case to a pass, and it never turns "the validator accepted this" into
 * "the kit works".
 *
 * ## The catalog is injected, never copied
 *
 * The case ids, the per-case assertion ids and the expected status of each case
 * all come from the `catalog` the caller passes in — in practice the spec's own
 * `CASE_CATALOG`. This module contains no id, no count and no per-case table, so a
 * catalog edit that adds, drops or renames a case reaches this judgement through
 * the argument with no change here, and a catalog this module has never seen is
 * judged by its own contents. Nothing distinguishes a "known" id except membership
 * in that argument.
 *
 * That is narrower than "this judgement cannot disagree with the spec". What is
 * derived is *identity* — which cases exist, which assertions each claims, which
 * of them are required — and the expected status. What is **not** derived is what
 * the vocabulary means: that `refusal` denotes a refused case while anything else
 * denotes a pass, that `refused` and `passed` are the two success statuses, that a
 * case's assertion set is exact rather than a subset. Those are readings of the
 * current §5/§6.2 vocabulary written into this file. If the schema adds an
 * `expectedOutcome` value, changes what a case's success is, or relaxes the
 * assertion set, this file must be revised deliberately: it will not follow.
 *
 * The expected status is derived from the catalog's own `expectedOutcome`:
 * `refusal` means the case's success condition is a refusal (`refused`); anything
 * else means `passed`. `failed` and `not-run` are never expected, so a document
 * reporting either fails acceptance for that case.
 *
 * ## Case sets
 *
 * `caseSet: 'required'` (the default) selects the catalog entries whose `required`
 * flag is true, and is the only set a document is obliged to carry. A known
 * optional case that also appears in the document is *tolerated*: it is not
 * judged, not counted, and cannot make the run accepted — an unselected case is
 * not a claim this judgement makes.
 *
 * `caseSet: 'all'` selects every catalog entry, and additionally means "these and
 * nothing else": a document case outside the catalog is a failure in either set,
 * and under `all` the selected set is exact, so a padded document cannot pass.
 *
 * ## Errors are failures; bad configuration throws
 *
 * For a document that is **parsed JSON data** — the shape `validateAdmissionEvidence`
 * produces — every defect found inside it is reported as a failure record with a
 * closed code rather than an exception, because a caller holding a defective
 * document still needs to read what is wrong with it.
 *
 * That promise is about *content*, and it stops at the JavaScript boundary. This
 * function is not a sandbox and not a defensive parser: if reading the document
 * throws — a getter, a `Proxy` trap, an object whose prototype access throws — the
 * throw propagates. Catching it would mean returning a verdict about contents this
 * function never actually saw, which is worse than the exception.
 *
 * An unusable `catalog` or `options` is a different kind of thing: it is the
 * caller's own bug, and returning a verdict-shaped object for it would make a
 * broken call look like a judged run. Those throw `TypeError`. The same rule the
 * experiment's `judgeAcceptance` applies to its `caseSet` argument applies here.
 *
 * ## Purity
 *
 * No import of any kind: no `node:fs`, no `node:process`, no host, no process
 * spawn, no sibling or spec-repository module, no dynamic import. The catalog and
 * the canonical functions arrive as arguments, which is what keeps this file free
 * of repository-path dependencies.
 *
 * It writes nothing, freezes nothing it was given, and copies nothing: the caller's
 * document and catalog stay theirs, mutable, with their own identity. Only the
 * result — an object this module builds — is frozen. Reading their members is not
 * guarded: a document that throws from a getter or a `Proxy` trap propagates, as
 * described above, because this function assumes parsed data and does not pretend
 * to be a sandbox.
 *
 * @module dsh-agent-test-driver/acceptance
 */

/**
 * Failure codes. Closed, and disjoint from §6.7's validation codes and from the
 * adapter's `ADAPTER_*` list: each one describes the acceptance reading, never a
 * grammar finding.
 */
export const ACCEPTANCE_CODES = Object.freeze([
  /** The document is not a plain object, or its `cases` member is not an array. */
  'DOCUMENT_INVALID',
  /** A case entry is not a plain object, or its `id` is not a non-empty string. */
  'CASE_MALFORMED',
  /** A selected case is absent from the document. */
  'CASE_MISSING',
  /** A document case id is not in the injected catalog. */
  'CASE_UNKNOWN',
  /** A case id appears more than once; neither copy is read as the verdict. */
  'CASE_DUPLICATE',
  /** The case reached a status other than the one its catalog entry expects. */
  'CASE_STATUS',
  /** The case's `assertions` member is not an array. */
  'ASSERTIONS_INVALID',
  /** An assertion is not `{ id, passed }` with a non-empty string id. */
  'ASSERTION_SHAPE',
  /** The same assertion id appears twice in one case. */
  'ASSERTION_DUPLICATE',
  /** An assertion id is not in the catalog's set for this case. */
  'ASSERTION_UNKNOWN',
  /** A catalog assertion id is absent from the case. */
  'ASSERTION_MISSING',
  /** The assertion's `passed` is not literally `true`. */
  'ASSERTION_FAILED',
]);

const CASE_SETS = Object.freeze(['required', 'all']);
const EXPECTED_OUTCOMES = Object.freeze(['refusal', 'completion']);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Plain-object test. Only object literals and `null`-prototype objects count: a
 * `Map`, an array or a class instance would carry state this judgement cannot see.
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * Every index must be an own element holding a non-empty string.
 *
 * Indexed *and* own-property checks are both required. `Array.prototype.every` skips
 * holes, so `Array(1).every(isNonEmptyString)` is vacuously true and a one-hole array
 * would be read as a one-id list — and iterating it hands out `undefined`, which then
 * matches nothing, so the catalog would silently expect an id it never named. A
 * non-string element is rejected here rather than left for a later `includes` call to
 * compare against.
 */
function isNonEmptyStringArray(value) {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, index)) return false;
    if (!isNonEmptyString(value[index])) return false;
  }
  return true;
}

/** Distinctness, checked only after `isNonEmptyStringArray` has excluded holes. */
const hasDistinctEntries = (list) => new Set(list).size === list.length;

function fail(code, caseId) {
  return caseId === undefined ? Object.freeze({ code }) : Object.freeze({ code, caseId });
}

/**
 * Validate and index the injected catalog.
 *
 * Throws `TypeError` on anything unusable, because a catalog that cannot be read
 * means no judgement was made — and a verdict-shaped answer for that would be a
 * lie a caller could publish.
 *
 * @param {unknown} catalog
 * @returns {{ entries: Map<string, object>, requiredIds: string[] }}
 */
function readCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new TypeError('judgeAdmissionAcceptance: catalog must be a non-empty array');
  }

  const entries = new Map();
  const requiredIds = [];

  for (const entry of catalog) {
    if (!isPlainObject(entry)) {
      throw new TypeError('judgeAdmissionAcceptance: every catalog entry must be a plain object');
    }
    if (!isNonEmptyString(entry.id)) {
      throw new TypeError('judgeAdmissionAcceptance: every catalog entry needs a non-empty string id');
    }
    if (entries.has(entry.id)) {
      throw new TypeError(`judgeAdmissionAcceptance: duplicate catalog id ${entry.id}`);
    }
    if (typeof entry.required !== 'boolean') {
      throw new TypeError(`judgeAdmissionAcceptance: catalog entry ${entry.id} needs a boolean required`);
    }
    if (!EXPECTED_OUTCOMES.includes(entry.expectedOutcome)) {
      throw new TypeError(
        `judgeAdmissionAcceptance: catalog entry ${entry.id} needs expectedOutcome "refusal" or "completion"`,
      );
    }
    if (!isNonEmptyStringArray(entry.assertionIds) || entry.assertionIds.length === 0) {
      throw new TypeError(
        `judgeAdmissionAcceptance: catalog entry ${entry.id} needs a non-empty assertionIds list`,
      );
    }
    if (!hasDistinctEntries(entry.assertionIds)) {
      throw new TypeError(`judgeAdmissionAcceptance: catalog entry ${entry.id} repeats an assertion id`);
    }

    entries.set(entry.id, entry);
    if (entry.required) requiredIds.push(entry.id);
  }

  // `required` selecting nothing would accept every document vacuously, which is
  // the one verdict this function must never be able to produce.
  if (requiredIds.length === 0) {
    throw new TypeError('judgeAdmissionAcceptance: catalog names no required case');
  }

  return { entries, requiredIds };
}

/** Options are a closed set: an unknown member is a caller bug, not a hint. */
function readOptions(options) {
  if (!isPlainObject(options)) {
    throw new TypeError('judgeAdmissionAcceptance: options must be a plain object');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'catalog' && key !== 'caseSet') {
      throw new TypeError(`judgeAdmissionAcceptance: unknown option ${String(key)}`);
    }
  }
  const caseSet = hasOwn(options, 'caseSet') ? options.caseSet : 'required';
  if (!CASE_SETS.includes(caseSet)) {
    throw new TypeError('judgeAdmissionAcceptance: caseSet must be "required" or "all"');
  }
  return { caseSet, catalog: readCatalog(options.catalog) };
}

/** `refusal` cases succeed by being refused; every other case succeeds by passing. */
const expectedStatusFor = (entry) => (entry.expectedOutcome === 'refusal' ? 'refused' : 'passed');

/**
 * Judge one document against the injected catalog.
 *
 * @param {object} document A canonical `admission-evidence/0.1-draft.1` document
 *   that `validateAdmissionEvidence` has ALREADY accepted. Judging an unvalidated
 *   or refused document is a caller error this function cannot detect.
 * @param {{ catalog: ReadonlyArray<{ id: string, required: boolean,
 *   expectedOutcome: 'refusal' | 'completion', assertionIds: readonly string[] }>,
 *   caseSet?: 'required' | 'all' }} options The catalog (in practice the spec's own
 *   `CASE_CATALOG`) and, optionally, the case set. Nothing is defaulted from a file
 *   or a repository: an omitted catalog throws.
 * @returns {{ accepted: boolean, failures: ReadonlyArray<{ code: string,
 *   caseId?: string }>, caseSet: 'required' | 'all' }} Frozen, including every
 *   failure record and the `failures` array. `accepted` is exactly
 *   `failures.length === 0`; there is no partial acceptance and no warning tier.
 * @throws {TypeError} When `options`, `catalog` or `caseSet` is unusable. A defect
 *   in the *contents* of a parsed-JSON document is reported as a failure, not
 *   thrown; a document whose properties throw while being read propagates that
 *   throw (this is not a sandbox).
 */
export function judgeAdmissionAcceptance(document, options) {
  const { caseSet, catalog } = readOptions(options);
  const { entries: catalogEntries, requiredIds } = catalog;

  const selectedIds = caseSet === 'all' ? [...catalogEntries.keys()] : [...requiredIds];
  const failures = [];

  /* ---- pass 1: the document's own shape, with no case judged yet ---- */

  const documented = new Map();
  const duplicated = new Set();

  if (!isPlainObject(document) || !Array.isArray(document.cases)) {
    return Object.freeze({
      accepted: false,
      failures: Object.freeze([fail('DOCUMENT_INVALID')]),
      caseSet,
    });
  }

  for (const entry of document.cases) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.id)) {
      // No id to name: a malformed entry is reported without one rather than
      // attached to a neighbouring case.
      failures.push(fail('CASE_MALFORMED'));
      continue;
    }
    if (!catalogEntries.has(entry.id)) {
      // Unknown in EITHER set. A document carrying an id this catalog does not
      // name is not evidence about anything the caller selected.
      failures.push(fail('CASE_UNKNOWN', entry.id));
      continue;
    }
    if (documented.has(entry.id)) {
      // Recorded once, and neither copy is read: a last-wins map would let a
      // second copy decide the verdict while the first sits unread.
      if (!duplicated.has(entry.id)) {
        duplicated.add(entry.id);
        failures.push(fail('CASE_DUPLICATE', entry.id));
      }
      continue;
    }
    documented.set(entry.id, entry);
  }

  /* ---- pass 2: the selected cases, in catalog order ---- */

  for (const caseId of selectedIds) {
    // A duplicated case is already explained; judging its assertions would read
    // one of the two copies and contradict the note above.
    if (duplicated.has(caseId)) continue;

    const entry = documented.get(caseId);
    if (entry === undefined) {
      failures.push(fail('CASE_MISSING', caseId));
      continue;
    }

    const catalogEntry = catalogEntries.get(caseId);
    const expectedStatus = expectedStatusFor(catalogEntry);

    if (entry.status !== expectedStatus) {
      // `failed` and `not-run` are never the expected status, so they land here.
      failures.push(fail('CASE_STATUS', caseId));
    }

    if (!Array.isArray(entry.assertions)) {
      failures.push(fail('ASSERTIONS_INVALID', caseId));
      continue;
    }

    const seen = new Set();
    for (const assertion of entry.assertions) {
      if (!isPlainObject(assertion) || !isNonEmptyString(assertion.id)) {
        failures.push(fail('ASSERTION_SHAPE', caseId));
        continue;
      }
      if (seen.has(assertion.id)) {
        failures.push(fail('ASSERTION_DUPLICATE', caseId));
        continue;
      }
      seen.add(assertion.id);
      if (!catalogEntry.assertionIds.includes(assertion.id)) {
        // The catalog's set is exact, so an extra id is a defect, not a bonus.
        failures.push(fail('ASSERTION_UNKNOWN', caseId));
        continue;
      }
      // Literally `true`. A truthy value or a string is a failure, never a pass.
      if (assertion.passed !== true) {
        failures.push(fail('ASSERTION_FAILED', caseId));
      }
    }

    for (const assertionId of catalogEntry.assertionIds) {
      if (!seen.has(assertionId)) failures.push(fail('ASSERTION_MISSING', caseId));
    }
  }

  // A known optional case under `required` is deliberately absent from pass 2:
  // it is tolerated in the document and claims nothing here.

  return Object.freeze({
    accepted: failures.length === 0,
    failures: Object.freeze(failures),
    caseSet,
  });
}
