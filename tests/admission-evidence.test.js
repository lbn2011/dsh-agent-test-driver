/**
 * Tests for the admission-evidence adapter (`src/admission-evidence.js`).
 *
 * What this file can and cannot show. The adapter is a seam between a caller's
 * evaluated verdicts and a canonical validator that lives in another repository,
 * so every test here injects a fake validator: what is under test is the
 * projection and the seam's failure behaviour, never the canonical grammar. Two
 * consequences are stated rather than papered over:
 *
 * 1. **No assertion here is evidence that a canonical document is valid.** The
 *    fake validators answer by script. Only the spec lane's validator can judge a
 *    real document, and that judgement is not made in this package.
 * 2. **The adapter is deliberately ignorant of the catalog.** These tests
 *    therefore use ids like `admission-admitted` only as opaque strings the caller
 *    supplied. A test that asserted "the adapter rejects an unknown case id" would
 *    be asserting a copy of the catalogue lives here, which is exactly what it must
 *    not contain.
 *
 * @module dsh-agent-test-driver/tests/admission-evidence
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { ADAPTER_CODES, projectAdmissionEvidence } from '../src/admission-evidence.js';

const SOURCE_PATH = new URL('../src/admission-evidence.js', import.meta.url);

/** A summary object shaped like §6.6, used as an opaque payload by the fake validator. */
function validSummary() {
  return {
    schemaVersion: 'admission-evidence/0.1-draft.1',
    certification: false,
    coverage: {
      required: ['admission-admitted'],
      present: ['admission-admitted'],
      unknown: [],
    },
    cases: [
      {
        id: 'admission-admitted',
        status: 'passed',
        assertionCount: 1,
        failedAssertions: [],
        limitations: [],
      },
    ],
    limitations: ['in-process run'],
  };
}

/** A well-formed success reply. */
function validReply() {
  return { valid: true, issues: [], summary: validSummary() };
}

/**
 * A minimal caller-evaluated input: one case, one assertion, a baseline and the
 * three coordination states. Nothing here comes from a driver result.
 */
function sampleInput() {
  return {
    baseline: { commit: 'not-recorded', node: 'node-v24' },
    coordination: {
      coordinatorIdentity: 'observed-identical',
      provisioning: 'caller-supplied',
      scopeVisibility: 'not-determined',
    },
    cases: [
      {
        id: 'admission-admitted',
        status: 'passed',
        assertions: [{ id: 'activation-ran-once', passed: true }],
        limitations: [],
      },
    ],
    limitations: ['in-process run'],
  };
}

/** Collect every document handed to the validator, and answer with a fixed reply. */
function recordingValidator(reply) {
  const calls = [];
  return {
    calls,
    validateAdmissionEvidence(value) {
      calls.push(value);
      return reply;
    },
  };
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/** The projected document for `sampleInput()`, spelled out as data. */
const EXPECTED_DOCUMENT = {
  schemaVersion: 'admission-evidence/0.1-draft.1',
  baseline: { commit: 'not-recorded', node: 'node-v24' },
  coordination: {
    coordinatorIdentity: 'observed-identical',
    provisioning: 'caller-supplied',
    scopeVisibility: 'not-determined',
  },
  cases: [
    {
      id: 'admission-admitted',
      status: 'passed',
      assertions: [{ id: 'activation-ran-once', passed: true }],
      limitations: [],
    },
  ],
  limitations: ['in-process run'],
};

test('projects the closed field set and nothing else', () => {
  const deps = recordingValidator(validReply());
  const result = projectAdmissionEvidence(sampleInput(), deps);

  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.document, EXPECTED_DOCUMENT);
  // The validator saw the very object the caller received, not a copy of it.
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0], result.document);
});

test('authors the version literal and ignores an input-supplied one', () => {
  const deps = recordingValidator(validReply());
  const input = { ...sampleInput(), schemaVersion: 'bogus/9', version: 'bogus/9' };
  const result = projectAdmissionEvidence(input, deps);

  assert.equal(result.document.schemaVersion, 'admission-evidence/0.1-draft.1');
  // A caller cannot relabel the document, and the attempt is not echoed anywhere.
  assert.equal(JSON.stringify(result).includes('bogus/9'), false);
});

