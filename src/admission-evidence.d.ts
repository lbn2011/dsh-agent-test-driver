/**
 * Types for the admission-evidence adapter of {@link ./admission-evidence.js}.
 *
 * Scope: this file describes only the seam — the caller-evaluated input, the
 * injected canonical validator, and the adapter's result. The document and summary
 * shapes are restated here so a TypeScript consumer sees what it is handed; the
 * authority for both remains `projects/dsh-compat-spec/spec/admission-evidence.md`
 * §4 and §6.6, which this package does not re-derive. No schema file ships, and
 * nothing here asserts that the draft is ratified.
 *
 * Two things are absent on purpose and must not be added: no type stands for a
 * driver operation result (this adapter never reads one), and no type carries a
 * tier, runner, timestamp, plugin id, path, URL or error object, because §6.4
 * rule 4 forbids those in a document and an input type that could express them
 * would invite a caller to try.
 */

/** Adapter-level diagnostics; outside the canonical closed code list of §6.7. */
export type AdapterCode =
  /** The input was not a plain object, or reading it threw. */
  | 'ADAPTER_INVALID_INPUT'
  /** No usable `validateAdmissionEvidence` function was injected. */
  | 'ADAPTER_INVALID_VALIDATOR'
  /** The injected validator threw; the thrown value is discarded. */
  | 'ADAPTER_VALIDATOR_THREW'
  /** The injected validator returned a thenable; the adapter is synchronous. */
  | 'ADAPTER_VALIDATOR_ASYNC'
  /** The validator's return value did not match §6.6 exactly. */
  | 'ADAPTER_VALIDATOR_CONTRACT';

/**
 * One validator issue: a location and a code, and nothing else.
 *
 * `path` is `""` for the document root and is a location only — never a value, a
 * URL, a filesystem path or an error message.
 */
export interface ValidationIssue {
  code: string;
  path: string;
}

/** The four status words of §5. Their legality per case is the validator's call. */
export type AdmissionCaseStatus = 'passed' | 'refused' | 'failed' | 'not-run';

/** One caller-evaluated assertion. `passed` is a verdict, never a count or a message. */
export interface AdmissionAssertionInput {
  id: string;
  passed: boolean;
}

/**
 * One case as the caller supplies it.
 *
 * Every member is optional in the input type because the adapter must be able to
 * receive an under-specified case and let the validator refuse it: a required
 * member typed as required would push a caller towards filling the gap with a
 * default, which §6.4 forbids.
 */
export interface AdmissionCaseInput {
  id?: string;
  status?: AdmissionCaseStatus;
  assertions?: AdmissionAssertionInput[];
  limitations?: string[];
}

/**
 * Caller-evaluated material.
 *
 * `limitations` and `baseline` carry free-form strings that a validator accepts
 * and does not scan (§6.5), so an operation name, a path fragment or an
 * environment token can live in them and still validate. Keeping them
 * publication-safe is the caller's explicit responsibility; the adapter adds no
 * heuristic and claims none.
 *
 * `labels` is optional and omitted by default: the coordinator alias is
 * caller-chosen, grammar-checked only, and can be linkable in ways no validator
 * detects. It is never an identity.
 */
export interface AdmissionEvidenceInput {
  baseline?: {
    commit?: string;
    node?: string;
  };
  coordination?: {
    coordinatorIdentity?: 'observed-identical' | 'different' | 'not-compared';
    provisioning?: 'caller-supplied' | 'not-determined';
    scopeVisibility?: 'same-visibility-scope' | 'different-scope' | 'not-determined';
  };
  labels?: {
    coordinator?: string;
  };
  cases?: AdmissionCaseInput[];
  limitations?: string[];
}

/** The closed document of §4, as this adapter projects it. */
export interface AdmissionEvidenceDocument {
  schemaVersion: 'admission-evidence/0.1-draft.1';
  baseline?: {
    commit?: string;
    node?: string;
  };
  coordination?: {
    coordinatorIdentity?: 'observed-identical' | 'different' | 'not-compared';
    provisioning?: 'caller-supplied' | 'not-determined';
    scopeVisibility?: 'same-visibility-scope' | 'different-scope' | 'not-determined';
  };
  labels?: {
    coordinator?: string;
  };
  cases?: Array<{
    id?: string;
    status?: AdmissionCaseStatus;
    assertions?: Array<{ id?: string; passed?: boolean }>;
    limitations?: string[];
  }>;
  limitations?: string[];
}

