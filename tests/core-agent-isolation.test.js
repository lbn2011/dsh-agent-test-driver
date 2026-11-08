/**
 * Per-agent isolation, positional module mapping, and refusal preservation in
 * the driver core.
 *
 * Scope of this file: the three behaviours that a single-agent, single-target
 * fixture cannot distinguish, each of which was a real defect:
 *
 * 1. **Native dispatch is per call, not per agent or per plugin.**
 *    `createSingleToolInvoker()` destructures `agent` and `signal` ONCE at
 *    construction (`src/internal/invoke-tool.js:151`) and forwards that same
 *    `agent` into `tools.execute({ ..., agent })` on every call
 *    (`src/internal/invoke-tool.js:199`). Any reuse of an invoker is therefore
 *    wrong in one of two ways: a shared/per-agent cache dispatches a second
 *    caller's call under the first caller's identity, and a cached signal (or a
 *    never-aborting placeholder) silently drops cancellation for every call
 *    after the one it was built for. These tests prove the core now builds one
 *    invoker per call, with that call's exact agent and a fresh signal, and
 *    closes it after real settlement.
 * 2. **The positional `modules` mapping is validated at the arm.** The policy
 *    owns `directory` and `entries` and does not carry `modules`
 *    (`src/policy.js:114`, `normalizeTarget` returns `{ directory, entries }`);
 *    the entry adds them positionally. Every malformed mapping — wrong length,
 *    non-string element, hole — must fail closed and must NOT reach the loader.
 *    The policy's own normalized shape is asserted unchanged.
 * 3. **Refusals keep their codes.** A queue refusal (busy, timeout, cancelled),
 *    a helper refusal, and a lifetime cancellation must reach the caller as the
 *    same code they were raised with, never collapsed into one.
 *
 * Rules this file follows, matching `tests/entry.test.js`:
 * - No host package is imported. `src/index.js` imports
 *   `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`, which are not
 *   installed for this package; this file imports only
 *   `src/internal/driver-core.js` and `src/policy.js`, which import nothing
 *   outside this package.
 * - Every collaborator is a fake, so arming, ownership, loader behaviour and
 *   executor behaviour are controlled per test.
 * - No command, build, or test-runner invocation is performed by this file at
 *   import time; it only declares `node:test` cases.
 *
 * What this file still cannot prove is listed under `HOST PROOF GAPS` at the end.
 *
 * @module dsh-agent-test-driver/tests/core-agent-isolation
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DRIVER_CODES,
  OWN_TOOL_NAMES,
  buildStatus,
  createDriverCore,
  isAgentHandle,
  positionalModule,
  targetModules,
} from '../src/internal/driver-core.js';
import { createSingleToolInvoker } from '../src/internal/invoke-tool.js';
import { POLICY_CODES, normalizeConfig } from '../src/policy.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A raw admin configuration with one target and one test tool.
 *
 * Returned *raw*, not normalized: `arm()` validates it through
 * `policy.normalizeConfig()` and then re-attaches `pluginTargets[].modules`
 * (`reattachModules`), because the policy owns `directory`/`entries` only. A
 * fixture that handed the core an already-normalized config would bypass that
 * path and silently lose `modules`, which is exactly the split under test.
 *
 * @param {{ modules?: unknown, overrides?: object }} [options] Module mapping and field overrides.
 * @returns {object} Raw admin config.
 */
function makeConfig({ modules, overrides = {} } = {}) {
  return {
    pluginTargets: [
      modules === undefined
        ? { directory: 'practice', entries: ['practice:alpha'] }
        : { directory: 'practice', entries: ['practice:alpha'], modules },
    ],
    testTools: [{ name: 'echo_probe', module: 'sample-probe', expect: 'echo_probe' }],
    maxStatusBytes: 1024,
    invocationTimeoutMs: 250,
    ...overrides,
  };
}

/**
 * A fake loader entry.
 *
 * @param {{ id?: string, name?: string, state?: number, disabled?: boolean }} [options] Entry fields.
 * @returns {object} Fake entry.
 */
function makeEntry({ id = 'practice:alpha', name = 'sample-probe', state = 2, disabled = false } = {}) {
  return { options: { id, name, disabled }, fiber: { state } };
}

/**
 * A fake loader exposing the three methods the driver uses.
 *
 * @param {Record<string, object>} [entries] Entries by id.
 * @param {{ signal?: AbortSignal }} [options] Cancellation for `await()`.
 * @returns {object} Fake loader with a call recorder.
 */
function makeLoader(entries = { 'practice:alpha': makeEntry() }, { signal } = {}) {
  return {
    calls: [],
    resolve(id) {
      const entry = entries[id];
      if (entry === undefined) throw new Error(`unknown entry ${id}`);
      return entry;
    },
    update(id, options) {
      this.calls.push({ id, options });
    },
    async await() {
      if (signal?.aborted) throw new Error('aborted');
    },
  };
}

/**
 * An armed provenance probe result.
 *
 * @returns {object} Probe result.
 */
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
 * Build a core with fakes.
 *
 * The invoker port records which agent each invoker was constructed for and
 * which agent every `invoke()` was attributed to, which is exactly the identity
 * question these tests are about.
 *
 * @param {object} [options] Port and fixture overrides.
 * @param {object} [options.config] Configuration to arm with.
 * @param {object} [options.ports] Port overrides.
 * @param {object} [options.loader] Loader override.
 * @returns {{ core: object, calls: object, config: object, loader: object }} Core and recorders.
 */
