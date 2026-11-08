/**
 * The ownership *query*: what the driver asks, and who it asks about.
 *
 * Scope of this file — the three facts a name-only ownership check could not
 * express, and the defect each one was:
 *
 * 1. **The question must be answerable.** `invokeTool()` used to send
 *    `{ tool, entry }`, and the helper predicate sent `{ tool, entry: null }`
 *    (`src/internal/driver-core.js` before this change). A port wired to a real
 *    fixture has to bind a registration to *something* the configuration names:
 *    the tool's module, the entry's positional module, and the caller. With only
 *    a name (and, on the second check, a discarded entry) no fixture could ever
 *    produce a `true` answer, so "refuse by default" was indistinguishable from
 *    "impossible to allow".
 * 2. **Both checks must ask the same question.** The pre-slot check and the
 *    helper's in-slot predicate now share one `OwnershipClaim`; a wrong entry or
 *    a wrong module must deny at BOTH, and a revocation between them must deny
 *    at the second.
 * 3. **The agent is validated before the question is asked.** A query with no
 *    owning agent is not answerable, so `POLICY_NO_TURN` must come first and the
 *    port must never be consulted.
 *
 * What this file does NOT claim: there is no real host port behind
 * `resolveToolOwnership` (`src/index.js` still injects `ownershipUnavailable()`),
 * so nothing here shows that a live registry can answer the question, and none
 * of it closes the gap between the second check and the executor resolving the
 * name at dispatch time. `HOST PROOF GAPS` at the end says so explicitly.
 *
 * Rules (matching `tests/core-agent-isolation.test.js`):
 * - No host package is imported; only `src/internal/*` and `src/policy.js`.
 * - Every collaborator is a fake and every query is recorded, so the tests
 *   assert on the exact question asked rather than on a conclusion.
 * - No command, build, or test runner is invoked at import time.
 *
 * @module dsh-agent-test-driver/tests/core-ownership-context
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DRIVER_CODES,
  checkOwnership,
  createDriverCore,
  ownershipClaim,
  recheckOwnership,
} from '../src/internal/driver-core.js';
import { createSingleToolInvoker } from '../src/internal/invoke-tool.js';
import { POLICY_CODES, normalizeConfig } from '../src/policy.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The module the one configured test tool declares. */
const TOOL_MODULE = 'sample-probe';
/** The entry id of the one configured target. */
const ENTRY = 'practice:alpha';

/**
 * Raw admin configuration: one target whose single entry declares
 * {@link TOOL_MODULE}, and one tool configured with the same module.
 *
 * Returned raw, not normalized: `arm()` runs it through
 * `policy.normalizeConfig()` and re-attaches `pluginTargets[].modules`, which
 * the policy deliberately does not carry.
 *
 * @param {{ modules?: unknown, testModule?: string, withModules?: boolean }} [options]
 * @returns {object} Raw admin config.
 */
function makeConfig({ modules, testModule = TOOL_MODULE, withModules = true } = {}) {
  const target = { directory: 'practice', entries: [ENTRY] };
  if (modules !== undefined) target.modules = modules;
  else if (withModules) target.modules = [TOOL_MODULE];
  return {
    pluginTargets: [target],
    testTools: [{ name: 'echo_probe', module: testModule, expect: 'echo_probe' }],
    maxStatusBytes: 1024,
    invocationTimeoutMs: 250,
  };
}

/** An armed provenance probe result. */
function armedProbe() {
  return Object.freeze({
    armed: true,
    isTestHost: true,
    testRoot: '/tmp/test-root',
    profileName: 'isolated',
    issues: [],
  });
}

/**
 * A fake loader exposing the three methods the driver uses.
 *
 * @returns {object} Fake loader.
 */
function makeLoader() {
  return {
    resolve(id) {
      if (id !== ENTRY) throw new Error('unknown entry');
      return { options: { id, name: TOOL_MODULE, disabled: false }, fiber: { state: 2 } };
    },
    update() {},
    async await() {},
  };
}

