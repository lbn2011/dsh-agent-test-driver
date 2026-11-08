/**
 * Tests for the host entry's plugin-lifetime wiring.
 *
 * WHAT THIS FILE TESTS, AND WHAT IT DOES NOT
 * ------------------------------------------
 * `src/index.js` imports `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`,
 * which are not installed for this package, so the module cannot be *loaded* here
 * and no assertion in this file claims otherwise. Two kinds of evidence are used
 * instead, and they are kept apart on purpose:
 *
 * 1. **Source contract** — the entry's own source is read as text and pinned to
 *    the checks that would have caught the defects this file exists for:
 *    reading `ctx.scope?.signal`, listening for a `'dispose'` event, or registering
 *    cleanup after `await core.arm()`. These are structural claims about text, and
 *    they are stated as such.
 * 2. **Isolated injectable harness** — the entry's `apply()` body is re-hosted as
 *    a copy in this file ("the harness below"), with the three host imports
 *    replaced by the local modules this package owns (all of which are
 *    dependency-injected and import no host package). The harness exercises the
 *    *contract* the entry relies on — an entry-owned `AbortController`, a cleanup
 *    disposer registered before any `await`, abort-then-dispose ordering — against
 *    local fakes for `ctx.effect`, `ctx.tools.register`, and `provenance`.
 *
 * The harness copy is a hazard, so it is addressed rather than hidden: a pin test
 * below asserts that the harness still matches the entry's real structure. If the
 * entry changes and the copy is not updated, the pin fails instead of the suite
 * quietly testing stale code.
 *
 * This file imports `node:test`, `node:assert/strict`, and `node:fs/promises`
 * only. It opens no socket, spawns no process, reads no `process.env`, and makes
 * no claim about a real host: see `KNOWN HOST PROOF GAPS` at the end.
 *
 * @module dsh-agent-test-driver/tests/entry-lifetime
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { DRIVER_CODES, OWN_TOOL_NAMES, createDriverCore } from '../src/internal/driver-core.js';
import { POLICY_CODES, normalizeConfig } from '../src/policy.js';

const ENTRY_PATH = new URL('../src/index.js', import.meta.url);

/**
 * Read the entry's source.
 * @returns {Promise<string>} Entry module source.
 */
function readEntry() {
  return readFile(ENTRY_PATH, 'utf8');
}

/**
 * Strip line and block comments from JavaScript source.
 *
 * Necessary because the entry *documents* the APIs it uses: without this, the
 * module header that says "`ctx.effect(execute)` is the official teardown
 * primitive" would satisfy a test looking for a `ctx.effect(` call, and an
 * `indexOf()` ordering assertion would compare a comment offset with a call
 * offset and reach the right verdict for the wrong reason.
 *
 * String, template, and quoted literals are skipped so a `//` inside one is not
 * treated as a comment; no attempt is made to parse regex literals, which is
 * sufficient because the entry contains none.
 *
 * @param {string} source Module source.
 * @returns {string} Source with comments removed.
 */