function makeCore({ config, ports: portOverrides, loader: loaderOverride } = {}) {
  const resolvedConfig = config ?? makeConfig();
  const loader = loaderOverride ?? makeLoader();
  const calls = {
    probes: 0,
    mutations: [],
    invocations: [],
    /** One entry per created invoker: the agent handle it was bound to. */
    created: [],
    /** One entry per `invoke()`: the agent of the invoker that actually ran it. */
    attributed: [],
    /** One entry per `invoke()`: that invoker's own signal, captured at its construction. */
    signalsAtInvoke: [],
    /** One entry per `close()`: the index into {@link calls.created} it closed. */
    closed: [],
  };
  const core = createDriverCore({
    provenance: {
      probe: async () => {
        calls.probes += 1;
        return armedProbe();
      },
    },
    config: normalizeConfig,
    loader: () => loader,
    setEntryEnabled: async (input) => {
      calls.mutations.push(input);
      return {
        ok: true,
        receipt: {
          action: input.enabled ? 'enable' : 'disable',
          target: input.target,
          entry: input.entryId,
          module: input.module,
          before: 'disposed',
          after: input.enabled ? 'active' : 'disposed',
          changed: true,
          persisted: 'unknown',
          settled: true,
        },
      };
    },
    createInvoker: (options) => {
      // The fake mirrors the REAL helper's construction contract
      // (`internal/invoke-tool.js:151`): `agent` and `signal` are read ONCE,
      // here, and never re-read. A fake that read `options.signal` lazily would
      // keep passing even if the core went back to a per-agent cache with a
      // signal getter, which is exactly the bug these tests must catch.
      const bound = { agent: options.agent, signal: options.signal };
      const index = calls.created.push(bound) - 1;
      return {
        async invoke(name, args) {
          calls.attributed.push(bound.agent);
          calls.invocations.push({ name, args });
          calls.signalsAtInvoke.push(bound.signal);
          if (bound.signal.aborted) {
            return { ok: false, code: 'INVOKE_CANCELLED', status: 'request cancelled; no status reported' };
          }
          return { ok: true, code: 'INVOKE_OK', status: 'executed' };
        },
        close() {
          if (calls.closed.includes(index)) throw new Error('closed twice');
          calls.closed.push(index);
        },
      };
    },
    adminConfig: resolvedConfig,
    // Ownership stays unverified by default: no test in this file may pass
    // merely because a fixture granted ownership.
    resolveToolOwnership: () => ({ ok: false, reason: DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED }),
    ...portOverrides,
  });
  return { core, calls, config: resolvedConfig, loader };
}

/** A fake native execution context, shaped like the host's `ToolRunContext`. */
function makeExec(agent = { id: 'session-1' }) {
  return { agent, signal: new AbortController().signal };
}

/** A port that grants ownership. Named so each grant is an explicit choice. */
function grantOwnership() {
  return () => ({ ok: true, owner: 'practice' });
}

// ---------------------------------------------------------------------------
// 1. Per-call native dispatch: identity and cancellation
// ---------------------------------------------------------------------------

test('each call gets its own invoker built from that call\'s own agent', async () => {
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: grantOwnership() } });
  const first = makeExec({ id: 'session-1' });
  const second = makeExec({ id: 'session-2' });

  const firstResult = await core.invokeTool({ tool: 'echo_probe', args: { who: 'first' } }, first);
  const secondResult = await core.invokeTool({ tool: 'echo_probe', args: { who: 'second' } }, second);

  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal(calls.created.length, 2, 'one fresh invoker per call');
  assert.equal(calls.created[0].agent, first.agent, 'the first invoker is bound to the first caller\'s agent');
  assert.equal(calls.created[1].agent, second.agent, 'the second invoker is bound to the second caller\'s agent');
  // The defect this test exists for: with any shared reuse, both dispatches were
  // attributed to whichever agent invoked first.
  assert.deepEqual(calls.attributed, [first.agent, second.agent],
    'each dispatch must be attributed to the agent of that call');
  assert.deepEqual(calls.invocations, [
    { name: 'echo_probe', args: { who: 'first' } },
    { name: 'echo_probe', args: { who: 'second' } },
  ]);
});

test('a repeated call from the same agent does not reuse the earlier invoker', async () => {
  // The previous worker's per-agent cache asserted the opposite here. It cannot
  // be right: the helper captures `signal` once at construction
  // (`src/internal/invoke-tool.js:151`), so a reused invoker can only observe the
  // signal of the call it was built for — dropping cancellation for every later
  // call from that agent.
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: grantOwnership() } });
  const exec = makeExec({ id: 'session-1' });

  await core.invokeTool({ tool: 'echo_probe' }, exec);
  await core.invokeTool({ tool: 'echo_probe' }, exec);

  assert.equal(calls.created.length, 2, 'two calls build two invokers');
  assert.notEqual(calls.created[0].signal, calls.created[1].signal,
    'each call must carry its own cancellation signal');
  assert.deepEqual(calls.attributed, [exec.agent, exec.agent], 'both calls still dispatch as the same agent');
});

test('two agent handles sharing one session id are dispatched separately', async () => {
  // A session id is caller-visible and therefore not an identity. Keying
  // anything on `agent.id` would let a second handle reuse another agent's
  // executor context purely by claiming the same session.
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: grantOwnership() } });
  const impersonated = makeExec({ id: 'session-shared', kind: 'trusted' });
  const other = makeExec({ id: 'session-shared', kind: 'untrusted' });

  await core.invokeTool({ tool: 'echo_probe' }, impersonated);
  await core.invokeTool({ tool: 'echo_probe' }, other);

  assert.notEqual(impersonated.agent, other.agent, 'the fixture must use distinct handles');
  assert.deepEqual(calls.attributed, [impersonated.agent, other.agent],
    'equal ids must not collapse two handles into one dispatch identity');
});