test('drops unknown fields at every level instead of echoing them', () => {
  const deps = recordingValidator(validReply());
  const result = projectAdmissionEvidence(
    {
      ...sampleInput(),
      toolValue: 'leaky-tool-value',
      ok: true,
      kind: 'invocation',
      evidence: { tier: 'real-host' },
      baseline: { commit: 'not-recorded', node: 'node-v24', root: '/root/secret' },
      coordination: {
        coordinatorIdentity: 'observed-identical',
        provisioning: 'caller-supplied',
        scopeVisibility: 'not-determined',
        resolvedUrl: 'file:///svc/abc.js',
      },
      cases: [
        {
          id: 'admission-admitted',
          status: 'passed',
          evidence: { tier: 'real-host' },
          assertions: [
            { id: 'activation-ran-once', passed: true, message: 'internal detail', error: 'E_X' },
          ],
          limitations: [],
        },
      ],
    },
    deps,
  );

  assert.deepEqual(result.document, EXPECTED_DOCUMENT);
  const serialized = JSON.stringify(result);
  for (const token of [
    'leaky-tool-value',
    '/root/secret',
    'file:///svc/abc.js',
    'internal detail',
    'E_X',
    'real-host',
  ]) {
    assert.equal(serialized.includes(token), false, `leaked: ${token}`);
  }
});

test('labels: omitted by default, coordinator retained, siblings dropped', () => {
  const absent = recordingValidator(validReply());
  projectAdmissionEvidence(sampleInput(), absent);
  assert.equal(Object.hasOwn(absent.calls[0], 'labels'), false);

  const present = recordingValidator(validReply());
  projectAdmissionEvidence(
    { ...sampleInput(), labels: { coordinator: 'pipeline-01', url: 'file:///svc/abc.js' } },
    present,
  );
  // The supported member survives; the unknown nested member does not.
  assert.deepEqual(present.calls[0].labels, { coordinator: 'pipeline-01' });
  assert.equal(JSON.stringify(present.calls[0]).includes('file:///svc/abc.js'), false);
});

test('a label outside the grammar is projected as written, not silently fixed', () => {
  const deps = recordingValidator({
    valid: false,
    issues: [{ code: 'INVALID_LABEL', path: 'labels.coordinator' }],
  });
  const result = projectAdmissionEvidence(
    { ...sampleInput(), labels: { coordinator: 'a/b c' } },
    deps,
  );

  // Stripping or rewriting it here would be a privacy heuristic pretending to be a
  // sanitiser; the grammar check belongs to the validator (§4, §6.7).
  assert.equal(deps.calls[0].labels.coordinator, 'a/b c');
  assert.deepEqual(result.issues, [{ code: 'INVALID_LABEL', path: 'labels.coordinator' }]);
});

test('a driver operation result cannot become a passing record', () => {
  // §6.4 rule 2: `ok: true` says a step returned. It is not evidence for any case.
  const deps = recordingValidator({
    valid: false,
    issues: [
      { code: 'MISSING_FIELD', path: 'baseline' },
      { code: 'MISSING_FIELD', path: 'coordination' },
      { code: 'MISSING_FIELD', path: 'cases' },
    ],
  });
  const result = projectAdmissionEvidence(
    { ok: true, kind: 'invocation', code: 'INVOKE_OK', status: 'completed' },
    deps,
  );

  assert.equal(result.valid, false);
  assert.equal(Object.hasOwn(result, 'document'), false);
  assert.equal(Object.hasOwn(result, 'summary'), false);
  assert.deepEqual(result.issues, [
    { code: 'MISSING_FIELD', path: 'baseline' },
    { code: 'MISSING_FIELD', path: 'coordination' },
    { code: 'MISSING_FIELD', path: 'cases' },
  ]);
  // The receipt's own vocabulary is projected nowhere, not even into a diagnostic.
  assert.equal(JSON.stringify(result).includes('INVOKE_OK'), false);
  // All it produced was a skeleton document with the version literal.
  assert.deepEqual(deps.calls[0], { schemaVersion: 'admission-evidence/0.1-draft.1' });
});