/**
 * An ownership port that behaves like a real registration fixture: it answers
 * `{ok:true, owner}` only for the exact registration the configuration names,
 * and `{ok:false}` for every other question. It records every query.
 *
 * `bindings` is what the "host" is taken to hold: `tool` ->
 * `{ module, entry, agents: Set }`. A question whose `entry`/`module`/`agent`
 * does not match any binding is unattested — which is what makes a discarded
 * entry (the old `entry: null`) observable as a denial instead of being
 * undefined behaviour.
 *
 * @param {{ revokeAfter?: number, ownerFor?: (query: object, index: number) => string, bindings?: Map<string, object> }} [options]
 * @returns {{ port: Function, queries: object[] }} The port and its recorder.
 */
function makeFixturePort({ revokeAfter, ownerFor, bindings } = {}) {
  const queries = [];
  const table = bindings ?? new Map([[ENTRY, {
    tool: 'echo_probe',
    module: TOOL_MODULE,
    agents: new Set(),
  }]]);
  /**
   * @param {{ tool: string, entry: string | null, module: string | null, agent: unknown }} query
   * @returns {{ ok: boolean, owner?: string }}
   */
  const port = (query) => {
    const index = queries.push(query) - 1;
    if (revokeAfter !== undefined && index >= revokeAfter) return { ok: false };
    if (query === null || typeof query !== 'object') return { ok: false };
    if (typeof query.tool !== 'string' || query.tool === '') return { ok: false };
    // A fixture binds a *registration*, so the module is part of the question.
    if (typeof query.module !== 'string' || query.module === '') return { ok: false };
    if (typeof query.entry !== 'string' || query.entry === '') return { ok: false };
    const bound = table.get(query.entry);
    if (bound === undefined) return { ok: false };
    if (bound.tool !== query.tool || bound.module !== query.module) return { ok: false };
    if (query.agent === null || typeof query.agent !== 'object') return { ok: false };
    bound.agents.add(query.agent);
    const owner = ownerFor === undefined ? 'practice' : ownerFor(query, index);
    return owner === '' ? { ok: false } : { ok: true, owner };
  };
  return { port, queries };
}

/**
 * Build a core with fakes.
 *
 * @param {{ config?: object, ports?: object, loader?: object }} [options]
 * @returns {{ core: object, calls: object, loader: object }}
 */
function makeCore({ config, ports: portOverrides, loader: loaderOverride } = {}) {
  const resolvedConfig = config ?? makeConfig();
  const loader = loaderOverride ?? makeLoader();
  const calls = {
    created: [],
    invocations: [],
    closed: 0,
  };
  const core = createDriverCore({
    provenance: { probe: async () => armedProbe() },
    config: normalizeConfig,
    loader: () => loader,
    setEntryEnabled: async () => ({ ok: false, code: 'DRIVER_UPDATE_FAILED' }),
    createInvoker: (options) => {
      // Mirrors the real helper's construction contract
      // (`src/internal/invoke-tool.js:151`): `agent` is read ONCE, here, and the
      // ownership predicate is consulted inside `invoke()` — that is the second,
      // helper-time check. The fake runs it for real so a suite that counts
      // queries can see both checks without the native executor.
      const bound = { agent: options.agent, isOwnedByAllowedSource: options.isOwnedByAllowedSource };
      calls.created.push(bound);
      return {
        async invoke(name, args) {
          // Same strictness as the real helper:
          // `invoke-tool.js:105` requires the predicate to answer `true`.
          if (options.isOwnedByAllowedSource(name) !== true) {
            return { ok: false, code: 'INVOKE_DENIED', status: 'ownership denied' };
          }
          calls.invocations.push({ name, args });
          return { ok: true, code: 'INVOKE_OK', status: 'executed' };
        },
        close() {
          calls.closed += 1;
        },
      };
    },
    adminConfig: resolvedConfig,
    resolveToolOwnership: () => ({ ok: false }),
    ...portOverrides,
  });
  return { core, calls, loader };
}

/** A fake native execution context shaped like the host's `ToolRunContext`. */
function makeExec(agent = { id: 'session-1' }) {
  return { agent, signal: new AbortController().signal };
}

// ---------------------------------------------------------------------------
// 1. The query itself
// ---------------------------------------------------------------------------