test('every invoker is closed exactly once, on its own settlement', async () => {
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: grantOwnership() } });
  await core.invokeTool({ tool: 'echo_probe' }, makeExec({ id: 'session-1' }));
  await core.invokeTool({ tool: 'echo_probe' }, makeExec({ id: 'session-2' }));

  assert.deepEqual(calls.closed, [0, 1], 'each settled call closes exactly its own invoker, once');
});

test('every invoker still open at dispose is closed', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { core, calls } = makeCore({
    ports: {
      resolveToolOwnership: grantOwnership(),
      createInvoker: (options) => {
        const bound = { agent: options.agent };
        const index = calls.created.push(bound) - 1;
        return {
          async invoke() {
            await gate;
            return { ok: true, code: 'INVOKE_OK', status: 'executed' };
          },
          close() {
            calls.closed.push(index);
          },
        };
      },
    },
  });
  // One call is in flight when the plugin is disposed.
  const pending = core.invokeTool({ tool: 'echo_probe' }, makeExec({ id: 'session-1' }));
  // Wait for the invoker to exist, not for a fixed number of ticks. The invoker
  // is built inside the exclusive slot, which is entered a few microtasks after
  // `arm()` settles; disposing before that point closes nothing (there is
  // nothing yet) and the call is closed by its own settlement path instead,
  // which would make this test pass while proving the opposite of its name.
  for (let tick = 0; tick < 8 && calls.created.length === 0; tick += 1) await Promise.resolve();
  assert.equal(calls.created.length, 1, 'the in-flight call has a live invoker before dispose');
  core.dispose();

  assert.deepEqual(calls.closed, [0], 'the in-flight invoker is closed by dispose');

  const after = await core.invokeTool({ tool: 'echo_probe' }, makeExec({ id: 'session-2' }));
  assert.equal(after.ok, false);
  assert.equal(after.code, DRIVER_CODES.UNAVAILABLE);
  assert.equal(calls.created.length, 1, 'no invoker is created after dispose');

  release();
  await pending;
});

test('a non-object agent is refused before any invoker is created', async () => {
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: grantOwnership() } });
  const result = await core.invokeTool({ tool: 'echo_probe' }, { agent: 'session-1', signal: new AbortController().signal });
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.NO_TURN, 'a string is not an agent handle');
  assert.equal(calls.created.length, 0);
});

test('unverified ownership still denies before any agent binding', async () => {
  // The default port refuses; no agent, allowlisted name, or matching session id
  // may turn a name into ownership evidence.
  //
  // The fixture must declare the entry's positional module, otherwise the claim
  // is refused earlier as `TOOL_OWNERSHIP_UNMAPPABLE` ("no readable module") and
  // this test would never reach the ownership port it is about. The unmappable
  // branch has its own coverage below, so declaring `modules` keeps this case
  // testing exactly one thing: an allowlisted name with a readable, matching
  // mapping and still no ownership evidence is refused.
  const { core, calls } = makeCore({ config: makeConfig({ modules: ['sample-probe'] }) });
  const result = await core.invokeTool({ tool: 'echo_probe', entry: 'practice:alpha' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED);
  assert.equal(calls.created.length, 0, 'no invoker is created for an unverified tool');
  assert.equal(calls.invocations.length, 0);
});

test('the agent shape check accepts objects and rejects everything else', () => {
  assert.equal(isAgentHandle({ id: 'session-1' }), true);
  assert.equal(isAgentHandle('session-1'), false);
  assert.equal(isAgentHandle(null), false);
  assert.equal(isAgentHandle(undefined), false);
});

// ---------------------------------------------------------------------------
// 2. Positional module mapping
// ---------------------------------------------------------------------------

test('the policy keeps its normalized target shape and does not carry modules', () => {
  // This pins the split the core's arm-time validation must respect: adding
  // `modules` to the policy would move an allowlist rule into the parser.
  const normalized = normalizeConfig({
    pluginTargets: [{ directory: 'practice', entries: ['practice:alpha'] }],
    testTools: [],
  });
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.config.pluginTargets, [{ directory: 'practice', entries: ['practice:alpha'] }]);
  assert.equal('modules' in normalized.config.pluginTargets[0], false);
});

test('targetModules reports one module per entry for a well-formed mapping', () => {
  const target = { directory: 'practice', entries: ['practice:alpha', 'practice:beta'], modules: ['a', 'b'] };
  assert.deepEqual(targetModules(target), ['a', 'b']);
  assert.equal(positionalModule(target, 'practice:alpha'), 'a');
  assert.equal(positionalModule(target, 'practice:beta'), 'b');
  assert.equal(positionalModule({ ...target, entries: ['practice:alpha'] }, 'practice:beta'), undefined,
    'an id outside the target has no module');
});