test('omitted values stay omitted: no default is filled in', () => {
  const deps = recordingValidator(validReply());
  const result = projectAdmissionEvidence(
    {
      baseline: { commit: 'not-recorded' },
      coordination: { coordinatorIdentity: 'not-compared' },
      cases: [{ id: 'admission-admitted', assertions: [{ id: 'activation-ran-once' }] }],
    },
    deps,
  );

  const document = deps.calls[0];
  assert.equal(Object.hasOwn(document.baseline, 'node'), false);
  assert.equal(Object.hasOwn(document.coordination, 'provisioning'), false);
  assert.equal(Object.hasOwn(document.coordination, 'scopeVisibility'), false);
  assert.equal(Object.hasOwn(document.cases[0], 'status'), false);
  assert.equal(Object.hasOwn(document.cases[0], 'limitations'), false);
  assert.equal(Object.hasOwn(document.cases[0].assertions[0], 'passed'), false);
  assert.equal(Object.hasOwn(document, 'limitations'), false);
  assert.equal(Object.hasOwn(document, 'labels'), false);
  // Nothing was substituted, so the validator can report the gap itself.
  assert.equal(result.valid, true); // the fake approves whatever it is given
});

test('keeps a false verdict false and copies limitations verbatim', () => {
  const deps = recordingValidator(validReply());
  projectAdmissionEvidence(
    {
      ...sampleInput(),
      cases: [
        {
          id: 'admission-activation-throw',
          status: 'failed',
          assertions: [
            { id: 'rethrow-same-error-identity', passed: false },
            { id: 'claim-quarantined-after-throw', passed: true },
          ],
          limitations: [' rollback threw; identity not observed '],
        },
      ],
    },
    deps,
  );

  const document = deps.calls[0];
  assert.equal(document.cases[0].assertions[0].passed, false);
  // No trimming, no deduplication: an adapter that cleaned this string up would be
  // sanitising, which this lane says it does not do (§6.5).
  assert.deepEqual(document.cases[0].limitations, [' rollback threw; identity not observed ']);
});

test('passes caller-supplied ids through without holding a catalog', () => {
  const deps = recordingValidator({
    valid: false,
    issues: [{ code: 'UNKNOWN_CASE_ID', path: 'cases[0].id' }],
  });
  const result = projectAdmissionEvidence(
    { ...sampleInput(), cases: [{ id: 'not-a-catalog-id', status: 'passed', assertions: [] }] },
    deps,
  );

  assert.equal(deps.calls[0].cases[0].id, 'not-a-catalog-id');
  // The verdict about that id comes from the validator, never from this module.
  assert.deepEqual(result.issues, [{ code: 'UNKNOWN_CASE_ID', path: 'cases[0].id' }]);
});

test('preserves own holes but does not copy an inherited member', () => {
  const holes = recordingValidator(validReply());
  const cases = new Array(2);
  cases[1] = { id: 'admission-admitted', status: 'passed', assertions: [] };
  projectAdmissionEvidence({ ...sampleInput(), cases }, holes);
  const projectedHoles = holes.calls[0].cases;
  assert.equal(projectedHoles.length, 2);
  assert.equal(Object.hasOwn(projectedHoles, 0), false);
  assert.equal(projectedHoles[1].id, 'admission-admitted');

  // An inherited element is not an element of this array; copying it would invent
  // an entry the caller never wrote.
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, { 0: { id: 'inherited-case', status: 'passed', assertions: [] } });
  const inheriting = recordingValidator(validReply());
  projectAdmissionEvidence({ ...sampleInput(), cases: inherited }, inheriting);
  const projectedInherited = inheriting.calls[0].cases;
  assert.equal(projectedInherited.length, 1);
  assert.equal(Object.hasOwn(projectedInherited, 0), false);
});

test('never mutates the caller input and shares no structure with it', () => {
  const input = sampleInput();
  const snapshot = structuredClone(input);
  deepFreeze(input); // a write would throw in strict mode, and the adapter would fail

  const deps = recordingValidator(validReply());
  const result = projectAdmissionEvidence(input, deps);

  assert.deepEqual(input, snapshot);
  assert.equal(result.valid, true);
  assert.notEqual(result.document, input);
  assert.notEqual(result.document.cases, input.cases);
  assert.notEqual(result.document.cases[0].assertions, input.cases[0].assertions);
  // The document is frozen, so a consumer cannot quietly edit evidence in place.
  assert.equal(Object.isFrozen(result.document), true);
  assert.equal(Object.isFrozen(result.document.cases), true);
  assert.equal(Object.isFrozen(result.document.cases[0].assertions[0]), true);
});