test('the ownership query names the tool, the claimed entry, its module and the caller', async () => {
  const { port, queries } = makeFixturePort();
  const { core } = makeCore({ ports: { resolveToolOwnership: port } });
  const exec = makeExec();

  const result = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, exec);

  assert.equal(result.ok, true, 'a fixture that can answer the question must be able to grant');
  assert.equal(queries.length, 2, 'the port was consulted for both checks');
  for (const query of queries) {
    assert.deepEqual(
      Object.keys(query).sort(),
      ['agent', 'entry', 'module', 'tool'],
      'the query carries exactly the four bound fields — nothing invented, no toolSet',
    );
    assert.equal(query.tool, 'echo_probe');
    assert.equal(query.entry, ENTRY, 'the claimed entry is not discarded');
    assert.equal(query.module, TOOL_MODULE, 'the module is the configured tool module');
    assert.equal(query.agent, exec.agent, 'the query names this call\'s exact caller agent');
  }
});

test('the module is the configured tool module, not a value read from the claimed entry', async () => {
  // The tool is configured with `probe-impl/echo`; the target's positional
  // module for the entry must equal it, and the query must echo the tool's own
  // configured module either way.
  const config = makeConfig({ modules: ['probe-impl/echo'], testModule: 'probe-impl/echo' });
  const { port, queries } = makeFixturePort({
    bindings: new Map([[ENTRY, { tool: 'echo_probe', module: 'probe-impl/echo', agents: new Set() }]]),
  });
  const { core } = makeCore({ config, ports: { resolveToolOwnership: port } });

  const result = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, makeExec());

  assert.equal(result.ok, true);
  assert.deepEqual(queries.map((query) => query.module), ['probe-impl/echo', 'probe-impl/echo'],
    'both checks ask about the tool\'s configured module');
});

test('a wrong claimed entry denies before the port is asked', async () => {
  const { port, queries } = makeFixturePort();
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: port } });

  const result = await core.invokeTool({ tool: 'echo_probe', entry: 'other:beta' }, makeExec());

  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED);
  assert.deepEqual(queries, [], 'an unconfigured entry is never put to the ownership port');
  assert.equal(calls.created.length, 0);
});

test('a claimed entry whose configured module differs from the tool denies', async () => {
  // The entry positionally maps to `other-module` while the tool is configured
  // as `sample-probe`: the claim cannot describe the tool's registration.
  const config = makeConfig({ modules: ['other-module'] });
  const { port, queries } = makeFixturePort();
  const { core, calls } = makeCore({ config, ports: { resolveToolOwnership: port } });

  const result = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, makeExec());

  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED);
  assert.deepEqual(queries, [], 'a mismatched claim is refused, not asked about');
  assert.equal(calls.created.length, 0, 'no invoker is built for an unanswerable claim');
});

test('a claimed entry with no readable positional module is refused as unmappable', async () => {
  // Four ways the mapping can be unreadable; each must refuse rather than fall
  // back to the tool module alone, because "which entry owns this tool?" would
  // otherwise be answered by the caller's own claim.
  const cases = [
    { label: 'no modules declared', config: makeConfig({ withModules: false }) },
    { label: 'wrong length', config: makeConfig({ modules: [TOOL_MODULE, 'extra'] }) },
    { label: 'non-string element', config: makeConfig({ modules: [7] }) },
    { label: 'empty string element', config: makeConfig({ modules: [''] }) },
  ];
  for (const { label, config } of cases) {
    const { port, queries } = makeFixturePort();
    const { core } = makeCore({ config, ports: { resolveToolOwnership: port } });
    const result = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, makeExec());
    assert.equal(result.ok, false, label);
    assert.equal(result.code, DRIVER_CODES.TOOL_OWNERSHIP_UNMAPPABLE, label);
    assert.deepEqual(queries, [], `${label}: the port is not asked an ambiguous question`);
  }
});

test('an unclaimed entry still asks with the tool module, but with a null entry', async () => {
  // No entry claimed: the caller has not asserted an owner. The question is
  // still asked (a port may attest a registration without one), and the entry is
  // null rather than fabricated.
  const { port, queries } = makeFixturePort();
  const { core } = makeCore({ ports: { resolveToolOwnership: port } });

  const result = await core.invokeTool({ tool: 'echo_probe' }, makeExec());

  assert.equal(result.ok, false, 'a fixture that binds by entry cannot attest an entryless claim');
  assert.equal(result.code, DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED);
  assert.equal(queries.length, 1, 'it is asked exactly once — the call stops before the slot');
  assert.equal(queries[0].entry, null);
  assert.equal(queries[0].module, TOOL_MODULE);
});