/**
 * The validator's minimal summary, restated from §6.6 for the reader's convenience.
 *
 * The adapter never builds, extends or recounts this object: it is returned as the
 * validator produced it. In particular `failedAssertions` is the list of ids the
 * validator found false — an adapter must not add a count, a ratio or a verdict.
 *
 * It is checked structurally before a success is accepted: exact key set, the
 * `schemaVersion` literal, `certification` literally `false`, three non-empty-string
 * arrays under `coverage`, and per case an id, a status, an integer `assertionCount`,
 * a `failedAssertions` id list and a non-empty-string `limitations` list. Each case
 * line must also agree with itself: `failed` needs a non-zero `assertionCount` and at
 * least one failed id, `passed` and `refused` need a non-zero `assertionCount` and no
 * failed id, `not-run` needs a zero `assertionCount`, no failed id and at least one
 * limitation, no id may appear twice in `failedAssertions`, and no line may name more
 * failed ids than its `assertionCount`. The coverage must agree with the lines: no
 * repeated id in `required`, `present` or `unknown`, no repeated case id, `present` is
 * exactly the set of reported case ids, every `required` id is among them, and an
 * `unknown` id is not also reported. A status outside `AdmissionCaseStatus` is refused
 * rather than interpreted. No case or assertion id is checked for membership anywhere
 * in this package — the catalog is not copied here, so an unknown id is a finding for
 * the validator to make, not for the adapter.
 */
export interface ValidatorSummary {
  schemaVersion: 'admission-evidence/0.1-draft.1';
  certification: false;
  coverage: {
    required: string[];
    present: string[];
    unknown: string[];
  };
  cases: Array<{
    id: string;
    status: AdmissionCaseStatus;
    assertionCount: number;
    failedAssertions: string[];
    limitations: string[];
  }>;
  limitations: string[];
}

/**
 * The canonical validator's return value (§6.6).
 *
 * The adapter enforces this shape rather than trusting it. The key set is closed
 * over *members*, not over enumerable members: a symbol-keyed or non-enumerable extra
 * is refused exactly like a visible one, because an unread value must not ride home
 * inside a success. `summary` is present if and only if `valid === true`; on a failure
 * the key must be **absent** — a key holding `undefined` counts as present and is
 * refused, because the contract says absent. On success `issues` must be empty and
 * `summary` must match `ValidatorSummary` structurally, so `valid: true` with
 * `summary: {}` is a contract violation, not a pass.
 */
export interface ValidatorResult {
  valid: boolean;
  issues: ValidationIssue[];
  summary?: ValidatorSummary;
}

/** The canonical validator, injected. Synchronous and pure; imported from nowhere here. */
export type ValidateAdmissionEvidence = (value: unknown) => ValidatorResult;

/** The injected dependency bag. */
export interface AdmissionEvidenceDeps {
  validateAdmissionEvidence: ValidateAdmissionEvidence;
}

/**
 * Adapter result.
 *
 * `document` and `summary` exist only on the valid branch. There is no partial
 * document, and an unjudged document never leaves the adapter: a caller holding
 * one would render it as evidence.
 */
export type AdmissionEvidenceProjection =
  | {
      valid: true;
      issues: [];
      document: AdmissionEvidenceDocument;
      summary: ValidatorSummary;
    }
  | {
      valid: false;
      issues: ValidationIssue[];
    };

/** The adapter-level codes, frozen at runtime. */
export declare const ADAPTER_CODES: readonly AdapterCode[];

/**
 * Project caller-evaluated cases into the canonical document and have the injected
 * validator judge it exactly once.
 *
 * @param input Caller-evaluated cases plus baseline, coordination, limitations and
 *   optional `labels.coordinator`. Never a raw driver result: an input carrying
 *   one produces a document with the unknown fields dropped, and a status such as
 *   `ok: true` contributes nothing to any assertion.
 * @param deps The canonical validator, injected. This package imports no sibling
 *   module and does not carry a copy of the case or assertion catalog.
 * @returns The validator's verdict. On any adapter-level failure the result is
 *   `{ valid: false, issues: [{ code: 'ADAPTER_*', path: '' }] }`, with no document
 *   and no rethrown exception.
 */
export declare function projectAdmissionEvidence(
  input: AdmissionEvidenceInput,
  deps: AdmissionEvidenceDeps,
): AdmissionEvidenceProjection;