test('targetModules fails closed on every malformed mapping', () => {
  const entries = ['practice:alpha', 'practice:beta'];
  const base = { directory: 'practice', entries };
  // Declares none.
  assert.equal(targetModules(base), null);
  // Unreadable: length mismatch in both directions.
  assert.equal(targetModules({ ...base, modules: ['a'] }), undefined);
  assert.equal(targetModules({ ...base, modules: ['a', 'b', 'c'] }), undefined);
  // Not an array.
  assert.equal(targetModules({ ...base, modules: 'a' }), undefined);
  assert.equal(targetModules({ ...base, modules: { 0: 'a', 1: 'b', length: 2 } }), undefined);
  // Length matches, but an element is not a usable specifier.
  assert.equal(targetModules({ ...base, modules: ['a', 7] }), undefined);
  assert.equal(targetModules({ ...base, modules: ['a', ''] }), undefined);
  // A hole. `Array.prototype.every` SKIPS holes, so a per-element rule written
  // with `every()` would never look at the hole and a length-only check would
  // accept the mapping. The fixture is therefore built at its real length
  // (`slice(0, 2)` of `['a', , 'c']` truncates to one element and would not
  // exercise the hole at all), and the assertion pins that a hole with a
  // matching length is refused.
  // eslint-disable-next-line no-sparse-arrays
  const sparse = ['a', , ];
  assert.equal(sparse.length, 2, 'the sparse fixture must have the matching length');
  assert.equal(1 in sparse, false, 'the sparse fixture must really contain a hole');
  assert.equal(targetModules({ ...base, modules: sparse }), undefined, 'a sparse mapping must not read as length-valid');
});

test('lifecycle refuses an unreadable module mapping and never reaches the loader', async () => {
  const entries = ['practice:alpha', 'practice:beta'];
  // `declares none` is excluded here and covered separately below: it takes a
  // different guard in `pluginSetEnabled`, so asserting this loop's code on it
  // would test the other branch.
  const cases = [
    { label: 'too short', modules: ['sample-probe'] },
    { label: 'too long', modules: ['sample-probe', 'other-module', 'third'] },
    { label: 'non-array', modules: 'sample-probe' },
    { label: 'non-string element', modules: [7, 'other-module'] },
    { label: 'empty-string element', modules: ['', 'other-module'] },
  ];
  for (const scenario of cases) {
    const config = {
      pluginTargets: [{ directory: 'practice', entries, modules: scenario.modules }],
      testTools: [{ name: 'echo_probe', module: 'sample-probe', expect: 'echo_probe' }],
      maxStatusBytes: 1024,
      invocationTimeoutMs: 250,
    };
    const { core, calls } = makeCore({
      config,
      loader: makeLoader({
        'practice:alpha': makeEntry({ id: 'practice:alpha' }),
        'practice:beta': makeEntry({ id: 'practice:beta' }),
      }),
      ports: { resolveToolOwnership: grantOwnership() },
    });
    const result = await core.pluginSetEnabled(
      { plugin: 'practice', entry: 'practice:alpha', enabled: false },
      makeExec(),
    );
    assert.equal(result.ok, false, `${scenario.label}: a malformed mapping must be refused`);
    assert.equal(result.code, DRIVER_CODES.UNAVAILABLE, `${scenario.label}: refusal is a fixed code`);
    assert.equal(calls.mutations.length, 0, `${scenario.label}: the loader must not be reached`);
  }
});

test('lifecycle refuses a target that declares no module at all', async () => {
  // The absent case takes the earlier guard (`positionalModule` returns
  // `undefined`) and must still refuse with the same fixed code and no loader
  // call: "declares none" is never treated as "trust the live entry".
  const { core, calls } = makeCore({
    config: {
      pluginTargets: [{ directory: 'practice', entries: ['practice:alpha'] }],
      testTools: [],
      maxStatusBytes: 1024,
      invocationTimeoutMs: 250,
    },
  });
  const result = await core.pluginSetEnabled(
    { plugin: 'practice', entry: 'practice:alpha', enabled: false },
    makeExec(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.UNAVAILABLE);
  assert.equal(calls.mutations.length, 0);
});

test('lifecycle reads the module at the entry\'s own position, not by name', async () => {
  // `beta` is the second entry; a name- or index-blind read would hand the
  // helper alpha's module. The mapping also survives the arm even though
  // `normalizeConfig()` itself drops `modules` (`reattachModules` restores it).
  const config = {
    pluginTargets: [{
      directory: 'practice',
      entries: ['practice:alpha', 'practice:beta'],
      modules: ['module-alpha', 'module-beta'],
    }],
    testTools: [],
    maxStatusBytes: 1024,
    invocationTimeoutMs: 250,
  };
  const loader = makeLoader({
    'practice:alpha': makeEntry({ id: 'practice:alpha', name: 'module-alpha' }),
    'practice:beta': makeEntry({ id: 'practice:beta', name: 'module-beta' }),
  });
  const { core, calls } = makeCore({ config, loader });
  const result = await core.pluginSetEnabled(
    { plugin: 'practice', entry: 'practice:beta', enabled: false },
    makeExec(),
  );
  assert.equal(result.ok, true, 'the arm must retain the entry-owned module mapping');
  assert.equal(calls.mutations.length, 1);
  assert.equal(calls.mutations[0].module, 'module-beta', 'the positional module must follow the entry');
  assert.equal(calls.mutations[0].entryId, 'practice:beta');
});

test('status distinguishes an absent mapping from an unreadable one', async () => {
  const loader = makeLoader();
  const absent = buildStatus({
    provenance: { armed: true },
    config: { pluginTargets: [{ directory: 'practice', entries: ['practice:alpha'] }], testTools: [] },
    loader: undefined,
  });
  assert.equal(absent.entries[0].phase, 'undeclared',
    'a target that declares no module is undeclared, not unreadable');

  const unreadable = buildStatus({
    provenance: { armed: true },
    config: { pluginTargets: [{ directory: 'practice', entries: ['practice:alpha'], modules: ['a', 'b'] }], testTools: [] },
    loader,
  });
  assert.equal(unreadable.entries[0].phase, 'unreadable',
    'a length-mismatched mapping is reported as unreadable rather than partially trusted');
  assert.equal(unreadable.entries[0].module, '', 'no module is guessed from a malformed mapping');
});

// ---------------------------------------------------------------------------
// 3. Refusal codes and lifetime cancellation
// ---------------------------------------------------------------------------

test('a same-operation concurrent invocation is refused while one is in flight', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { core, calls } = makeCore({
    ports: {
      resolveToolOwnership: grantOwnership(),
      createInvoker: (options) => {
        calls.created.push({ agent: options.agent });
        return {
          async invoke() {
            calls.attributed.push(options.agent);
            await gate;
            return { ok: true, code: 'INVOKE_OK', status: 'executed' };
          },
          close() {},
        };
      },
    },
  });
  const exec = makeExec({ id: 'session-1' });
  const first = core.invokeTool({ tool: 'echo_probe' }, exec);
  // The same agent asks again on the same operation while the slot is held.
  const second = await core.invokeTool({ tool: 'echo_probe' }, exec);
  assert.equal(second.ok, false);
  assert.equal(second.code, DRIVER_CODES.BUSY, 'the exclusive slot refuses the second operation');
  release();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(calls.attributed.length, 1, 'the refused call never reached the executor');
});

