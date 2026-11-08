/**
 * Tests for the acceptance judgement (`src/acceptance.js`).
 *
 * What these tests can and cannot show.
 *
 * 1. **The real catalog is read here, but not owned here.** The production module
 *    imports nothing; these tests import the spec's own `CASE_CATALOG` by relative
 *    path *as a test-only fixture*, exactly as a caller would inject it. That import
 *    is a test convenience, not a dependency of the shipped module, and the purity
 *    test below proves the module itself has none.
 * 2. **No test asserts that a document is canonical.** The judgement reads a
 *    document the spec validator already accepted; these fixtures are hand-built
 *    documents, so every expectation here is about the *reading*, never about
 *    grammar. A document that the validator would reject is not exercised, because
 *    that is not this function's question.
 * 3. **No case id is written into this file except through the catalog.** Ids come
 *    from `CASE_CATALOG` or from a synthetic catalog invented here; a hardcoded id
 *    would be the copy the module is forbidden to contain, moved one directory over.
 *
 * @module dsh-agent-test-driver/tests/acceptance
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { ACCEPTANCE_CODES, judgeAdmissionAcceptance } from '../src/acceptance.js';
// Test-only: the canonical catalog, injected here the way a caller injects it.
import { CASE_CATALOG } from '../../dsh-compat-spec/src/admission-evidence.js';

const SOURCE_PATH = new URL('../src/acceptance.js', import.meta.url);

const requiredEntries = CASE_CATALOG.filter((entry) => entry.required);
const optionalEntries = CASE_CATALOG.filter((entry) => !entry.required);

/** The status this catalog entry expects — derived, never tabulated in the test. */
const expectedStatus = (entry) => (entry.expectedOutcome === 'refusal' ? 'refused' : 'passed');

/** One case, fully passing, built from its catalog entry. */
function validCase(entry, overrides = {}) {
  return {
    id: entry.id,
    status: expectedStatus(entry),
    assertions: entry.assertionIds.map((id) => ({ id, passed: true })),
    ...overrides,
  };
}

/** A document carrying exactly the given cases, in the given order. */
function documentWith(cases) {
  return {
    schemaVersion: 'admission-evidence/0.1-draft.1',
    baseline: { commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', node: 'v24.9.0' },
    coordination: {
      coordinatorIdentity: 'observed-identical',
      provisioning: 'caller-supplied',
      scopeVisibility: 'same-visibility-scope',
    },
    cases,
    limitations: ['test fixture; not a real run'],
  };
}

const requiredDocument = () => documentWith(requiredEntries.map((entry) => validCase(entry)));
const allDocument = () => documentWith(CASE_CATALOG.map((entry) => validCase(entry)));

const codesOf = (verdict) => verdict.failures.map((failure) => failure.code);

const withCase = (document, replacement) =>
  documentWith([...document.cases.filter((entry) => entry.id !== replacement.id), replacement]);

/* ------------------------------------------------------------------ *
 * The happy path, and the shape of the verdict
 * ------------------------------------------------------------------ */

test('accepts a document whose required cases all read as their catalog expects', () => {
  const verdict = judgeAdmissionAcceptance(requiredDocument(), { catalog: CASE_CATALOG });

  assert.deepEqual(verdict, { accepted: true, failures: [], caseSet: 'required' });
  // The default set is the catalog's own required flag, not a count in this package.
  assert.equal(requiredEntries.length > 0, true);
});

test('accepts all-8 only when every catalog case is present and passing', () => {
  assert.equal(judgeAdmissionAcceptance(allDocument(), { catalog: CASE_CATALOG, caseSet: 'all' }).accepted, true);

  const partial = judgeAdmissionAcceptance(requiredDocument(), { catalog: CASE_CATALOG, caseSet: 'all' });
  assert.equal(partial.accepted, false);
  assert.deepEqual(codesOf(partial), optionalEntries.map(() => 'CASE_MISSING'));
  assert.deepEqual(
    partial.failures.map((failure) => failure.caseId),
    optionalEntries.map((entry) => entry.id),
  );
});

test('freezes the verdict but not the caller material', () => {
  const document = requiredDocument();
  const catalog = CASE_CATALOG;
  const before = JSON.stringify(document);

  const verdict = judgeAdmissionAcceptance(document, { catalog });

  assert.equal(Object.isFrozen(verdict), true);
  assert.equal(Object.isFrozen(verdict.failures), true);
  for (const failure of verdict.failures) assert.equal(Object.isFrozen(failure), true);

  assert.equal(Object.isFrozen(document), false);
  assert.equal(Object.isFrozen(document.cases), false);
  assert.equal(Object.isFrozen(catalog), true, 'the spec catalog arrives frozen; this module must not rely on it');
  assert.equal(JSON.stringify(document), before, 'the document must not be mutated');
});

test('reports the case set it actually judged', () => {
  assert.equal(judgeAdmissionAcceptance(requiredDocument(), { catalog: CASE_CATALOG }).caseSet, 'required');
  assert.equal(judgeAdmissionAcceptance(allDocument(), { catalog: CASE_CATALOG, caseSet: 'all' }).caseSet, 'all');
});

test('is deterministic and stateless across repeated judgements', () => {
  const document = allDocument();
  const first = judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG, caseSet: 'all' });
  const second = judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG, caseSet: 'all' });
  assert.deepEqual(first, second);
});

