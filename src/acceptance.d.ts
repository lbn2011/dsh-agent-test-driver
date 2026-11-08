/**
 * Types for the acceptance judgement of {@link ./acceptance.js}.
 *
 * Scope: this file describes one pure function — its closed option shape, the
 * catalog it must be given, and the frozen verdict it returns. It does not
 * describe a document: the authority for `admission-evidence/0.1-draft.1` is
 * `projects/dsh-compat-spec/spec/admission-evidence.md` §4 and §6.6, and no type
 * here restates or narrows it.
 *
 * Two absences are deliberate. There is no type for "a run", "a host", "a result
 * of the Loader" — this judgement reads a document and nothing else. And there is
 * no tier, timestamp, path, URL, plugin id or error object anywhere: §6.4 rule 4
 * forbids them in a document, and a type that could express one would invite a
 * caller to try to smuggle it into a verdict.
 */

/** Failure codes, closed. Disjoint from §6.7 validation codes and `ADAPTER_*`. */
export type AcceptanceCode =
  /** The document is not a plain object, or `cases` is not an array. */
  | 'DOCUMENT_INVALID'
  /** A case entry is not a plain object, or its `id` is not a non-empty string. */
  | 'CASE_MALFORMED'
  /** A selected case is absent from the document. */
  | 'CASE_MISSING'
  /** A document case id is not in the injected catalog. */
  | 'CASE_UNKNOWN'
  /** A case id appears more than once; neither copy is read. */
  | 'CASE_DUPLICATE'
  /** The case's status is not the one its catalog entry expects. */
  | 'CASE_STATUS'
  /** The case's `assertions` member is not an array. */
  | 'ASSERTIONS_INVALID'
  /** An assertion is not `{ id, passed }` with a non-empty string id. */
  | 'ASSERTION_SHAPE'
  /** The same assertion id appears twice in one case. */
  | 'ASSERTION_DUPLICATE'
  /** An assertion id is not in the catalog's set for this case. */
  | 'ASSERTION_UNKNOWN'
  /** A catalog assertion id is absent from the case. */
  | 'ASSERTION_MISSING'
  /** The assertion's `passed` is not literally `true`. */
  | 'ASSERTION_FAILED';

/** One failure. `caseId` is absent only when the defect has no case to name. */
export interface AcceptanceFailure {
  code: AcceptanceCode;
  caseId?: string;
}

/**
 * The catalog entry shape this judgement reads.
 *
 * Structurally satisfied by the spec's `CASE_CATALOG` entries; only these four
 * members are consulted, so additional catalog members are ignored rather than
 * rejected. **No id, assertion id or expected status is written down in this
 * package** — a copy would drift from the catalog silently.
 */
export interface AcceptanceCatalogEntry {
  /** Opaque case id. Compared only with the document's ids and this catalog's. */
  id: string;
  /** Whether `caseSet: 'required'` selects this case. */
  required: boolean;
  /** `refusal` means the case succeeds by being refused (`refused`); else `passed`. */
  expectedOutcome: 'refusal' | 'completion';
  /** The exact assertion id set this case must report, each of them `true`. */
  assertionIds: readonly string[];
}

/**
 * Options. Closed: `catalog` is required and the only members read are these two.
 *
 * `caseSet` is `'required'` (default) or `'all'` — deliberately not the fixture's
 * `required-4` / `all-8`: this judgement knows no counts, only the catalog.
 */
export interface AcceptanceOptions {
  catalog: readonly AcceptanceCatalogEntry[];
  caseSet?: 'required' | 'all';
}

/** The frozen verdict. `accepted` is exactly `failures.length === 0`. */
export interface AcceptanceVerdict {
  accepted: boolean;
  failures: readonly AcceptanceFailure[];
  caseSet: 'required' | 'all';
}

/** The closed failure-code list, in declaration order. */
export declare const ACCEPTANCE_CODES: readonly AcceptanceCode[];

/**
 * Judge an already-validated canonical document against an injected catalog.
 *
 * The document must have been accepted by `validateAdmissionEvidence` first: this
 * function is not the schema validator, does not re-check grammar, and says
 * nothing about `certification`, provenance or authentication. `accepted: true`
 * means the selected cases read as their catalog expects — no more.
 *
 * A defect in the *contents* of a parsed-JSON document is reported as a failure,
 * never thrown. An unusable `options`, `catalog` or `caseSet` throws `TypeError`,
 * because no judgement was made and a verdict-shaped answer would be misleading.
 * A document whose members throw while being read — a getter, a `Proxy` trap —
 * propagates that throw: this is not a sandbox, and the parameter is `unknown`
 * rather than a narrowed interface precisely so that the caller, not this file,
 * owes the shape.
 *
 * The document and the catalog are never modified, copied or frozen; only the
 * returned object, its `failures` array and each failure record are frozen.
 *
 * @throws {TypeError} On an unusable catalog or options.
 */
export declare function judgeAdmissionAcceptance(
  document: unknown,
  options: AcceptanceOptions,
): AcceptanceVerdict;