test('the default refusal is unchanged: no evidence, no invocation', async () => {
  const { core, calls } = makeCore();
  const result = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.invocations.length, 0);
});

test('a throwing or malformed port still denies', () => {
  const claim = { tool: 'echo_probe', entry: ENTRY, module: TOOL_MODULE, agent: { id: 's' } };
  assert.deepEqual(checkOwnership(() => { throw new Error('host blew up'); }, claim), { ok: false });
  assert.deepEqual(checkOwnership(() => ({ ok: true }), claim), { ok: false });
  assert.deepEqual(checkOwnership(() => ({ ok: true, owner: '' }), claim), { ok: false });
  assert.deepEqual(checkOwnership(() => true, claim), { ok: false });
  assert.deepEqual(recheckOwnership(() => ({ ok: true, owner: 'practice' }), claim, 'other'), { ok: false });
  assert.deepEqual(
    recheckOwnership(() => ({ ok: true, owner: 'practice' }), claim, 'practice'),
    { ok: true, owner: 'practice' },
  );
});

test('the claim refuses without an agent, and the port is never consulted', async () => {
  const { port, queries } = makeFixturePort();
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: port } });

  const noAgent = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, { signal: new AbortController().signal });
  assert.equal(noAgent.ok, false);
  assert.equal(noAgent.code, POLICY_CODES.NO_TURN, 'agent validation precedes the ownership query');

  const stringAgent = await core.invokeTool(
    { tool: 'echo_probe', entry: ENTRY },
    { agent: 'session-1', signal: new AbortController().signal },
  );
  assert.equal(stringAgent.ok, false);
  assert.equal(stringAgent.code, POLICY_CODES.NO_TURN, 'a string is not an agent handle');

  assert.deepEqual(queries, [], 'no ownership question is asked about a call with no owning agent');
  assert.equal(calls.created.length, 0);
});

test('ownershipClaim reports the fixed code for each refusal shape', () => {
  const current = { config: { pluginTargets: [{ directory: 'practice', entries: [ENTRY], modules: [TOOL_MODULE] }] } };
  const tool = { name: 'echo_probe', module: TOOL_MODULE };
  const agent = { id: 'session-1' };

  assert.deepEqual(ownershipClaim(current, tool, ENTRY, agent), {
    ok: true,
    claim: { tool: 'echo_probe', entry: ENTRY, module: TOOL_MODULE, agent },
  });
  assert.deepEqual(ownershipClaim(current, tool, 'other:beta', agent), {
    ok: false,
    code: DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED,
  });
  assert.deepEqual(ownershipClaim(current, tool, ENTRY, 'session-1'), {
    ok: false,
    code: POLICY_CODES.NO_TURN,
  });
  const ambiguous = { config: { pluginTargets: [{ directory: 'practice', entries: [ENTRY] }] } };
  assert.deepEqual(ownershipClaim(ambiguous, tool, ENTRY, agent), {
    ok: false,
    code: DRIVER_CODES.TOOL_OWNERSHIP_UNMAPPABLE,
  });
});

// ---------------------------------------------------------------------------
// 2. Both checks: the initial one and the helper-time one
// ---------------------------------------------------------------------------

test('both checks receive the identical query and the correct identity', async () => {
  const { port, queries } = makeFixturePort();
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: port } });
  const exec = makeExec();

  const result = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY, args: { n: 1 } }, exec);

  assert.equal(result.ok, true);
  assert.equal(queries.length, 2, 'exactly two checks: initial and helper-time');
  assert.deepEqual(queries[0], queries[1], 'the helper-time question is the same question');
  assert.equal(queries[1].entry, ENTRY, 'the helper-time check does not discard the entry');
  assert.equal(queries[1].agent, exec.agent, 'the helper-time check names the same caller');
  // The helper was constructed with that call's own agent, and its predicate is
  // the one the in-slot check runs.
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].agent, exec.agent);
});