/* ------------------------------------------------------------------ *
 * Case-set semantics
 * ------------------------------------------------------------------ */

test('a known optional case is tolerated under "required" but claims nothing', () => {
  const optional = optionalEntries[0];
  // Deliberately wrecked: wrong status and no assertions. If the judgement read an
  // unselected case, this would fail.
  const document = documentWith([...requiredDocument().cases, { id: optional.id, status: 'failed', assertions: [] }]);

  assert.equal(judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG }).accepted, true);
});

test('the same wrecked optional case fails under "all"', () => {
  const optional = optionalEntries[0];
  const document = documentWith([...requiredDocument().cases, { id: optional.id, status: 'failed', assertions: [] }]);

  const verdict = judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG, caseSet: 'all' });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.failures.some((failure) => failure.caseId === optional.id), true);
});

test('a case id outside the catalog fails in either set', () => {
  const document = documentWith([...requiredDocument().cases, { id: 'not-in-any-catalog', status: 'passed', assertions: [] }]);

  for (const caseSet of ['required', 'all']) {
    const verdict = judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG, caseSet });
    assert.equal(verdict.accepted, false);
    assert.equal(codesOf(verdict).includes('CASE_UNKNOWN'), true);
    assert.equal(verdict.failures.find((failure) => failure.code === 'CASE_UNKNOWN').caseId, 'not-in-any-catalog');
  }
});

test('a missing selected case is named, not skipped', () => {
  const dropped = requiredEntries[0];
  const document = documentWith(requiredDocument().cases.filter((entry) => entry.id !== dropped.id));

  const verdict = judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG });
  assert.deepEqual(verdict.failures, [{ code: 'CASE_MISSING', caseId: dropped.id }]);
});

test('a duplicated case fails once, and neither copy decides the verdict', () => {
  const entry = requiredEntries[0];
  // Two copies that disagree: if either were read, a status or assertion failure
  // would appear alongside the duplicate.
  const document = documentWith([
    ...requiredDocument().cases,
    validCase(entry),
    validCase(entry, { status: 'failed', assertions: [] }),
  ]);

  const verdict = judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG });
  assert.equal(verdict.accepted, false);
  assert.deepEqual(verdict.failures, [{ code: 'CASE_DUPLICATE', caseId: entry.id }]);
});

/* ------------------------------------------------------------------ *
 * Per-case defects
 * ------------------------------------------------------------------ */

test('a status other than the expected one fails, including failed and not-run', () => {
  const entry = requiredEntries[0];
  for (const status of ['failed', 'not-run']) {
    const verdict = judgeAdmissionAcceptance(withCase(requiredDocument(), validCase(entry, { status })), {
      catalog: CASE_CATALOG,
    });
    assert.equal(verdict.accepted, false);
    assert.deepEqual(verdict.failures, [{ code: 'CASE_STATUS', caseId: entry.id }]);
  }
});