test('a concurrent invocation from a different agent is also refused, not queued', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { core, calls } = makeCore({
    ports: {
      resolveToolOwnership: grantOwnership(),
      createInvoker: (options) => {
        calls.created.push({ agent: options.agent });
        return {
          async invoke() {
            calls.attributed.push(options.agent);
            await gate;
            return { ok: true, code: 'INVOKE_OK', status: 'executed' };
          },
          close() {},
        };
      },
    },
  });
  const first = core.invokeTool({ tool: 'echo_probe' }, makeExec({ id: 'session-1' }));
  const second = await core.invokeTool({ tool: 'echo_probe' }, makeExec({ id: 'session-2' }));
  assert.equal(second.ok, false);
  assert.equal(second.code, DRIVER_CODES.BUSY,
    'per-agent isolation must not weaken the single shared mutation queue');
  release();
  await first;
});

test('a later call from the same agent is not cancelled by an earlier call\'s signal', async () => {
  // The regression this pins: the helper observes the signal it was CONSTRUCTED
  // with, and `invoke()` runs only after the shared slot is acquired. If the
  // first call's signal were cached with an invoker — or replaced by a
  // never-aborting placeholder, the previous worker's approach — the later call
  // would either be cancelled by a finished call's abort or never cancellable.
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: grantOwnership() } });
  const agent = { id: 'session-1' };
  const firstCall = new AbortController();

  const first = await core.invokeTool({ tool: 'echo_probe' }, { agent, signal: firstCall.signal });
  assert.equal(first.ok, true);
  // Abort the first call's signal AFTER it settled. Nothing is in flight.
  firstCall.abort(new Error('late abort of a finished call'));

  // A fresh call from the same agent, with a fresh, un-aborted signal.
  const second = await core.invokeTool({ tool: 'echo_probe' }, { agent, signal: new AbortController().signal });
  assert.equal(second.ok, true, 'a finished call\'s abort must not poison the agent\'s next call');
  assert.deepEqual(calls.signalsAtInvoke.map((signal) => signal.aborted), [false, false],
    'neither invoker may be constructed with an already-aborted signal');
  assert.notEqual(calls.signalsAtInvoke[0], calls.signalsAtInvoke[1],
    'the second call must not observe the first call\'s signal at all');
  assert.equal(calls.created.length, 2, 'two calls, two invokers');
});

test('a call cancelled while its invoker is live forwards the abort into that signal', async () => {
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { core, calls } = makeCore({
    ports: {
      resolveToolOwnership: grantOwnership(),
      createInvoker: (options) => {
        const bound = { agent: options.agent, signal: options.signal };
        const index = calls.created.push(bound) - 1;
        return {
          async invoke() {
            // The helper forwards its construction signal into the native batch
            // and reports cancellation after the promise settles
            // (`internal/invoke-tool.js:205`), so the fake waits for the drain.
            await gate;
            if (bound.signal.aborted) {
              return { ok: false, code: 'INVOKE_CANCELLED', status: 'request cancelled; no status reported' };
            }
            return { ok: true, code: 'INVOKE_OK', status: 'executed' };
          },
          close() {
            calls.closed.push(index);
          },
        };
      },
    },
  });
  const pending = core.invokeTool({ tool: 'echo_probe' }, { agent: { id: 'session-1' }, signal: controller.signal });
  // The invoker is built inside the exclusive slot, which `queue.run()` enters
  // one microtask after `arm()` has settled, so reaching it takes more than one
  // hop. Wait for the recorded construction instead of guessing a tick count: a
  // fixed count kept passing only while the fixture was wrong.
  for (let tick = 0; tick < 8 && calls.created.length === 0; tick += 1) await Promise.resolve();
  assert.equal(calls.created.length, 1, 'the call reached the executor');
  // The invoker was built; `invoke()` may already be inside its `await`, so
  // `signalsAtInvoke` is not a reliable readiness signal here. What the core
  // must guarantee is that this invoker was built with a signal belonging to THIS
  // call and that the caller's abort is forwarded into it. It is deliberately NOT
  // the caller's own object: `callSignal()` (`driver-core.js:204-249`) derives a
  // fresh per-call controller so aborting one call can never abort another.
  assert.notEqual(calls.created[0].signal, controller.signal,
    'each call gets its own derived signal, never the caller\'s own object');
  assert.equal(calls.created[0].signal.aborted, false, 'the derived signal is live at construction');
  controller.abort(new Error('caller gave up'));
  assert.equal(calls.created[0].signal.aborted, true,
    'the caller abort must be forwarded into the live invoker\'s own signal');
  assert.equal(calls.created[0].signal.reason?.message, 'caller gave up',
    'the derived signal carries the caller\'s reason');
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  // The slot, not the helper, reports a caller cancellation: `exclusive()`
  // maps its own busy/timeout/cancel to `DRIVER_BUSY` and preserves only a code
  // the helper itself returned (`driver-core.js:872-899`). That contract is
  // already pinned in `tests/core-ownership-context.test.js:589-592`; the
  // helper's own `INVOKE_CANCELLED` is asserted in `tests/invoke-tool.test.js`,
  // where no slot wraps it. This test is about the abort reaching the live
  // invoker, which is asserted above.
  assert.equal(result.code, DRIVER_CODES.BUSY, 'the slot reports the caller cancellation');
  assert.deepEqual(calls.closed, [0], 'the cancelled call still closes its own invoker');
});