test('two different callers each ask with their own agent', async () => {
  const { port, queries } = makeFixturePort();
  const { core } = makeCore({ ports: { resolveToolOwnership: port } });
  const first = makeExec({ id: 'session-1' });
  const second = makeExec({ id: 'session-2' });

  await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, first);
  await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, second);

  assert.equal(queries.length, 4, 'two checks per call');
  assert.equal(queries[0].agent, first.agent);
  assert.equal(queries[1].agent, first.agent, 'the first call\'s in-slot check stays with its own caller');
  assert.equal(queries[2].agent, second.agent);
  assert.equal(queries[3].agent, second.agent);
});

test('a revocation between the two checks blocks the call inside the shared slot', async () => {
  // The fixture grants exactly once: the initial check is answered, the
  // helper-time check is not. The second check, not the first, must stop it.
  const { port, queries } = makeFixturePort({ revokeAfter: 1 });
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: port } });

  const result = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, makeExec());

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVOKE_DENIED', 'the helper\'s denial code reaches the caller');
  assert.equal(queries.length, 2, 'the second check really ran');
  assert.equal(calls.created.length, 1, 'the invoker was built, so the denial is the predicate\'s');
  assert.equal(calls.invocations.length, 0, 'nothing reached the native executor');
});

test('a different owner named at the second check blocks the call', async () => {
  // Both checks are answered `{ok:true}`, but the second answer names a
  // different owner. A grant that does not name the owner the claim was bound to
  // is a grant of something else, so the in-slot check must deny.
  const { port, queries } = makeFixturePort({
    ownerFor: (_query, index) => (index === 0 ? 'practice' : 'someone-else'),
  });
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: port } });

  const result = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, makeExec());

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVOKE_DENIED', 'the recheck refuses a differently-named owner');
  assert.equal(queries.length, 2, 'both checks were answered `ok:true`');
  assert.equal(calls.invocations.length, 0, 'nothing reached the native executor');
});

// ---------------------------------------------------------------------------
// 3. The checks run against the REAL helper
// ---------------------------------------------------------------------------

/**
 * A native tools service fake that echoes the generated call id so the helper
 * can find its own result, and records the batch input.
 *
 * @returns {{ calls: object[], execute: Function }}
 */
function makeTools() {
  const calls = [];
  return {
    calls,
    async execute(input) {
      calls.push(input);
      const block = input.calls[0];
      return {
        results: [{ callId: block.id, result: { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] } }],
      };
    },
  };
}

/**
 * Build a core whose invoker port is the REAL `createSingleToolInvoker()`, so
 * the helper-time check under test is the helper's own predicate call.
 *
 * @param {{ config?: object, tools: object, port: Function }} options
 * @returns {{ core: object }}
 */
function makeRealCore({ config, tools, port }) {
  const core = createDriverCore({
    provenance: { probe: async () => armedProbe() },
    config: normalizeConfig,
    loader: () => makeLoader(),
    setEntryEnabled: async () => ({ ok: false, code: 'DRIVER_UPDATE_FAILED' }),
    createInvoker: (options) => createSingleToolInvoker({ ...options, tools }),
    adminConfig: config ?? makeConfig(),
    resolveToolOwnership: port,
  });
  return { core };
}

test('integration: the real helper re-asks the bound query and dispatches the exact caller', async () => {
  const { port, queries } = makeFixturePort();
  const tools = makeTools();
  const { core } = makeRealCore({ tools, port });
  const exec = makeExec();

  const result = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, exec);

  assert.equal(result.ok, true, 'a granting fixture reaches the executor');
  assert.equal(result.code, 'INVOKE_OK');
  assert.equal(tools.calls.length, 1);
  assert.equal(tools.calls[0].agent, exec.agent, 'the exact caller agent reaches tools.execute');
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0], queries[1], 'initial check and helper predicate asked the same question');
  assert.equal(queries[1].entry, ENTRY);
  assert.equal(queries[1].module, TOOL_MODULE);
});

test('integration: the real helper\'s second check blocks a revoked claim', async () => {
  const { port, queries } = makeFixturePort({ revokeAfter: 1 });
  const tools = makeTools();
  const { core } = makeRealCore({ tools, port });

  const result = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, makeExec());

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVOKE_DENIED', 'the helper refuses at its own predicate');
  assert.equal(queries.length, 2);
  assert.equal(tools.calls.length, 0, 'nothing reached the native executor');
});