test('the refusal case expects refused, and a refusal elsewhere is not a pass', () => {
  const refusalEntry = CASE_CATALOG.find((entry) => entry.expectedOutcome === 'refusal');
  const completionEntry = CASE_CATALOG.find((entry) => entry.expectedOutcome === 'completion');

  // The catalog's refusal case reported as passed.
  const refusedAsPassed = judgeAdmissionAcceptance(
    withCase(requiredDocument(), validCase(refusalEntry, { status: 'passed' })),
    { catalog: CASE_CATALOG },
  );
  assert.deepEqual(refusedAsPassed.failures, [{ code: 'CASE_STATUS', caseId: refusalEntry.id }]);

  // A completion case reported as refused.
  const passedAsRefused = judgeAdmissionAcceptance(
    withCase(requiredDocument(), validCase(completionEntry, { status: 'refused' })),
    { catalog: CASE_CATALOG },
  );
  assert.deepEqual(passedAsRefused.failures, [{ code: 'CASE_STATUS', caseId: completionEntry.id }]);
});

test('a missing assertion fails', () => {
  const entry = requiredEntries[0];
  const caseEntry = validCase(entry, { assertions: validCase(entry).assertions.slice(1) });

  const verdict = judgeAdmissionAcceptance(withCase(requiredDocument(), caseEntry), { catalog: CASE_CATALOG });
  assert.deepEqual(verdict.failures, [{ code: 'ASSERTION_MISSING', caseId: entry.id }]);
});

test('an extra assertion id fails: the catalog set is exact', () => {
  const entry = requiredEntries[0];
  const caseEntry = validCase(entry, {
    assertions: [...validCase(entry).assertions, { id: 'invented-assertion', passed: true }],
  });

  const verdict = judgeAdmissionAcceptance(withCase(requiredDocument(), caseEntry), { catalog: CASE_CATALOG });
  assert.deepEqual(verdict.failures, [{ code: 'ASSERTION_UNKNOWN', caseId: entry.id }]);
});

test('a duplicated assertion fails once', () => {
  const entry = requiredEntries[0];
  const assertions = validCase(entry).assertions;
  const caseEntry = validCase(entry, { assertions: [...assertions, assertions[0]] });

  const verdict = judgeAdmissionAcceptance(withCase(requiredDocument(), caseEntry), { catalog: CASE_CATALOG });
  assert.deepEqual(verdict.failures, [{ code: 'ASSERTION_DUPLICATE', caseId: entry.id }]);
});

test('only literal true passes: false, truthy strings and numbers all fail', () => {
  const entry = requiredEntries[0];
  for (const passed of [false, 'true', 1, null, undefined, 0]) {
    const assertions = validCase(entry).assertions.map((assertion, index) =>
      index === 0 ? { id: assertion.id, passed } : assertion,
    );
    const verdict = judgeAdmissionAcceptance(withCase(requiredDocument(), validCase(entry, { assertions })), {
      catalog: CASE_CATALOG,
    });
    assert.equal(verdict.accepted, false, `passed=${String(passed)} must not be read as true`);
    assert.deepEqual(verdict.failures, [{ code: 'ASSERTION_FAILED', caseId: entry.id }]);
  }
});

test('an assertion that is not { id, passed } fails as a shape defect', () => {
  const entry = requiredEntries[0];
  const rest = validCase(entry).assertions.slice(2);
  // No id at position 0, a non-string id at position 1: one shape failure each,
  // and the two catalog ids they displaced are then simply missing.
  const caseEntry = validCase(entry, { assertions: [{ passed: true }, { id: 42, passed: true }, ...rest] });

  const verdict = judgeAdmissionAcceptance(withCase(requiredDocument(), caseEntry), { catalog: CASE_CATALOG });
  assert.deepEqual(codesOf(verdict), [
    'ASSERTION_SHAPE',
    'ASSERTION_SHAPE',
    'ASSERTION_MISSING',
    'ASSERTION_MISSING',
  ]);
  assert.equal(verdict.accepted, false);
});