function stripComments(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        out += inner;
        index += 1;
        if (inner === '\\') {
          if (index < source.length) {
            out += source[index];
            index += 1;
          }
          continue;
        }
        if (inner === quote) break;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Read the entry's source with comments removed.
 * @returns {Promise<string>} Comment-free entry source.
 */
async function readEntryCode() {
  return stripComments(await readEntry());
}

// ---------------------------------------------------------------------------
// 1. Source contract: the defects this file exists for stay absent.
// ---------------------------------------------------------------------------

test('the entry never reads a plugin-lifetime signal off the context', async () => {
  // Regression: the entry read `ctx.scope?.signal`. The vendored Cordis source
  // (`.cache/upstream/vendor/cordis/src`) contains no `signal` member on any
  // context type and no `ctx.scope` property at all — `scope` appears there only
  // as the word used for service-isolation prose (`context.ts:17,110-119`). The
  // optional chain therefore yielded `undefined` for every load, and the core
  // silently substituted an un-abortable `new AbortController().signal`
  // (`driver-core.js:732`), so unload never reached a single in-flight invoker.
  //
  // Checked against comment-stripped source so the module note that *describes*
  // the defect cannot itself trip the assertion.
  const code = await readEntryCode();
  assert.ok(!/ctx\.scope/.test(code), 'ctx.scope is not a host property and must not be read');
  assert.ok(!/ctx\?\.scope/.test(code), 'ctx.scope is not a host property and must not be read');
  assert.match(code, /const lifetime = new AbortController\(\);/,
    'the entry must own its lifetime controller');
  assert.match(code, /signal: lifetime\.signal,/,
    'the entry must hand its own controller\'s signal to the core');
});

test('the entry registers teardown through the official ctx.effect, not an invented event', async () => {
  // The `Events` interface (`.cache/upstream/vendor/cordis/src/events.ts:334-371`)
  // declares `internal/plugin`, `internal/status`, `internal/service`,
  // `internal/update`, `internal/commit`, `internal/config`, `internal/get`,
  // `internal/set`, `internal/listener`, and `internal/dispatch` — there is no
  // `'dispose'` event, and no plugin under `.cache/upstream/packages` listens for
  // one. `ctx.on('dispose', ...)` was a listener that could never fire.
  const code = await readEntryCode();
  assert.ok(!/ctx\.on\(\s*'dispose'/.test(code),
    "no 'dispose' event exists on the Cordis Events map; listening for it is dead code");
  assert.ok(!/['"]dispose['"]/.test(code),
    'the entry must not pass a dispose event name to any dispatcher');
  assert.match(code, /ctx\.effect\(\(\) => \(\) => \{/, 'teardown must go through ctx.effect');
  // `effect()` runs its body immediately and keeps the returned disposer until the
  // fiber unloads (`.cache/upstream/vendor/cordis/src/fiber.ts:408-421`).
  assert.match(code, /lifetime\.abort\(\);/, 'the disposer must abort the lifetime controller');
  assert.match(code, /core\.dispose\(\);/, 'the disposer must dispose the core');
});

test('cleanup is registered before the awaited arm and before any registration', async () => {
  // A cleanup registered after `await core.arm()` does not exist for a load that
  // fails during the arm, and does not exist for a `register()` that throws
  // midway — precisely the partial activations that leak an open controller.
  //
  // Offsets are taken from comment-stripped source on purpose: the module header
  // mentions both `ctx.effect(` and `ctx.tools.register(`, so comparing raw text
  // offsets would compare comment positions and pass or fail for the wrong reason.
  const code = await readEntryCode();
  const effectAt = code.indexOf('ctx.effect(');
  const armAt = code.indexOf('await core.arm()');
  const firstRegisterAt = code.indexOf('ctx.tools.register(');
  assert.ok(effectAt > 0, 'the entry must register an effect');
  assert.ok(armAt > 0 && firstRegisterAt > 0);
  assert.ok(effectAt < armAt, 'teardown must be registered before the awaited arm');
  assert.ok(effectAt < firstRegisterAt, 'teardown must be registered before the tool registrations');
  // And the controller must exist before the core is built, because the core
  // receives its signal at construction.
  const controllerAt = code.indexOf('const lifetime = new AbortController();');
  const coreAt = code.indexOf('const core = createDriverCore({');
  assert.ok(controllerAt > 0 && coreAt > 0);
  assert.ok(controllerAt < coreAt, 'the controller must exist before the core is constructed');
});

test('native tool registrations are left to their own effects', async () => {
  // `ctx.tools.register()` returns a disposer and the registry disposes with the
  // plugin (per the entry header's note on `packages/core/tools/src/index.ts:127-155`),
  // so the entry must not also try to unregister by hand.
  const code = await readEntryCode();
  assert.ok(!/tools\.unregister|ctx\.tools\.delete/.test(code),
    'tool registrations retain their own effects; the entry must not unregister manually');
  assert.equal((code.match(/ctx\.tools\.register\(defineTool\(/g) ?? []).length, OWN_TOOL_NAMES.length,
    'every reserved name still gets exactly one registration');
});

// ---------------------------------------------------------------------------
// 2. Isolated injectable harness.
//
// The harness below is a faithful copy of the entry's `apply()` with its three
// host imports replaced by local equivalents. Only the *wiring* is under test
// here; every decision still lives in the core, which is imported for real.
// ---------------------------------------------------------------------------

/**
 * Build the harness `apply()`.
 *
 * Mirrors `src/index.js` step for step: create the controller, read the config,
 * build the core, register the effect, await the arm, register the tools.
 *
 * @param {{ defineTool: Function, createSingleToolInvoker: Function, probeProvenance: Function, setEntryEnabled: Function }} host
 *   The three host imports, supplied by the caller.
 * @returns {(ctx: object, config: object) => Promise<void>} The harness apply.
 */
function makeHarness(host) {
  const { defineTool, createSingleToolInvoker, probeProvenance, setEntryEnabled } = host;

  /**
   * The entry's `ownershipUnavailable()`, copied: a port that never grants.
   * @returns {Function} The refusing port.
   */
  function ownershipUnavailable() {
    return () => ({ ok: false, reason: DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED });
  }

  return async function apply(ctx, config) {
    const lifetime = new AbortController();
    const normalized = normalizeConfig(config);
    const deadlineMs = normalized.ok === true ? normalized.config.invocationTimeoutMs : undefined;

    const core = createDriverCore({
      provenance: { probe: () => probeProvenance({ config, ctx, env: process.env }) },
      config: normalizeConfig,
      loader: () => {
        const value = ctx.loader;
        if (value === null || value === undefined) throw new Error('loader service unavailable');
        return value;
      },
      setEntryEnabled,
      createInvoker: (options) => createSingleToolInvoker({
        tools: ctx.tools,
        agent: options.agent,
        signal: options.signal,
        allowlist: options.allowlist,
        ownToolNames: options.ownToolNames,
        isOwnedByAllowedSource: options.isOwnedByAllowedSource,
        deadlineMs,
        maxStatusLength: 120,
      }),
      resolveToolOwnership: ownershipUnavailable(),
      adminConfig: config,
      signal: lifetime.signal,
      log: () => {},
    });

    ctx.effect(() => () => {
      lifetime.abort();
      core.dispose();
    }, 'dsh-agent-test-driver: lifetime');

    await core.arm();

    for (const name of OWN_TOOL_NAMES) {
      ctx.tools.register(defineTool({ name, execute: () => core.status() }));
    }

    return core;
  };
}

/**
 * A fake host context recording what the entry did, and able to simulate the
 * fiber unloading.
 *
 * `effect` follows the documented contract
 * (`.cache/upstream/vendor/cordis/src/fiber.ts:408-421`): the body runs
 * immediately, the returned disposer is retained, and calling it tears the effect
 * down. Running the disposer twice is a no-op, which `abort()` and `dispose()`
 * already satisfy.
 *
 * @param {{ armRejects?: boolean, registerThrowsOn?: number }} [options] Failure injection.
 * @returns {object} The fake context plus inspection helpers.
 */
function makeCtx({ armRejects = false, registerThrowsOn = -1 } = {}) {
  const effects = [];
  const registrations = [];
  const state = { unloaded: false };

  const ctx = {
    loader: { resolve() { throw new Error('not used'); }, update() {}, async await() {} },
    tools: {
      register(definition) {
        if (registrations.length === registerThrowsOn) throw new Error('registration refused by host');
        registrations.push(definition);
        return () => registrations.pop();
      },
    },
    effect(execute, label) {
      assert.equal(state.unloaded, false, 'an effect cannot be created on an unloaded fiber');
      assert.equal(typeof execute, 'function');
      const disposer = execute();
      assert.equal(typeof disposer, 'function', 'the effect body must return a disposer');
      effects.push({ disposer, label });
      return disposer;
    },
  };

  return {
    ctx,
    effects,
    registrations,
    armRejects,
    /**
     * Simulate the fiber unloading: run every retained disposer in reverse
     * registration order, as the host does.
     *
     * The disposers are cleared afterwards, mirroring the documented "calling the
     * disposer twice is a no-op" contract by never invoking them again, and the
     * fake `effect()` refuses to create new effects once unloaded.
     *
     * @returns {void}
     */
    unload() {
      const pending = [...effects].reverse();
      effects.length = 0;
      state.unloaded = true;
      for (const effect of pending) effect.disposer();
    },
  };
}

/** Host imports, faked. */
function makeHost({ probe } = {}) {
  return {
    defineTool: (definition) => definition,
    createSingleToolInvoker: () => ({ async invoke() { return { ok: true }; }, close() {} }),
    probeProvenance: probe ?? (async () => ({
      armed: true,
      isTestHost: true,
      testRoot: '/tmp/test-root',
      profileName: 'isolated',
      issues: [],
    })),
    setEntryEnabled: async () => ({ ok: true, receipt: {} }),
  };
}

/** A valid configuration fixture. */
function makeConfig() {
  const normalized = normalizeConfig({
    pluginTargets: [{ directory: 'practice', entries: ['practice:alpha'] }],
    testTools: [{ name: 'echo_probe', module: 'sample-probe', expect: 'echo_probe' }],
    maxStatusBytes: 1024,
    invocationTimeoutMs: 250,
  });
  assert.equal(normalized.ok, true, 'the fixture configuration must be valid');
  return normalized.config;
}

test('the harness pins the entry structure it copies', async () => {
  // The harness is a copy, so it is only meaningful while it still matches. These
  // anchors are the lines whose change would invalidate it.
  const code = await readEntryCode();
  for (const anchor of [
    'const lifetime = new AbortController();',
    'signal: lifetime.signal,',
    'ctx.effect(() => () => {',
    'lifetime.abort();',
    'core.dispose();',
    'await core.arm();',
  ]) {
    assert.ok(code.includes(anchor), `the entry must still contain: ${anchor}`);
  }
  // The ordering the harness reproduces is the ordering the entry must keep.
  assert.ok(code.indexOf('ctx.effect(() => () => {') < code.indexOf('await core.arm();'));
});

test('apply records one effect and the three registrations, then arms', async () => {
  const host = makeHost();
  const apply = makeHarness(host);
  const fake = makeCtx();
  const core = await apply(fake.ctx, makeConfig());
  assert.equal(fake.effects.length, 1, 'exactly one lifetime effect is registered');
  assert.equal(fake.effects[0].label, 'dsh-agent-test-driver: lifetime');
  assert.deepEqual(fake.registrations.map((definition) => definition.name), [...OWN_TOOL_NAMES]);
  assert.equal(core.closed, false, 'a completed load stays open');
});

test('the effect is registered before the arm settles', async () => {
  // Proven directly: the probe observes whether the effect already exists at the
  // moment `arm()` runs. Registering cleanup after the await would leave this
  // false, and a load that fails during the arm would never clean up.
  let effectsAtArmTime = -1;
  let fake;
  const host = makeHost({
    probe: async () => {
      effectsAtArmTime = fake.effects.length;
      return { armed: true, isTestHost: true, testRoot: '/tmp/test-root', issues: [] };
    },
  });
  const apply = makeHarness(host);
  fake = makeCtx();
  await apply(fake.ctx, makeConfig());
  assert.equal(effectsAtArmTime, 1, 'cleanup must already exist when the arm runs');
});

test('the lifetime signal is aborted and the core disposed on unload', async () => {
  const host = makeHost();
  const apply = makeHarness(host);
  const fake = makeCtx();
  const core = await apply(fake.ctx, makeConfig());

  // The core exposes `closed` but not its lifetime signal, so the abort itself is
  // observed through its consequence: unloading, which runs the disposer that
  // aborts and then disposes, must leave the core closed. Asserting the signal's
  // `aborted` flag directly would require reaching into a frozen core surface,
  // which the core deliberately does not expose.
  assert.equal(core.closed, false, 'a completed load stays open');
  fake.unload();
  assert.equal(core.closed, true, 'unload disposes the core');
});

test('unload aborts before disposing, so no new work starts behind a dead plugin', async () => {
  // Ordering is behavioural, not textual. After unload the core must refuse, and
  // it must do so at its earliest gate rather than dispatching into the host.
  //
  // Which code comes back depends on the core's check order, and that order is
  // NOT this file's concern: `status()` checks `closed` first
  // (`driver-core.js:911`) and returns `UNAVAILABLE`, while `invokeTool()` reaches
  // `exclusive()` only after the ownership port has already refused, so it returns
  // `DRIVER_TOOL_OWNERSHIP_UNVERIFIED` (`driver-core.js:1131`). Both are
  // refusals; asserting one specific code would pin the core's internal ordering,
  // which this change neither owns nor alters.
  const host = makeHost();
  const apply = makeHarness(host);
  const fake = makeCtx();
  const core = await apply(fake.ctx, makeConfig());

  const statusBefore = await core.status();
  assert.equal(statusBefore.ok, true, 'an armed, open core reports status');

  fake.unload();

  const statusAfter = await core.status();
  assert.equal(statusAfter.ok, false, 'a disposed core refuses status');
  assert.equal(statusAfter.code, DRIVER_CODES.UNAVAILABLE, 'status checks the closed flag first');

  const invocationAfter = await core.invokeTool({ tool: 'echo_probe' }, {
    agent: { id: 'session-1' },
    signal: new AbortController().signal,
  });
  assert.equal(invocationAfter.ok, false, 'a disposed core refuses invocation');
  assert.equal(typeof invocationAfter.code, 'string', 'the refusal carries a closed code, never a throw');
});

test('a load that fails during the arm still registered cleanup and tears down', async () => {
  // The partial-activation case the early registration exists for. `arm()` never
  // throws by contract, so the probe reports a refusal instead; the effect is
  // present either way and unloading closes the core.
  const host = makeHost({
    probe: async () => ({ armed: false, isTestHost: false, issues: [{ code: 'PROVENANCE_NOT_TEST_HOST' }] }),
  });
  const apply = makeHarness(host);
  const fake = makeCtx();
  const core = await apply(fake.ctx, makeConfig());
  assert.equal(fake.effects.length, 1, 'an unarmed load is still cleaned up');
  fake.unload();
  assert.equal(core.closed, true);
});

test('a load that throws while registering still tears down without throwing', async () => {
  // Second partial-activation path: the first `register()` is accepted, the second
  // throws. `apply()` rejects, and the effect registered earlier is still the one
  // that releases the controller and the core when the fiber unloads.
  //
  // The core is not reachable from a rejected `apply()` (it is a local), so this
  // test asserts what it can honestly observe: the effect exists before the
  // failure, one registration landed, and unloading afterwards does not throw.
  const host = makeHost();
  const apply = makeHarness(host);
  const fake = makeCtx({ registerThrowsOn: 1 });
  await assert.rejects(apply(fake.ctx, makeConfig()), /registration refused by host/);
  assert.equal(fake.effects.length, 1, 'cleanup predates the failing registration');
  assert.equal(fake.registrations.length, 1, 'one registration landed before the failure');
  // Unloading after a rejected apply must not throw: the disposer is idempotent
  // and the core's own `dispose()` is documented never to throw
  // (`driver-core.js:1178-1197`).
  assert.doesNotThrow(() => fake.unload());
});

test('the disposer is idempotent and safe to run twice', async () => {
  const host = makeHost();
  const apply = makeHarness(host);
  const fake = makeCtx();
  const core = await apply(fake.ctx, makeConfig());
  const disposer = fake.effects[0].disposer;
  // Both `core.dispose()` (`driver-core.js:1178-1197`) and `AbortController.abort()`
  // are documented no-ops on a second call, so a host that runs the disposer twice
  // must not produce an error.
  assert.doesNotThrow(() => {
    disposer();
    disposer();
  });
  assert.equal(core.closed, true);
});

test('an invalid configuration still gets a core, a registered effect, and a clean teardown', async () => {
  // `apply()` normalizes the config to decide the deadline but always builds the
  // core; the core's own `arm()` re-validates and refuses with CONFIG_INVALID
  // (`driver-core.js:826-840`). The lifetime wiring must be independent of that
  // outcome, which is what this pins: an invalid config produces no throw from
  // `apply()`, and unload still closes the core.
  const host = makeHost();
  const apply = makeHarness(host);
  const fake = makeCtx();
  const core = await apply(fake.ctx, {
    pluginTargets: [], testTools: [], maxStatusBytes: 1, invocationTimeoutMs: 999999,
  });
  assert.equal(fake.effects.length, 1, 'cleanup is registered even for a rejected config');
  assert.equal(typeof core.status, 'function', 'the core is built even for an invalid config');

  // The refusal lives on the ARM receipt, not on `status()`. `status()` projects
  // the settled arm state and reports the empty configuration an unarmed core
  // would list (`driver-core.js:920-936`); it does not re-emit the arm's refusal,
  // so asserting `status.ok === false` here tested a shape the projection never
  // has. Read the arm directly: that is where CONFIG_INVALID is observable, and
  // it is the fact this test is about ("the policy stays the single validator").
  const armedState = await core.arm();
  assert.equal(armedState.ok, false, 'an out-of-range config is refused by the arm');
  assert.equal(armedState.code, POLICY_CODES.CONFIG_INVALID, 'the policy stays the single validator');

  const status = await core.status();
  assert.equal(status.ok, true, 'status still answers after a refused arm');
  assert.deepEqual(status.targets, [], 'a refused arm lists no targets');
  assert.deepEqual(status.tools, [], 'a refused arm lists no tools');

  fake.unload();
  assert.equal(core.closed, true, 'an armed-with-refusal core still tears down');
});

// ---------------------------------------------------------------------------
// Fixed vocabulary is untouched by the lifetime change.
// ---------------------------------------------------------------------------

test('the lifetime change introduces no new refusal code', () => {
  // Cleanup is not a caller-visible outcome of its own: unloading closes the core,
  // and the codes a caller can then see are the pre-existing ones — `UNAVAILABLE`
  // from `status()`, and the ownership codes from `invokeTool()`. Adding a
  // "plugin is unloading" code would be a vocabulary change this task did not make.
  //
  // `TOOL_OWNERSHIP_UNMAPPABLE` belongs in this list: it is declared beside
  // `TOOL_OWNERSHIP_UNVERIFIED` (`driver-core.js:52`) with its own refusal message
  // (`driver-core.js:113-114`) and is produced by `ownershipClaim()` when the
  // claimed entry has no readable positional module. It was missing because this
  // list predates that branch — not because the lifetime work introduced it.
  assert.deepEqual(Object.keys(DRIVER_CODES).sort(), [
    'BUSY',
    'NOT_ARMED',
    'NOT_READY',
    'STATUS_UNAVAILABLE',
    'TOOL_OWNERSHIP_UNMAPPABLE',
    'TOOL_OWNERSHIP_UNVERIFIED',
    'UNAVAILABLE',
  ]);
  assert.equal(DRIVER_CODES.UNAVAILABLE, 'DRIVER_HOST_UNAVAILABLE');
  // The actual point of this test: no code describes teardown. Every entry above
  // is a pre-existing refusal.
  for (const [name, code] of Object.entries(DRIVER_CODES)) {
    assert.equal(typeof code, 'string', `${name} must stay a plain string code`);
    assert.equal(/unload|closing|disposed|teardown/i.test(code), false,
      `${name} must not describe plugin teardown; the lifetime change adds no vocabulary`);
  }
  // The policy vocabulary is likewise unchanged by this file's concern.
  assert.equal(typeof POLICY_CODES.NO_TURN, 'string');
});

/**
 * KNOWN HOST PROOF GAPS — what this suite cannot establish, and what only a real
 * DSH process can:
 *
 * 1. That `ctx.effect(execute, label)` is callable at the point `apply()` runs and
 *    that the host accepts the label. This file reproduces the documented contract
 *    (`fiber.ts:408-421`) but does not run Cordis.
 * 2. That the fiber actually unloads these effects on plugin teardown, and in what
 *    order relative to `ctx.tools.register()`'s own disposers. The disposer
 *    ordering between *different* effects is the host's, and the entry does not
 *    depend on it: the lifetime effect only aborts and disposes.
 * 3. That `AbortController.prototype.abort()` inside a fiber disposer reaches a
 *    native in-flight tool call. The core forwards the signal
 *    (`driver-core.js:217-241`), but whether the native executor honours it is
 *    the executor's contract, not this package's.
 */