test('a call whose own signal is already aborted is refused before dispatch', async () => {
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: grantOwnership() } });
  const agent = { id: 'session-1' };
  await core.invokeTool({ tool: 'echo_probe' }, { agent, signal: new AbortController().signal });

  const abandoned = new AbortController();
  abandoned.abort();
  const result = await core.invokeTool({ tool: 'echo_probe' }, { agent, signal: abandoned.signal });
  assert.equal(result.ok, false, 'an already-cancelled call must not dispatch to the executor');
  assert.equal(calls.created.length, 1,
    'the executor must not receive an invocation — and so no invoker — for a cancelled call');
  // The damage of dispatching a doomed call is not only the wasted executor
  // entry: it also parks `invoke:<tool>` as an unsettled mutation, so every later
  // call is refused `BUSY` on behalf of work nobody wants. Both must be clear.
  assert.equal(core.queue.pending, 0, 'a cancelled call must not hold the exclusive slot');
  assert.equal(core.queue.unsettled, undefined, 'a cancelled call must not be recorded as unsettled');
  const next = await core.invokeTool({ tool: 'echo_probe' }, { agent, signal: new AbortController().signal });
  assert.equal(next.ok, true, 'a cancelled call must not block the next call');
});

test('a helper refusal keeps its own code instead of collapsing to one', async () => {
  const { core } = makeCore({
    config: makeConfig({ modules: ['sample-probe'] }),
    ports: {
      // A helper refusal naming a specific loader failure.
      setEntryEnabled: async () => ({
        ok: false,
        code: 'DRIVER_UPDATE_FAILED',
        message: 'the loader rejected the change for "practice:alpha"',
        entry: 'practice:alpha',
      }),
    },
  });
  const result = await core.pluginSetEnabled(
    { plugin: 'practice', entry: 'practice:alpha', enabled: true },
    makeExec(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DRIVER_UPDATE_FAILED', 'the helper code must survive, not become a generic refusal');
  assert.ok(!result.message.includes('practice:alpha'), 'the helper message must still be replaced');
});

test('an invocation refusal keeps the helper\'s code', async () => {
  const { core } = makeCore({
    ports: {
      resolveToolOwnership: grantOwnership(),
      createInvoker: () => ({
        async invoke() {
          return { ok: false, code: 'INVOKE_TOOL_ERROR', status: 'the tool failed' };
        },
        close() {},
      }),
    },
  });
  const result = await core.invokeTool({ tool: 'echo_probe' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVOKE_TOOL_ERROR');
});

test('a queue timeout surfaces as the driver busy code, not as a host error', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { core } = makeCore({
    config: makeConfig({ overrides: { invocationTimeoutMs: 20 } }),
    ports: {
      resolveToolOwnership: grantOwnership(),
      createInvoker: () => ({
        async invoke() {
          await gate;
          return { ok: true, code: 'INVOKE_OK', status: 'executed' };
        },
        close() {},
      }),
    },
  });
  const result = await core.invokeTool({ tool: 'echo_probe' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.BUSY);
  release();
});

test('an aborted caller signal surfaces as the driver busy code', async () => {
  const controller = new AbortController();
  controller.abort();
  const { core } = makeCore({
    config: makeConfig({ modules: ['sample-probe'] }),
    ports: {
      setEntryEnabled: async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        return { ok: true, receipt: { action: 'disable', target: 'practice', entry: 'practice:alpha', module: 'sample-probe', before: 'active', after: 'disposed', changed: true, settled: true } };
      },
    },
  });
  const result = await core.pluginSetEnabled(
    { plugin: 'practice', entry: 'practice:alpha', enabled: false },
    { agent: { id: 'session-1' }, signal: controller.signal },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.BUSY, 'a cancelled caller is reported through the fixed busy code');
});

test('the plugin-lifetime signal bounds an operation that passes no caller signal for lifecycle', async () => {
  const controller = new AbortController();
  const { core } = makeCore({
    config: makeConfig({ modules: ['sample-probe'] }),
    ports: {
      signal: controller.signal,
      setEntryEnabled: async ({ signal }) => {
        // The lifetime signal must reach the helper, not a per-call invention.
        assert.equal(signal, controller.signal, 'lifecycle forwards the plugin-lifetime signal');
        return {
          ok: true,
          receipt: {
            action: 'disable',
            target: 'practice',
            entry: 'practice:alpha',
            module: 'sample-probe',
            before: 'active',
            after: 'disposed',
            changed: true,
            settled: true,
          },
        };
      },
    },
  });
  const result = await core.pluginSetEnabled(
    { plugin: 'practice', entry: 'practice:alpha', enabled: false },
    { agent: { id: 'session-1' } },
  );
  assert.equal(result.ok, true);
});

test('closing the plugin refuses later operations with the unavailable code', async () => {
  const { core } = makeCore({ config: makeConfig({ modules: ['sample-probe'] }) });
  core.dispose();
  const lifecycle = await core.pluginSetEnabled(
    { plugin: 'practice', entry: 'practice:alpha', enabled: false },
    makeExec(),
  );
  assert.equal(lifecycle.ok, false);
  assert.equal(lifecycle.code, DRIVER_CODES.UNAVAILABLE);
  const status = await core.status();
  assert.equal(status.ok, false);
  assert.equal(status.code, DRIVER_CODES.UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// 4. Integration: the REAL single-tool invoker, through the core
// ---------------------------------------------------------------------------

/**
 * A native tools service fake.
 *
 * Only `execute` exists, because `src/internal/invoke-tool.js` calls nothing
 * else on `ctx.tools` (`internal/invoke-tool.js:199`). It records the exact
 * input the helper passed — including `agent` and `signal` — and answers in the
 * model-shaped envelope the helper parses
 * (`{ results: [{ callId, result: { isError, value | error, content } }] }`),
 * echoing the generated call id so the helper can find its own entry.
 *
 * @param {{ hold?: Promise<void>, fail?: boolean }} [options]
 * @returns {{ calls: object[], execute: Function }} The fake and its recorder.
 */
function makeTools({ hold, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async execute(input) {
      calls.push(input);
      if (hold !== undefined) await hold;
      const block = input.calls[0];
      return {
        results: [{
          callId: block.id,
          result: fail
            ? { isError: true, error: 'boom', content: [{ type: 'text', text: 'boom' }] }
            : { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] },
        }],
      };
    },
  };
}

/**
 * Build a core whose invoker port is the REAL `createSingleToolInvoker`, with a
 * permissive ownership predicate. This is the closest a unit test gets to the
 * host: the identity and cancellation contract under test is the helper's own,
 * not a stand-in.
 *
 * @param {{ config?: object, tools: object, onInvoke?: Function }} options
 * @returns {{ core: object, closed: object[] }} The core and a close recorder.
 */
function makeRealCore({ config: configOverride, tools, onInvoke } = {}) {
  const closed = [];
  const core = createDriverCore({
    provenance: { probe: async () => armedProbe() },
    config: normalizeConfig,
    loader: () => makeLoader(),
    setEntryEnabled: async () => ({ ok: false, code: 'DRIVER_UPDATE_FAILED', message: 'not used' }),
    createInvoker: (options) => {
      // The core's `createInvoker` options are `createSingleToolInvoker`'s
      // options WITHOUT the host service: the entry closes over `ctx.tools` and
      // injects it itself (`src/index.js`, `tools: ctx.tools`), exactly as this
      // fixture does with the fake executor below. Omitting `tools` made the real
      // helper throw `TypeError: tools must be the native tools service
      // (ctx.tools)`; the core reported that as `DRIVER_HOST_UNAVAILABLE`, so
      // every integration test below looked like a dispatch defect when the
      // defect was in this fixture.
      const created = createSingleToolInvoker({ ...options, tools });
      return {
        invoke: (name, args) => {
          onInvoke?.();
          return created.invoke(name, args);
        },
        close: () => {
          closed.push(created);
          created.close();
        },
      };
    },
    adminConfig: configOverride ?? makeConfig(),
    // Permissive on purpose: these tests are about dispatch identity, and the
    // default refusal path is covered separately in section 1.
    resolveToolOwnership: () => ({ ok: true, owner: 'practice' }),
  });
  return { core, closed };
}

/** A promise plus its resolver, spelled out so no helper hides the seams. */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('integration: a caller abort on the first call really reaches tools.execute', async () => {
  const hold = deferred();
  const tools = makeTools({ hold: hold.promise });
  const { core } = makeRealCore({ tools });
  const controller = new AbortController();
  const agent = { id: 'session-1' };

  const pending = core.invokeTool({ tool: 'echo_probe' }, { agent, signal: controller.signal });
  // Wait for the executor entry itself: `arm()` resolves, the queue hands out its
  // slot, and the helper constructs and enters `invoke()` before `tools.execute`
  // is reached. A fixed hop count encodes that chain's current length and turns a
  // fixture change into a "not reached" failure.
  for (let tick = 0; tick < 8 && tools.calls.length === 0; tick += 1) await Promise.resolve();
  assert.equal(tools.calls.length, 1, 'the real helper reached the executor');
  assert.equal(tools.calls[0].agent, agent, 'the exact caller agent reaches tools.execute');
  assert.equal(tools.calls[0].signal.aborted, false, 'the batch signal is live at dispatch');

  controller.abort(new Error('caller gave up'));
  assert.equal(tools.calls[0].signal.aborted, true,
    'the caller abort must be forwarded into the native batch signal');

  hold.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  // What this integration test proves is the plumbing: the caller's abort reaches
  // the live helper's batch signal (asserted above) and no success is reported.
  // The CODE is the slot's, not the helper's: `exclusive()` maps its own
  // busy/timeout/cancel to `DRIVER_BUSY` and only preserves a code the operation
  // itself returned (`driver-core.js:872-899`); here the slot's caller-side race
  // wins before the helper's post-abort `INVOKE_CANCELLED` can be handed back.
  // The helper's own code is covered in `tests/invoke-tool.test.js` without a slot.
  assert.equal(result.code, 'DRIVER_BUSY', 'the slot reports the caller cancellation');
});

test('integration: the same Agent is not poisoned by an earlier call\'s aborted signal', async () => {
  const tools = makeTools();
  const { core, closed } = makeRealCore({ tools });
  const agent = { id: 'session-1' };
  const first = new AbortController();

  const firstResult = await core.invokeTool({ tool: 'echo_probe' }, { agent, signal: first.signal });
  assert.equal(firstResult.ok, true);
  first.abort(new Error('late abort of a finished call'));

  const second = await core.invokeTool({ tool: 'echo_probe' }, { agent, signal: new AbortController().signal });
  assert.equal(second.ok, true, 'a finished call\'s abort must not poison the same agent\'s next call');
  assert.equal(tools.calls.length, 2, 'both calls reached the executor');
  assert.equal(tools.calls[1].signal.aborted, false, 'the second batch signal is its own, un-aborted one');
  assert.notEqual(tools.calls[0].signal, tools.calls[1].signal, 'each call gets a distinct batch signal');
  assert.equal(tools.calls[1].agent, agent, 'the second call still dispatches as the same agent');
  assert.equal(closed.length, 2, 'both invokers were closed after settling');
});

test('integration: a second, distinct Agent is dispatched under its own identity', async () => {
  const tools = makeTools();
  const { core } = makeRealCore({ tools });
  const first = { id: 'session-1' };
  const second = { id: 'session-2' };

  await core.invokeTool({ tool: 'echo_probe' }, { agent: first, signal: new AbortController().signal });
  await core.invokeTool({ tool: 'echo_probe' }, { agent: second, signal: new AbortController().signal });

  assert.equal(tools.calls.length, 2);
  assert.equal(tools.calls[0].agent, first);
  assert.equal(tools.calls[1].agent, second, 'the second agent\'s call must not run as the first agent');
});

test('integration: a real tool failure keeps the helper\'s tool-error code', async () => {
  const tools = makeTools({ fail: true });
  const { core } = makeRealCore({ tools });
  const result = await core.invokeTool(
    { tool: 'echo_probe' },
    { agent: { id: 'session-1' }, signal: new AbortController().signal },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVOKE_TOOL_ERROR', 'the helper\'s code survives the receipt projection');
});

test('integration: dispose closes the in-flight invoker; the call already dispatched still settles', async () => {
  // `close()` in the helper only refuses FURTHER invocations
  // (`internal/invoke-tool.js:221-223`); it cannot cancel a call already awaiting
  // the host, because `AbortController` is cooperative and the executor "never
  // settle[s] while started work is still running" (`executor.ts:79-80`). So the
  // in-flight call settles normally, and what dispose guarantees is that no
  // later call can dispatch through the closed invoker.
  const hold = deferred();
  const tools = makeTools({ hold: hold.promise });
  const { core, closed } = makeRealCore({ tools });
  const agent = { id: 'session-1' };

  const pending = core.invokeTool({ tool: 'echo_probe' }, { agent, signal: new AbortController().signal });
  // Wait for the observable fact (the executor entry) rather than a tick count:
  // the invoker is built inside the exclusive slot, a few microtasks after the
  // arm settles, and a fixed count silently reads 0 while the fixture is wrong.
  for (let tick = 0; tick < 8 && tools.calls.length === 0; tick += 1) await Promise.resolve();
  assert.equal(tools.calls.length, 1);

  core.dispose();
  assert.equal(closed.length, 1, 'dispose closes the invoker of the unsettled call');

  // The slot must still be held: an unsettled native call is not abandoned.
  const during = await core.invokeTool({ tool: 'echo_probe' }, { agent, signal: new AbortController().signal });
  assert.equal(during.ok, false);
  assert.equal(during.code, DRIVER_CODES.UNAVAILABLE, 'a disposed plugin refuses new work');
  assert.equal(tools.calls.length, 1, 'no second dispatch happens after dispose');

  hold.resolve();
  const settled = await pending;
  assert.equal(settled.ok, true, 'the call that had already reached the executor still reports its real result');
});

// ---------------------------------------------------------------------------
// Shared vocabulary invariants
// ---------------------------------------------------------------------------

test('the driver\'s own tool names are frozen and cover the registered set', () => {
  assert.equal(Object.isFrozen(OWN_TOOL_NAMES), true);
  assert.deepEqual([...OWN_TOOL_NAMES], [
    'test_driver_status',
    'test_driver_plugin_set_enabled',
    'test_driver_invoke_tool',
  ]);
});

/**
 * HOST PROOF GAPS — what this suite cannot establish, and what only a real DSH
 * process under the hard cgroup can:
 *
 * 1. That the host's real executor honours `agent` and `signal` end to end.
 *    Section 4 runs the REAL `createSingleToolInvoker()` against a fake
 *    `tools.execute`, so it proves the core passes the right agent and a live
 *    per-call signal into the helper, and that the helper forwards the caller
 *    abort into the batch signal. It cannot show the guard pipeline, the policy
 *    chain, or how a real executor drains work after an abort — that needs a
 *    real DSH process.
 * 2. That the host actually hands a distinct `Agent` object per session. Per-agent
 *    isolation is only as good as `ToolRunContext.agent`
 *    (`packages/core/tools/src/contracts.ts`), which these tests fake.
 * 3. That `Config` accepts `pluginTargets[].modules` and that the host config
 *    parser preserves its positional order. The core validates the mapping at
 *    the arm, but the parser is the one that produces it.
 * 4. That the plugin-lifetime signal `ctx.scope?.signal` is wired by the host
 *    and aborts on unload. Here it is injected directly.
 * 5. That `entry.options.id` is what `loader-ops.checkEntryModule()` compares;
 *    the loader in these fixtures is a fake, not `vendor/loader`.
 */