test('an unknown extra member on an assertion is ignored, not read as a claim', () => {
  const entry = requiredEntries[0];
  const assertions = validCase(entry).assertions.map((assertion) =>
    assertion.id === validCase(entry).assertions[0].id ? { ...assertion, note: 'smuggled' } : assertion,
  );

  const verdict = judgeAdmissionAcceptance(withCase(requiredDocument(), validCase(entry, { assertions })), {
    catalog: CASE_CATALOG,
  });
  // Nothing about the acceptance reading changes: the passed assertion is the whole
  // claim, and a note beside it is not evidence for or against.
  assert.equal(verdict.accepted, true);
});

test('a non-array assertions member fails without throwing', () => {
  const entry = requiredEntries[0];
  for (const assertions of [null, {}, 'list', 3]) {
    const verdict = judgeAdmissionAcceptance(withCase(requiredDocument(), validCase(entry, { assertions })), {
      catalog: CASE_CATALOG,
    });
    assert.deepEqual(verdict.failures, [{ code: 'ASSERTIONS_INVALID', caseId: entry.id }]);
  }
});

/* ------------------------------------------------------------------ *
 * Malformed documents are failures, never throws
 * ------------------------------------------------------------------ */

test('a document that is not a plain object is a failure, not an exception', () => {
  for (const document of [null, undefined, 42, 'doc', [], new Map()]) {
    const verdict = judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG });
    assert.deepEqual(verdict, { accepted: false, failures: [{ code: 'DOCUMENT_INVALID' }], caseSet: 'required' });
  }
});

test('a document whose cases member is not an array is a failure', () => {
  const verdict = judgeAdmissionAcceptance({ cases: {} }, { catalog: CASE_CATALOG });
  assert.deepEqual(verdict.failures, [{ code: 'DOCUMENT_INVALID' }]);
});

test('a case entry with no usable id is reported without naming a case', () => {
  const document = documentWith([...requiredDocument().cases, { status: 'passed', assertions: [] }, null]);

  const verdict = judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG });
  assert.deepEqual(codesOf(verdict), ['CASE_MALFORMED', 'CASE_MALFORMED']);
  for (const failure of verdict.failures) assert.equal('caseId' in failure, false);
});

/* ------------------------------------------------------------------ *
 * Unusable configuration throws: no judgement was made
 * ------------------------------------------------------------------ */

test('an unusable catalog or options throws TypeError instead of returning a verdict', () => {
  const document = requiredDocument();
  const entry = requiredEntries[0];

  const cases = [
    ['no options', () => judgeAdmissionAcceptance(document)],
    ['null options', () => judgeAdmissionAcceptance(document, null)],
    ['no catalog', () => judgeAdmissionAcceptance(document, {})],
    ['empty catalog', () => judgeAdmissionAcceptance(document, { catalog: [] })],
    ['catalog not an array', () => judgeAdmissionAcceptance(document, { catalog: {} })],
    ['unknown option', () => judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG, mode: 'all' })],
    ['fixture vocabulary', () => judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG, caseSet: 'required-4' })],
    ['non-string caseSet', () => judgeAdmissionAcceptance(document, { catalog: CASE_CATALOG, caseSet: 4 })],
    ['entry not an object', () => judgeAdmissionAcceptance(document, { catalog: [null] })],
    ['entry without id', () => judgeAdmissionAcceptance(document, { catalog: [{ ...entry, id: '' }] })],
    ['entry without required flag', () => judgeAdmissionAcceptance(document, { catalog: [{ ...entry, required: 'yes' }] })],
    [
      'entry with unknown expectedOutcome',
      () => judgeAdmissionAcceptance(document, { catalog: [{ ...entry, expectedOutcome: 'success' }] }),
    ],
    ['entry without assertions', () => judgeAdmissionAcceptance(document, { catalog: [{ ...entry, assertionIds: [] }] })],
    // A one-hole array has length 1, and `Array.prototype.every` skips the hole, so a
    // value-wise scan alone would call it a one-id list and then hand out `undefined`.
    [
      'entry with a sparse assertionIds',
      () => judgeAdmissionAcceptance(document, { catalog: [{ ...entry, assertionIds: Array(1) }] }),
    ],
    [
      'entry with a non-string assertion id',
      () => judgeAdmissionAcceptance(document, { catalog: [{ ...entry, assertionIds: [7] }] }),
    ],
    [
      'entry repeating an assertion',
      () =>
        judgeAdmissionAcceptance(document, {
          catalog: [entry, { ...entry, id: 'second', assertionIds: [entry.assertionIds[0], entry.assertionIds[0]] }],
        }),
    ],
    ['duplicate catalog ids', () => judgeAdmissionAcceptance(document, { catalog: [entry, { ...entry }] })],
    [
      'catalog with no required case',
      () => judgeAdmissionAcceptance(document, { catalog: optionalEntries.map((item) => ({ ...item, required: false })) }),
    ],
  ];

  for (const [label, run] of cases) {
    assert.throws(run, TypeError, `${label} must throw`);
  }
});