test('carries foreign values through without cloning or freezing them', () => {
  // A wrongly typed `baseline` and an object smuggled into `limitations` are not
  // this module's state: it forwards them for the validator to reject, and it must
  // not freeze the caller's objects to do so.
  const foreignBaseline = [];
  const foreignLimitation = { secret: 'x' };
  const input = { baseline: foreignBaseline, limitations: [foreignLimitation], cases: 'not-an-array' };

  const deps = recordingValidator(validReply());
  const result = projectAdmissionEvidence(input, deps);
  const document = deps.calls[0];

  assert.equal(document.baseline, foreignBaseline);
  assert.equal(document.cases, 'not-an-array');
  assert.equal(document.limitations[0], foreignLimitation);
  assert.equal(Object.isFrozen(foreignBaseline), false);
  assert.equal(Object.isFrozen(foreignLimitation), false);
  assert.equal(Object.isFrozen(document.limitations), true); // the array we built is ours
  assert.equal(result.valid, true);
});

test('leaves an unusable input untouched and unfrozen', () => {
  // The same rule on the failure path: an unprojectable input is not a licence to
  // write to, or freeze, the caller's object graph.
  const input = { baseline: [], limitations: [{ secret: 'x' }], cases: 'nope' };
  const snapshot = structuredClone(input);

  projectAdmissionEvidence(input, recordingValidator(validReply()));

  assert.deepEqual(input, snapshot);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.baseline), false);
  assert.equal(Object.isFrozen(input.limitations), false);
  assert.equal(Object.isFrozen(input.limitations[0]), false);
});

test('rejects an input that is not a plain object', () => {
  for (const input of [null, undefined, 42, 'receipt', [], new Map()]) {
    const deps = recordingValidator(validReply());
    const result = projectAdmissionEvidence(input, deps);
    assert.equal(result.valid, false);
    assert.deepEqual(result.issues, [{ code: 'ADAPTER_INVALID_INPUT', path: '' }]);
    assert.equal(deps.calls.length, 0, 'the validator must not run on an unprojectable input');
  }
});

test('refuses when no usable validator was injected', () => {
  for (const deps of [undefined, null, {}, { validateAdmissionEvidence: 'nope' }, 7]) {
    const result = projectAdmissionEvidence(sampleInput(), deps);
    assert.equal(result.valid, false);
    assert.deepEqual(result.issues, [{ code: 'ADAPTER_INVALID_VALIDATOR', path: '' }]);
    assert.equal(Object.hasOwn(result, 'document'), false);
  }
});