test('integration: the predicate refuses a name other than the claim\'s tool', async () => {
  // The in-slot predicate is guard-checked on the exact name the claim was built
  // for, so a helper cannot be steered into attesting a different name. The real
  // helper only ever passes its own `name`, so this drives the predicate
  // directly, through the options the core hands the helper.
  const { port, queries } = makeFixturePort();
  let handed;
  const core = createDriverCore({
    provenance: { probe: async () => armedProbe() },
    config: normalizeConfig,
    loader: () => makeLoader(),
    setEntryEnabled: async () => ({ ok: false, code: 'DRIVER_UPDATE_FAILED' }),
    createInvoker: (options) => {
      handed = options;
      return createSingleToolInvoker({ ...options, tools: makeTools() });
    },
    adminConfig: makeConfig(),
    resolveToolOwnership: port,
  });

  const result = await core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, makeExec());

  assert.equal(result.ok, true);
  assert.equal(typeof handed.isOwnedByAllowedSource, 'function');
  assert.equal(handed.isOwnedByAllowedSource('echo_probe'), true, 'the claimed name is attested');
  const before = queries.length;
  assert.equal(handed.isOwnedByAllowedSource('other_probe'), false, 'any other name is refused');
  assert.equal(queries.length, before, 'and the port is not even asked about it');
});

test('integration: a per-call invoker still carries cancellation', async () => {
  // The claim binding must not reintroduce a shared invoker: each call gets its
  // own helper with its own combined signal, and the caller's abort reaches it.
  const { port } = makeFixturePort();
  const holding = makeTools();
  let release;
  const held = new Promise((resolveInner) => {
    release = resolveInner;
  });
  const gated = {
    calls: holding.calls,
    async execute(input) {
      holding.calls.push(input);
      await held;
      const block = input.calls[0];
      return { results: [{ callId: block.id, result: { isError: false, value: 'ok', content: [] } }] };
    },
  };
  const { core } = makeRealCore({ tools: gated, port });
  const agent = { id: 'session-1' };
  const caller = new AbortController();

  const pending = core.invokeTool({ tool: 'echo_probe', entry: ENTRY }, { agent, signal: caller.signal });
  // Let the core reach the slot and the helper reach `tools.execute()`.
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
  assert.equal(gated.calls.length, 1, 'the call reached the executor');

  caller.abort(new Error('caller gave up'));
  assert.equal(gated.calls[0].signal.aborted, true, 'the caller abort reaches this call\'s batch signal');
  release();

  const result = await pending;
  assert.equal(result.ok, false, 'an aborted call does not report success');
  // The exclusive slot, not the helper, reports this: `exclusive()` maps its own
  // busy/timeout/cancel to `DRIVER_BUSY` and only preserves a code the helper
  // itself returned (`driver-core.js:872-899`). The helper's `INVOKE_CANCELLED`
  // is asserted in `invoke-tool`'s own suite, where no slot wraps it.
  assert.equal(result.code, DRIVER_CODES.BUSY, 'the slot reports the caller cancellation');
});

/**
 * HOST PROOF GAPS — what this suite cannot establish:
 *
 * 1. That a real host surface can answer `{tool, entry, module, agent}`. No such
 *    port exists yet: `src/index.js` still injects `ownershipUnavailable()`, and
 *    `ToolExecutionInput` (`dsh-tools/lib/types/index.d.ts:216`) carries only
 *    `agent` and `signal`, so nothing in the executor names an entry or module.
 *    The fixture port here is a stand-in, not evidence.
 * 2. That the configuration the query names is the one the host loaded. The
 *    positional mapping is validated from admin configuration only
 *    (`positionalModule()`), not from the live loader.
 * 3. That no registration changes between the helper-time check and the
 *    executor resolving the name at dispatch. This is deliberately NOT claimed:
 *    the two checks narrow the window, they do not close it.
 * 4. That `testTools[].module` is the specifier a real provenance source would
 *    match a registration against; that mapping is the missing host surface
 *    itself.
 */