/* ------------------------------------------------------------------ *
 * No copied catalog, no dependency
 * ------------------------------------------------------------------ */

test('judges a synthetic catalog: no id or count is known to the module', () => {
  const catalog = [
    {
      id: 'synthetic-only',
      required: true,
      expectedOutcome: 'completion',
      assertionIds: ['synthetic-a', 'synthetic-b'],
    },
    { id: 'synthetic-refusal', required: true, expectedOutcome: 'refusal', assertionIds: ['synthetic-c'] },
  ];
  const document = {
    cases: [
      { id: 'synthetic-only', status: 'passed', assertions: [{ id: 'synthetic-a', passed: true }, { id: 'synthetic-b', passed: true }] },
      { id: 'synthetic-refusal', status: 'refused', assertions: [{ id: 'synthetic-c', passed: true }] },
    ],
  };

  assert.deepEqual(judgeAdmissionAcceptance(document, { catalog }), {
    accepted: true,
    failures: [],
    caseSet: 'required',
  });
});

test('the module imports nothing and names no catalog id', async () => {
  const source = await readFile(SOURCE_PATH, 'utf8');

  assert.deepEqual(ACCEPTANCE_CODES, [
    'DOCUMENT_INVALID',
    'CASE_MALFORMED',
    'CASE_MISSING',
    'CASE_UNKNOWN',
    'CASE_DUPLICATE',
    'CASE_STATUS',
    'ASSERTIONS_INVALID',
    'ASSERTION_SHAPE',
    'ASSERTION_DUPLICATE',
    'ASSERTION_UNKNOWN',
    'ASSERTION_MISSING',
    'ASSERTION_FAILED',
  ]);

  // Purity by inspection: the catalog and the document can only arrive as arguments.
  // Each pattern is anchored on real syntax, so the module's own prose about what it
  // refuses to import cannot satisfy it.
  assert.equal(/^\s*import\s/m.test(source), false, 'the module must import nothing');
  assert.equal(/\bimport\s*\(/.test(source), false, 'no dynamic import');
  assert.equal(/\brequire\s*\(/.test(source), false);
  assert.equal(/from\s+['"]/.test(source), false, 'no module specifier of any kind');
  // No host, no filesystem, no process, no sibling repository.
  assert.equal(/\bchild_process\b/.test(source), false);
  assert.equal(/\bprocess\.\w/.test(source), false);
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(/\bDate\.now\b|\bnew Date\b/.test(source), false, 'no clock: the verdict must not carry a time');
  // No catalog id is written down here either — that would be the copied catalog.
  assert.equal(
    /admission-(admitted|refused-conflict|activation-throw|cleanup-failure|lease-state|tuple-shape|remount-same-coordinator|visibility)/.test(
      source,
    ),
    false,
    'the module must not name a case id',
  );
});