test('discards a thrown validator value without describing it', () => {
  const result = projectAdmissionEvidence(sampleInput(), {
    validateAdmissionEvidence() {
      throw new Error('failed at /root/secret/service.js with token sk-live-1234567890');
    },
  });

  assert.deepEqual(result, {
    valid: false,
    issues: [{ code: 'ADAPTER_VALIDATOR_THREW', path: '' }],
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('sk-live'), false);
});

test('refuses a thenable validator result instead of leaking a promise', () => {
  const result = projectAdmissionEvidence(sampleInput(), {
    async validateAdmissionEvidence() {
      return validReply();
    },
  });

  assert.deepEqual(result, {
    valid: false,
    issues: [{ code: 'ADAPTER_VALIDATOR_ASYNC', path: '' }],
  });
  assert.equal(Object.hasOwn(result, 'document'), false);
});

test('a malformed validator reply cannot read as a pass', () => {
  const sparseIssues = new Array(1);
  const malformed = [
    null,
    'valid',
    42,
    {},
    { valid: true },
    { valid: true, issues: [] }, // success without a summary
    { valid: true, issues: [], summary: 'summary' },
    { valid: true, issues: [{ code: 'X', path: '' }], summary: validSummary() }, // success with issues
    { valid: 'true', issues: [], summary: validSummary() },
    { valid: false, issues: [] }, // failure with no issue
    { valid: false, issues: [], summary: validSummary() }, // summary on a failure
    { valid: false, issues: [{ code: 'X' }] },
    { valid: false, issues: [{ code: 'X', path: '', extra: 1 }] },
    { valid: false, issues: [{ code: '', path: '' }] },
    { valid: false, issues: [{}] },
    { valid: false, issues: sparseIssues }, // sparse issues
    { valid: true, issues: [], summary: validSummary(), runner: 'x' }, // extra result member
    { valid: false, issues: [{ code: 'X', path: '' }], extra: 1 },
  ];

  for (const reply of malformed) {
    const result = projectAdmissionEvidence(sampleInput(), recordingValidator(reply));
    assert.equal(result.valid, false, `accepted malformed reply: ${JSON.stringify(reply)}`);
    assert.deepEqual(result.issues, [{ code: 'ADAPTER_VALIDATOR_CONTRACT', path: '' }]);
    assert.equal(Object.hasOwn(result, 'document'), false);
    assert.equal(Object.hasOwn(result, 'summary'), false);
  }
});

test('an explicit undefined summary on a failure is a contract violation', () => {
  // "Absent" is not "present and undefined": the contract fixes the key set, and a
  // key holding `undefined` is still a key.
  const result = projectAdmissionEvidence(sampleInput(), {
    validateAdmissionEvidence() {
      return { valid: false, issues: [{ code: 'WRONG_TYPE', path: 'cases' }], summary: undefined };
    },
  });

  assert.deepEqual(result, {
    valid: false,
    issues: [{ code: 'ADAPTER_VALIDATOR_CONTRACT', path: '' }],
  });
});

test('a malformed summary cannot read as a pass', () => {
  const good = validSummary();
  const sparseRequired = new Array(1);
  const badSummaries = [
    {},
    { ...good, certification: true },
    { ...good, certification: 'false' },
    { ...good, schemaVersion: 'admission-evidence/0.1' },
    { ...good, coverage: { required: [], present: [] } },
    { ...good, coverage: { required: 'x', present: [], unknown: [] } },
    { ...good, coverage: { required: [], present: [], unknown: [7] } },
    { ...good, coverage: { required: sparseRequired, present: [], unknown: [] } },
    { ...good, cases: 'x' },
    {
      ...good,
      cases: [{ ...good.cases[0], note: 'extra' }],
    },
    {
      ...good,
      cases: [{ ...good.cases[0], assertionCount: -1 }],
    },
    {
      ...good,
      cases: [{ ...good.cases[0], assertionCount: '1' }],
    },
    {
      ...good,
      cases: [{ ...good.cases[0], failedAssertions: [1] }],
    },
    {
      ...good,
      cases: [{ ...good.cases[0], failedAssertions: sparseRequired }],
    },
    {
      ...good,
      cases: [{ ...good.cases[0], limitations: 'x' }],
    },
    { ...good, limitations: 'x' },
    { ...good, runner: 'x' },
  ];

  for (const summary of badSummaries) {
    const result = projectAdmissionEvidence(
      sampleInput(),
      recordingValidator({ valid: true, issues: [], summary }),
    );
    assert.equal(result.valid, false, `accepted malformed summary: ${JSON.stringify(summary)}`);
    assert.deepEqual(result.issues, [{ code: 'ADAPTER_VALIDATOR_CONTRACT', path: '' }]);
    assert.equal(Object.hasOwn(result, 'document'), false);
    assert.equal(Object.hasOwn(result, 'summary'), false);
  }
});

test('an off-contract reply is reported, not partially trusted', () => {
  const reply = {
    valid: false,
    issues: [{ code: 'MISSING_REQUIRED_CASE', path: 'cases' }],
  };
  const deps = recordingValidator(reply);
  const result = projectAdmissionEvidence(sampleInput(), deps);

  assert.deepEqual(result, {
    valid: false,
    issues: [{ code: 'MISSING_REQUIRED_CASE', path: 'cases' }],
  });
  // Copied, so the adapter's output does not alias the validator's array.
  assert.notEqual(result.issues, reply.issues);
  assert.notEqual(result.issues[0], reply.issues[0]);
});

test('passes the validator summary through untouched', () => {
  const reply = validReply();
  const result = projectAdmissionEvidence(sampleInput(), recordingValidator(reply));

  assert.equal(result.summary, reply.summary);
  // `failedAssertions` is a list of ids the validator produced. The adapter adds no
  // count, no ratio and no verdict of its own.
  assert.deepEqual(result.summary.cases[0].failedAssertions, []);
  assert.deepEqual(Object.keys(result.summary).sort(), [
    'cases',
    'certification',
    'coverage',
    'limitations',
    'schemaVersion',
  ]);
});

test('calls the validator exactly once per invocation', () => {
  const approving = recordingValidator(validReply());
  const rejecting = recordingValidator({
    valid: false,
    issues: [{ code: 'MISSING_FIELD', path: 'cases' }],
  });

  projectAdmissionEvidence(sampleInput(), approving);
  projectAdmissionEvidence(sampleInput(), rejecting);

  assert.equal(approving.calls.length, 1);
  assert.equal(rejecting.calls.length, 1);
});

test('each summary case line must agree with itself', () => {
  const base = () => ({
    id: 'admission-admitted',
    status: 'passed',
    assertionCount: 1,
    failedAssertions: [],
    limitations: [],
  });
  const withLine = (line) => ({ ...validSummary(), cases: [line] });

  const consistent = [
    base(),
    { ...base(), status: 'refused' },
    // The ids are opaque here: `activation-ran-twice` is a caller/admin-chosen
    // string, never looked up in a catalog this package does not hold.
    { ...base(), status: 'failed', failedAssertions: ['activation-ran-twice'] },
    { ...base(), status: 'not-run', assertionCount: 0, limitations: ['not attempted'] },
  ];

  for (const line of consistent) {
    const result = projectAdmissionEvidence(
      sampleInput(),
      recordingValidator({ valid: true, issues: [], summary: withLine(line) }),
    );
    assert.equal(result.valid, true, `refused a consistent line: ${JSON.stringify(line)}`);
  }

  const contradictory = [
    { ...base(), status: 'failed' }, // reported failed, named nothing
    { ...base(), status: 'failed', assertionCount: 0, failedAssertions: ['a'] }, // ran nothing
    { ...base(), assertionCount: 0 }, // passed on zero assertions
    { ...base(), failedAssertions: ['a'] }, // passed while naming a failure
    { ...base(), status: 'refused', failedAssertions: ['a'] },
    { ...base(), status: 'not-run', assertionCount: 1, limitations: ['x'] }, // ran one
    { ...base(), status: 'not-run', assertionCount: 0, limitations: [] }, // no reason given
    {
      ...base(),
      status: 'not-run',
      assertionCount: 0,
      failedAssertions: ['a'],
      limitations: ['x'],
    },
    // The same id twice does not say which assertion failed twice.
    { ...base(), status: 'failed', assertionCount: 2, failedAssertions: ['a', 'a'] },
    // Two failures among one assertion is arithmetically impossible.
    { ...base(), status: 'failed', assertionCount: 1, failedAssertions: ['a', 'b'] },
    { ...base(), limitations: [''] }, // an empty string is not a limitation
    // Nor does an empty string explain an unrun case.
    { ...base(), status: 'not-run', assertionCount: 0, limitations: [''] },
    { ...base(), status: 'skipped' }, // not a status of §5
    { ...base(), status: 'PASSED' }, // nor a case variant of one
  ];

  for (const line of contradictory) {
    const result = projectAdmissionEvidence(
      sampleInput(),
      recordingValidator({ valid: true, issues: [], summary: withLine(line) }),
    );
    assert.equal(result.valid, false, `accepted a contradictory line: ${JSON.stringify(line)}`);
    assert.deepEqual(result.issues, [{ code: 'ADAPTER_VALIDATOR_CONTRACT', path: '' }]);
    assert.equal(Object.hasOwn(result, 'document'), false);
    assert.equal(Object.hasOwn(result, 'summary'), false);
  }
});

test('summary coverage must agree with the case lines it describes', () => {
  const line = (id, status = 'passed', extra = {}) => ({
    id,
    status,
    assertionCount: 1,
    failedAssertions: [],
    limitations: [],
    ...extra,
  });
  const summary = (coverage, cases) => ({ ...validSummary(), coverage, cases });

  const consistent = [
    // Two cases, both required ids reported, one of them failed.
    summary({ required: ['case-a', 'case-b'], present: ['case-a', 'case-b'], unknown: [] }, [
      line('case-a'),
      line('case-b', 'failed', { assertionCount: 2, failedAssertions: ['assertion-x'] }),
    ]),
    // A case present but not required, and an id the run says nothing about.
    summary({ required: ['case-a'], present: ['case-a', 'case-optional'], unknown: ['case-other'] }, [
      line('case-a'),
      line('case-optional', 'not-run', { assertionCount: 0, limitations: ['not attempted'] }),
    ]),
  ];

  for (const candidate of consistent) {
    const result = projectAdmissionEvidence(
      sampleInput(),
      recordingValidator({ valid: true, issues: [], summary: candidate }),
    );
    assert.equal(result.valid, true, `refused a consistent coverage: ${JSON.stringify(candidate.coverage)}`);
  }

  const contradictory = [
    // `present` names a case that is not reported.
    summary({ required: [], present: ['case-a'], unknown: [] }, [line('case-b')]),
    // A reported case is not claimed present.
    summary({ required: [], present: ['case-a'], unknown: [] }, [line('case-a'), line('case-b')]),
    // A required id that does not appear among the reported cases.
    summary({ required: ['case-b'], present: ['case-a'], unknown: [] }, [line('case-a')]),
    // The same id claimed both present and unknown.
    summary({ required: [], present: ['case-a'], unknown: ['case-a'] }, [line('case-a')]),
    // A repeated id in a coverage list.
    summary({ required: [], present: ['case-a', 'case-a'], unknown: [] }, [line('case-a')]),
    summary({ required: ['case-a', 'case-a'], present: ['case-a'], unknown: [] }, [line('case-a')]),
    // The same case line twice: one case named as two.
    summary({ required: [], present: ['case-a'], unknown: [] }, [line('case-a'), line('case-a')]),
    // Nothing reported, while a required case is claimed present nowhere.
    summary({ required: ['case-a'], present: [], unknown: [] }, []),
  ];

  for (const candidate of contradictory) {
    const result = projectAdmissionEvidence(
      sampleInput(),
      recordingValidator({ valid: true, issues: [], summary: candidate }),
    );
    assert.equal(
      result.valid,
      false,
      `accepted a contradictory coverage: ${JSON.stringify(candidate.coverage)}`,
    );
    assert.deepEqual(result.issues, [{ code: 'ADAPTER_VALIDATOR_CONTRACT', path: '' }]);
    assert.equal(Object.hasOwn(result, 'document'), false);
    assert.equal(Object.hasOwn(result, 'summary'), false);
  }
});

test('a member no one can enumerate does not make a reply closed-shaped', () => {
  // The result's key set is closed over *members*, not over enumerable members, so a
  // hidden one is refused exactly like a visible one: an unread value must not be
  // able to ride home inside a success.
  const addHidden = (base) => {
    const value = { ...base };
    Object.defineProperty(value, 'note', { value: 'hidden', enumerable: false });
    return value;
  };
  const addSymbol = (base) => {
    const value = { ...base };
    value[Symbol('extra')] = 'hidden';
    return value;
  };

  const replies = [
    addHidden(validReply()),
    addSymbol(validReply()),
    { valid: true, issues: [], summary: addHidden(validSummary()) },
    { valid: true, issues: [], summary: addSymbol(validSummary()) },
    addHidden({ valid: false, issues: [{ code: 'MISSING_FIELD', path: 'cases' }] }),
    addSymbol({ valid: false, issues: [{ code: 'MISSING_FIELD', path: 'cases' }] }),
  ];

  for (const reply of replies) {
    const result = projectAdmissionEvidence(sampleInput(), recordingValidator(reply));
    assert.equal(result.valid, false, `accepted a hidden member: ${String(reply?.summary?.id)}`);
    assert.deepEqual(result.issues, [{ code: 'ADAPTER_VALIDATOR_CONTRACT', path: '' }]);
    assert.equal(Object.hasOwn(result, 'document'), false);
    assert.equal(Object.hasOwn(result, 'summary'), false);
  }

  // The control: the very same replies without the hidden member are accepted, so
  // the refusals above are caused by the hidden member and nothing else.
  const control = projectAdmissionEvidence(sampleInput(), recordingValidator(validReply()));
  assert.equal(control.valid, true);
});

test('exposes only the adapter function and its closed code list', async () => {
  const source = await readFile(SOURCE_PATH, 'utf8');

  assert.deepEqual(ADAPTER_CODES, [
    'ADAPTER_INVALID_INPUT',
    'ADAPTER_INVALID_VALIDATOR',
    'ADAPTER_VALIDATOR_THREW',
    'ADAPTER_VALIDATOR_ASYNC',
    'ADAPTER_VALIDATOR_CONTRACT',
  ]);
  // Purity by inspection: no import of anything, so the canonical validator can
  // only ever arrive injected, and no sibling or spec-repository dependency exists.
  assert.equal(/^import\s/m.test(source), false, 'the adapter must import nothing');
  assert.equal(source.includes('require('), false);
  // A prose citation of the spec is fine; an import of it would not be.
  assert.equal(/from\s+['"][^'"]*dsh-compat-spec/.test(source), false);
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(/\bDate\b/.test(source), false);
  assert.equal(/\bMath\.random\b/.test(source), false);
});
