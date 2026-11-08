import assert from 'node:assert/strict';
import { test } from 'node:test';

import { POLICY_CODES } from '../src/policy.js';
import {
  ENTRY_PHASES,
  FIBER_STATE,
  MutationQueue,
  checkEntryModule,
  checkEntryOwnership,
  entryPhase,
  phaseIsSettled,
  resolveEntry,
  setEntryEnabled,
} from '../src/internal/loader-ops.js';

test('queue runs work and refuses overlap before any timeout', async () => {
  const queue = new MutationQueue();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const first = queue.run({ entryId: 'a', timeoutMs: 1000 }, async () => {
    calls++;
    await gate;
    return 'settled';
  });
  const second = await queue.run({ entryId: 'b', timeoutMs: 1000 }, async () => { calls++; });
  assert.equal(second.code, 'DRIVER_ENTRY_BUSY');
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'settled');
  assert.equal(queue.pending, 0);
});

test('queue releases the slot after a synchronous work exception', async () => {
  const queue = new MutationQueue();
  await assert.rejects(queue.run({ entryId: 'a', timeoutMs: 1000 }, () => {
    throw new Error('work failed');
  }), /work failed/);
  assert.equal(queue.pending, 0);
  assert.equal(await queue.run({ entryId: 'b', timeoutMs: 1000 }, () => 'next'), 'next');
});

// Every lifecycle fact below mirrors `.cache/upstream/vendor`:
// - `cordis/src/fiber.ts:147` declares `const enum FiberState { PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING }`.
// - `loader/src/config/tree.ts:43-50` `await()` waits `getTasks()` with `Promise.allSettled` until empty.
// - `loader/src/config/tree.ts:62-73` `resolve()` THROWS for an unknown or nested-missing id.
// - `loader/src/config/tree.ts:98-110` `update()` awaits `entry.update(options, false, true)`.
// - `loader/src/config/entry.ts:139-141` awaits `fiber.dispose()`; `entry.ts:158` awaits `init()`.
// - `loader/src/config/tree.ts:52-59` ids are arbitrary; generated ones are 8 hex characters.
// - `loader/src/config/entry.ts:67-73` `Entry.id` is the PUBLIC id: `options.id` for a
//   root entry, `<owning entry id>:<options.id>` for a nested one. `options.id` stays
//   node-local, so a configured `include:generated-kit-plugin` has
//   `options.id === 'generated-kit-plugin'`.

/**
 * A stub entry shaped like `loader/src/config/entry.ts`: node-local `options`,
 * a public `id` getter (`entry.ts:67-73`) and `fiber`.
 *
 * `parent` is the owning entry's full id, so `stubEntry({ id: 'leaf', parent:
 * 'include' })` reports `id === 'include:leaf'` while `options.id === 'leaf'` —
 * exactly the shape that must be verified by full id, not by leaf.
 */
function stubEntry({
  id = 'demo',
  parent = null,
  name = './plugins/demo/index.js',
  disabled = false,
  group = false,
  state = FIBER_STATE.ACTIVE,
  fiber = true,
} = {}) {
  const options = group ? { id, name, disabled, group } : { id, name, disabled };
  const entry = {
    options,
    fiber: fiber ? { state } : undefined,
  };
  Object.defineProperty(entry, 'id', {
    configurable: true,
    enumerable: true,
    get() {
      return parent ? `${parent}:${options.id}` : options.id;
    },
  });
  return entry;
}

/**
 * Loader stub mirroring `tree.ts`: the tree is keyed by the PUBLIC id, and
 * `resolve()` throws unless every `:`-separated ancestor segment is an entry of
 * this tree. `update()` delegates to the entry's options, `await()` resolves
 * immediately unless a test supplies its own gate.
 */
function stubLoader(entries, { update, await: settle } = {}) {
  const byId = new Map();
  for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  const calls = [];
  return {
    calls,
    resolve(id) {
      const parts = String(id).split(':');
      for (let depth = 1; depth < parts.length; depth += 1) {
        if (!byId.has(parts.slice(0, depth).join(':'))) throw new Error(`cannot resolve entry ${id}`);
      }
      const entry = byId.get(id);
      if (!entry) throw new Error(`cannot resolve entry ${id}`);
      return entry;
    },
    entries() {
      return entries[Symbol.iterator]();
    },
    await() {
      return settle ? settle() : Promise.resolve();
    },
    async update(id, options) {
      calls.push({ id, options });
      if (update) return update(id, options, byId.get(id));
      Object.assign(byId.get(id).options, options);
    },
  };
}

/** A promise with its resolver exposed; nothing is scheduled on its own. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush every already-queued microtask without relying on wall-clock time. */
async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function toggler(loader, extra = {}) {
  return setEntryEnabled({
    loader,
    queue: new MutationQueue(),
    target: 'demo-target',
    entryId: 'demo',
    module: './plugins/demo/index.js',
    enabled: false,
    ...extra,
  });
}

test('FiberState values match the host const enum order', () => {
  assert.deepEqual({ ...FIBER_STATE }, {
    PENDING: 0,
    LOADING: 1,
    ACTIVE: 2,
    FAILED: 3,
    DISPOSED: 4,
    UNLOADING: 5,
  });
});

test('ENTRY_PHASES is the closed vocabulary the host can report', () => {
  assert.deepEqual([...ENTRY_PHASES], ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading', 'unknown']);
});

test('entryPhase maps numeric states to names', () => {
  for (const [name, value] of Object.entries(FIBER_STATE)) {
    assert.equal(entryPhase({ fiber: { state: value } }), name.toLowerCase(), `${name}=${value}`);
  }
});

test('entryPhase does not treat the numeric state as a string', () => {
  // The regression this guards: `state` is 0, not `'pending'`.
  assert.equal(entryPhase({ fiber: { state: 0 } }), 'pending');
  assert.equal(entryPhase({ fiber: { state: 2 } }), 'active');
});

test('entryPhase reports an absent or unrecognized state as unknown', () => {
  assert.equal(entryPhase({}), 'unknown');
  assert.equal(entryPhase({ fiber: undefined }), 'unknown');
  assert.equal(entryPhase({ fiber: { state: 'active' } }), 'unknown');
  assert.equal(entryPhase({ fiber: { state: 6 } }), 'unknown');
  assert.equal(entryPhase({ fiber: { state: Number.NaN } }), 'unknown');
  assert.equal(entryPhase(null), 'unknown');
});

test('only stable phases are settled', () => {
  assert.equal(phaseIsSettled('active'), true);
  assert.equal(phaseIsSettled('failed'), true);
  assert.equal(phaseIsSettled('disposed'), true);
  for (const phase of ['pending', 'loading', 'unloading', 'unknown']) {
    assert.equal(phaseIsSettled(phase), false, phase);
  }
});

test('MutationQueue.run bounds the caller but keeps the slot until the work settles', async () => {
  const queue = new MutationQueue();
  const work = deferred();
  const first = queue.run({ entryId: 'demo', timeoutMs: 5 }, async () => {
    await work.promise;
    return 'applied';
  });
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DRIVER_TIMEOUT');
  assert.deepEqual(queue.unsettled, { entryId: 'demo' });

  // The async API returns a Promise, but must never issue the rejected work.
  let issued = false;
  const refusal = await queue.run({ entryId: 'other', timeoutMs: 5 }, async () => { issued = true; });
  assert.equal(issued, false, 'no work was scheduled');
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, 'DRIVER_ENTRY_BUSY');

  work.resolve();
  await flush();
  assert.equal(queue.unsettled, undefined);
  assert.equal(await queue.run({ entryId: 'other', timeoutMs: 5 }, async () => 'next'), 'next');
});

test('MutationQueue keeps a rejection observable and frees the slot', async () => {
  const queue = new MutationQueue();
  await assert.rejects(queue.run({ entryId: 'demo', timeoutMs: 50 }, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(queue.unsettled, undefined);
  assert.equal(queue.pending, 0);
});

test('a timed-out change is not followed by any loader call until it really settles', async () => {
  const gate = deferred();
  const entry = stubEntry({ disabled: false });
  const loader = stubLoader([entry], {
    update() {
      return gate.promise.then(() => {
        entry.options.disabled = true;
        entry.fiber.state = FIBER_STATE.DISPOSED;
      });
    },
    await() {
      return gate.promise;
    },
  });
  const queue = new MutationQueue();
  const first = await setEntryEnabled({
    loader, queue, target: 'demo-target', entryId: 'demo', module: './plugins/demo/index.js', enabled: false, timeoutMs: 1,
  });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'DRIVER_TIMEOUT');
  assert.match(first.message, /its outcome is unknown/);
  assert.equal(loader.calls.length, 1);

  // A second operation is refused without reaching the loader.
  const second = await setEntryEnabled({
    loader, queue, target: 'demo-target', entryId: 'demo', module: './plugins/demo/index.js', enabled: true, timeoutMs: 1,
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'DRIVER_ENTRY_BUSY');
  assert.equal(loader.calls.length, 1, 'the second operation was never issued');

  gate.resolve();
  await flush();
  assert.equal(queue.unsettled, undefined);
  assert.equal(queue.pending, 0, 'the slot is released only by the real settlement');

  // The third operation is admitted only now.
  const third = await setEntryEnabled({
    loader, queue, target: 'demo-target', entryId: 'demo', module: './plugins/demo/index.js', enabled: true, timeoutMs: 50,
  });
  assert.equal(third.ok, false);
  assert.equal(third.code, 'DRIVER_UPDATE_FAILED');
});

test('setEntryEnabled refuses an id the host cannot resolve', async () => {
  const loader = stubLoader([]);
  const result = await toggler(loader);
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.CONFIG_INVALID);
  assert.match(result.message, /no loader entry "demo"/);
  assert.deepEqual(loader.calls, []);
});

test('setEntryEnabled refuses when no intended module is declared', async () => {
  const loader = stubLoader([stubEntry()]);
  const result = await toggler(loader, { module: undefined });
  assert.equal(result.ok, false);
  assert.match(result.message, /no intended module is declared/);
  assert.deepEqual(loader.calls, []);
});

test('setEntryEnabled refuses a non-boolean enabled value before touching the loader', async () => {
  const loader = stubLoader([stubEntry()]);
  for (const enabled of ['true', 1, undefined]) {
    const result = await toggler(loader, { enabled });
    assert.equal(result.ok, false, String(enabled));
    assert.match(result.message, /enabled must be true or false/);
  }
  assert.deepEqual(loader.calls, []);
});

test('a configured id alone does not authorize a different module', async () => {
  const loader = stubLoader([stubEntry({ name: './plugins/other/index.js' })]);
  const result = await toggler(loader);
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.CONFIG_INVALID);
  assert.match(result.message, /loads "\.\/plugins\/other\/index\.js" but the target declares/);
  assert.deepEqual(loader.calls, [], 'ownership refusal must precede any mutation');
});

test('a live entry with no module specifier is insufficient evidence', async () => {
  const entry = stubEntry();
  delete entry.options.name;
  const loader = stubLoader([entry]);
  const result = await toggler(loader);
  assert.equal(result.ok, false);
  assert.match(result.message, /no module specifier/);
  assert.deepEqual(loader.calls, []);
});

test('a live entry with mismatched or missing options is insufficient evidence', async () => {
  const mismatched = stubLoader([]);
  // Public id and leaf both name another entry: the configured id is not this one.
  mismatched.resolve = () => ({ id: 'other', options: { id: 'other', name: './plugins/demo/index.js', disabled: false }, fiber: { state: 2 } });
  const first = await toggler(mismatched);
  assert.equal(first.ok, false);
  assert.match(first.message, /carries id "other"/);

  const empty = stubLoader([]);
  empty.resolve = () => ({ fiber: { state: 2 } });
  const second = await toggler(empty);
  assert.equal(second.ok, false);
  assert.match(second.message, /no readable loader options/);
});

test('setEntryEnabled refuses entries that are still transitioning', async () => {
  for (const state of [FIBER_STATE.PENDING, FIBER_STATE.LOADING, FIBER_STATE.UNLOADING]) {
    const loader = stubLoader([stubEntry({ state })]);
    const result = await toggler(loader);
    assert.equal(result.ok, false, String(state));
    assert.equal(result.code, 'DRIVER_ENTRY_BUSY');
    assert.deepEqual(loader.calls, []);
  }
});

test('an entry with no fiber cannot be enabled', async () => {
  const loader = stubLoader([stubEntry({ fiber: false })]);
  const result = await toggler(loader, { enabled: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DRIVER_ENTRY_BUSY');
  assert.match(result.message, /no fiber yet/);
  assert.deepEqual(loader.calls, []);
});

test('a disabled entry with no fiber is a no-op, not an error', async () => {
  const loader = stubLoader([stubEntry({ fiber: false, disabled: true })]);
  const result = await toggler(loader);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.changed, false);
  assert.equal(result.receipt.after, 'unknown');
  assert.equal(result.receipt.settled, true);
  assert.deepEqual(loader.calls, []);
});

test('a failed entry can still be disabled', async () => {
  const entry = stubEntry({ state: FIBER_STATE.FAILED });
  const loader = stubLoader([entry], {
    update(_id, options, target) {
      Object.assign(target.options, options);
      target.fiber.state = FIBER_STATE.DISPOSED;
    },
  });
  const result = await toggler(loader);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.before, 'failed');
  assert.equal(result.receipt.after, 'disposed');
  assert.equal(result.receipt.changed, true);
  assert.equal(result.receipt.settled, true);
  assert.equal(result.receipt.persisted, 'unknown');
});

test('a failed entry is not reported as successfully enabled', async () => {
  const entry = stubEntry({ disabled: true, state: FIBER_STATE.FAILED });
  const loader = stubLoader([entry]);
  const result = await toggler(loader, { enabled: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DRIVER_UPDATE_FAILED');
  assert.match(result.message, /settled in phase "failed" instead of active/);
});

test('setEntryEnabled maps enable/disable onto the loader disabled key', async () => {
  const disableEntry = stubEntry({ disabled: false });
  const disableLoader = stubLoader([disableEntry], {
    update(_id, options, target) {
      Object.assign(target.options, options);
      target.fiber.state = FIBER_STATE.DISPOSED;
    },
  });
  const disabled = await toggler(disableLoader);
  assert.equal(disabled.ok, true);
  assert.deepEqual(disableLoader.calls, [{ id: 'demo', options: { disabled: true } }]);
  assert.equal(disabled.receipt.after, 'disposed');

  const enableEntry = stubEntry({ disabled: true, state: FIBER_STATE.DISPOSED });
  const enableLoader = stubLoader([enableEntry], {
    update(_id, options, target) {
      Object.assign(target.options, options);
      target.fiber.state = FIBER_STATE.ACTIVE;
    },
  });
  const enabled = await toggler(enableLoader, { enabled: true });
  assert.equal(enabled.ok, true);
  assert.deepEqual(enableLoader.calls, [{ id: 'demo', options: { disabled: false } }]);
  assert.equal(enabled.receipt.after, 'active');
});

test('a no-op toggle does not call update and reports unchanged', async () => {
  const loader = stubLoader([stubEntry({ disabled: true, state: FIBER_STATE.DISPOSED })]);
  const result = await toggler(loader);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.changed, false);
  assert.equal(result.receipt.after, result.receipt.before);
  assert.equal(result.receipt.settled, true);
  assert.deepEqual(loader.calls, []);
});

test('a no-op enable on an entry that is not active is not settled', async () => {
  const loader = stubLoader([stubEntry({ disabled: false, state: FIBER_STATE.FAILED })]);
  const result = await toggler(loader, { enabled: true });
  assert.equal(result.ok, true);
  assert.equal(result.receipt.changed, false);
  assert.equal(result.receipt.settled, false);
  assert.deepEqual(loader.calls, []);
});

test('the receipt is read only after loader.await settles the lifecycle', async () => {
  const entry = stubEntry({ disabled: false });
  const lifecycle = deferred();
  let sawPending = false;
  const loader = stubLoader([entry], {
    async update(_id, options, target) {
      Object.assign(target.options, options);
      target.fiber.state = FIBER_STATE.PENDING;
    },
    await() {
      // `tree.ts:43-50` returns once no lifecycle task remains.
      sawPending = entry.fiber.state === FIBER_STATE.PENDING;
      return lifecycle.promise.then(() => {
        entry.fiber.state = FIBER_STATE.DISPOSED;
      });
    },
  });
  const pending = toggler(loader, { timeoutMs: 1_000 });
  await flush();
  assert.equal(sawPending, true, 'the loader was still mid-lifecycle when await() was called');
  lifecycle.resolve();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.receipt.before, 'active');
  assert.equal(result.receipt.after, 'disposed');
  assert.equal(result.receipt.settled, true);
});

test('setEntryEnabled fails generically when the loader rejects', async () => {
  const loader = stubLoader([stubEntry()], {
    update() {
      throw new Error('EACCES: /home/admin/cordis.yml');
    },
  });
  const log = [];
  const result = await toggler(loader, { log: (line) => log.push(line) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DRIVER_UPDATE_FAILED');
  assert.doesNotMatch(result.message, /EACCES|cordis\.yml/, 'the raw plugin error is not exposed');
  assert.match(log[0], /EACCES/);
});

test('setEntryEnabled refuses an entry replaced during the change', async () => {
  const original = stubEntry({ disabled: false });
  const replacement = stubEntry({ disabled: true, state: FIBER_STATE.DISPOSED });
  let current = original;
  const loader = {
    calls: [],
    resolve() {
      return current;
    },
    async update() {
      this.calls.push('update');
      current = replacement;
    },
    await() {
      return Promise.resolve();
    },
  };
  const result = await toggler(loader);
  assert.equal(result.ok, false);
  assert.match(result.message, /was replaced while it changed/);
});

test('setEntryEnabled rejects an invalid timeout before touching the loader', async () => {
  const loader = stubLoader([stubEntry()]);
  for (const timeoutMs of [0, -1, 1.5]) {
    const result = await toggler(loader, { timeoutMs });
    assert.equal(result.ok, false, String(timeoutMs));
    assert.match(result.message, /timeoutMs must be a positive integer/);
  }
  assert.deepEqual(loader.calls, []);
});

test('setEntryEnabled refuses a non-string entry id before touching the loader', async () => {
  const loader = stubLoader([stubEntry()]);
  const result = await toggler(loader, { entryId: 42 });
  assert.equal(result.ok, false);
  assert.match(result.message, /entryId must be a non-empty id from the allowlist/);
  assert.deepEqual(loader.calls, []);
});

test('setEntryEnabled requires a loader with resolve, update and await', async () => {
  const result = await toggler({ resolve: () => stubEntry(), update: async () => {} });
  assert.equal(result.ok, false);
  assert.match(result.message, /no loader with resolve\/update\/await/);
});

test('resolveEntry reports an unknown id as a refusal, not a success', () => {
  // `tree.ts:62-73` throws for a missing leaf as well.
  const missing = resolveEntry(stubLoader([]), 'ghost');
  assert.equal(missing.ok, false);
  assert.match(missing.message, /has no loader entry "ghost"/);

  const throwing = resolveEntry({ resolve() { throw new Error('cannot resolve entry a:b'); } }, 'a:b');
  assert.equal(throwing.ok, false);
  assert.match(throwing.message, /has no loader entry "a:b"/);
});

test('checkEntryModule accepts the configured id with its declared module', () => {
  assert.equal(checkEntryModule(stubEntry(), { entryId: 'demo', module: './plugins/demo/index.js' }), undefined);
});

test('checkEntryOwnership verifies each configured id against its module', () => {
  const loader = stubLoader([
    stubEntry({ id: 'embedded', name: './plugins/demo/index.js' }),
    stubEntry({ id: 'second', name: './plugins/other/index.js' }),
  ]);
  assert.equal(checkEntryOwnership(loader, {
    directory: 'demo-target',
    entries: ['embedded', 'second'],
    modules: ['./plugins/demo/index.js', './plugins/other/index.js'],
  }), undefined);
});

test('checkEntryOwnership refuses a configured id loading another module', () => {
  const loader = stubLoader([stubEntry({ id: 'embedded', name: './plugins/other/index.js' })]);
  const refusal = checkEntryOwnership(loader, {
    directory: 'demo-target',
    entries: ['embedded'],
    modules: ['./plugins/demo/index.js'],
  });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /loads "\.\/plugins\/other\/index\.js" but the target declares/);
});

test('checkEntryOwnership refuses a configured id the tree does not have', () => {
  const refusal = checkEntryOwnership(stubLoader([]), { directory: 'demo-target', entries: ['ghost'] });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /has no loader entry "ghost"/);
});

// The regression guarded below: a configured entry id is a PUBLIC id.
// `Entry.id` (`entry.ts:67-73`) prefixes the owning entry's id, while
// `options.id` stays node-local, so comparing the configured full id against
// `options.id` refuses every nested target as unowned.

test('a configured nested id is verified by the public entry id', async () => {
  const module = './plugins/generated-kit-plugin/index.js';
  const include = stubEntry({ id: 'include', group: true });
  const leaf = stubEntry({ id: 'generated-kit-plugin', parent: 'include', name: module });
  // The same object is both: node-local leaf id and full public id.
  assert.equal(leaf.options.id, 'generated-kit-plugin');
  assert.equal(leaf.id, 'include:generated-kit-plugin');

  const loader = stubLoader([include, leaf], {
    update(_id, options, target) {
      Object.assign(target.options, options);
      target.fiber.state = FIBER_STATE.DISPOSED;
    },
  });
  const result = await toggler(loader, { entryId: 'include:generated-kit-plugin', module });

  assert.equal(result.ok, true);
  assert.equal(result.receipt.entry, 'include:generated-kit-plugin');
  assert.equal(result.receipt.before, 'active');
  assert.equal(result.receipt.after, 'disposed');
  assert.equal(result.receipt.changed, true);
  assert.equal(result.receipt.settled, true);
  // The mutation addresses the configured full id, as `resolve()`/`update()` expect.
  assert.deepEqual(loader.calls, [{ id: 'include:generated-kit-plugin', options: { disabled: true } }]);
});

test('the same leaf under another parent is not the configured entry', () => {
  const module = './plugins/generated-kit-plugin/index.js';
  const otherParent = stubEntry({ id: 'generated-kit-plugin', parent: 'exclude', name: module });

  const refusal = checkEntryModule(otherParent, { entryId: 'include:generated-kit-plugin', module });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, POLICY_CODES.CONFIG_INVALID);
  assert.match(refusal.message, /carries id "exclude:generated-kit-plugin"/);

  // The bare leaf is not the configured id either: no suffix matching, no
  // separator stripping.
  const nested = stubEntry({ id: 'generated-kit-plugin', parent: 'include', name: module });
  const leafOnly = checkEntryModule(nested, { entryId: 'generated-kit-plugin', module });
  assert.equal(leafOnly.ok, false);
  assert.match(leafOnly.message, /carries id "include:generated-kit-plugin"/);
});

test('an entry resolved for a nested id but owned by another parent is never toggled', async () => {
  const module = './plugins/generated-kit-plugin/index.js';
  const wrongParent = stubEntry({ id: 'generated-kit-plugin', parent: 'exclude', name: module });
  const loader = {
    calls: [],
    resolve() {
      return wrongParent;
    },
    async update() {
      this.calls.push('update');
    },
    await() {
      return Promise.resolve();
    },
  };
  const result = await toggler(loader, { entryId: 'include:generated-kit-plugin', module });
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.CONFIG_INVALID);
  assert.match(result.message, /carries id "exclude:generated-kit-plugin"/);
  assert.deepEqual(loader.calls, [], 'ownership refusal must precede any mutation');
});

test('a live entry with no readable public id is insufficient evidence', async () => {
  const module = './plugins/demo/index.js';
  // A leaf-only shape: readable `options`, but the public id is missing, so the
  // configured id cannot be confirmed. Refused rather than read from the leaf.
  const leafOnly = { options: { id: 'demo', name: module, disabled: false }, fiber: { state: FIBER_STATE.ACTIVE } };
  const missing = checkEntryModule(leafOnly, { entryId: 'demo', module });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, POLICY_CODES.CONFIG_INVALID);
  assert.match(missing.message, /no readable public entry id/);

  for (const publicId of ['', 42, null, undefined, {}, Symbol('demo')]) {
    const malformed = stubEntry();
    Object.defineProperty(malformed, 'id', { configurable: true, enumerable: true, value: publicId });
    const refusal = checkEntryModule(malformed, { entryId: 'demo', module });
    assert.equal(refusal.ok, false, String(publicId));
    assert.match(refusal.message, /no readable public entry id/, String(publicId));
  }

  // `Entry.id` dereferences the owning tree, so a detached entry throws.
  const throwing = stubEntry();
  Object.defineProperty(throwing, 'id', {
    configurable: true,
    get() {
      throw new Error('detached from its tree');
    },
  });
  const detached = checkEntryModule(throwing, { entryId: 'demo', module });
  assert.equal(detached.ok, false);
  assert.match(detached.message, /no readable public entry id/);

  // And the same refusal happens before any loader mutation.
  const loader = { calls: [], resolve: () => leafOnly, update: async () => { loader.calls.push('update'); }, await: async () => {} };
  const result = await toggler(loader);
  assert.equal(result.ok, false);
  assert.match(result.message, /no readable public entry id/);
  assert.deepEqual(loader.calls, []);
});

test('a correctly nested id loading another module is still refused', async () => {
  const include = stubEntry({ id: 'include', group: true });
  const leaf = stubEntry({ id: 'generated-kit-plugin', parent: 'include', name: './plugins/other/index.js' });
  const loader = stubLoader([include, leaf]);
  const result = await toggler(loader, {
    entryId: 'include:generated-kit-plugin',
    module: './plugins/generated-kit-plugin/index.js',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.CONFIG_INVALID);
  assert.match(result.message, /loads "\.\/plugins\/other\/index\.js" but the target declares/);
  assert.deepEqual(loader.calls, [], 'a nested id proves nothing about the module');
});

test('a nested entry replaced during the change is still refused', async () => {
  const module = './plugins/generated-kit-plugin/index.js';
  const original = stubEntry({ id: 'generated-kit-plugin', parent: 'include', name: module, disabled: false });
  const replacement = stubEntry({ id: 'generated-kit-plugin', parent: 'include', name: module, disabled: true, state: FIBER_STATE.DISPOSED });
  let current = original;
  const loader = {
    calls: [],
    resolve() {
      return current;
    },
    async update() {
      this.calls.push('update');
      current = replacement;
    },
    await() {
      return Promise.resolve();
    },
  };
  const result = await toggler(loader, { entryId: 'include:generated-kit-plugin', module });
  assert.equal(result.ok, false);
  assert.match(result.message, /was replaced while it changed/);
  assert.deepEqual(loader.calls, ['update']);
});

test('checkEntryOwnership verifies nested ids by their full public id', () => {
  const module = './plugins/generated-kit-plugin/index.js';
  const loader = stubLoader([
    stubEntry({ id: 'include', group: true }),
    stubEntry({ id: 'generated-kit-plugin', parent: 'include', name: module }),
    stubEntry({ id: 'second', name: './plugins/other/index.js' }),
  ]);
  assert.equal(checkEntryOwnership(loader, {
    directory: 'demo-target',
    entries: ['include:generated-kit-plugin', 'second'],
    modules: [module, './plugins/other/index.js'],
  }), undefined);

  // `tree.ts:62-73`: the full path must resolve, so a leaf that only exists
  // under another parent is not the configured entry.
  const elsewhere = stubLoader([
    stubEntry({ id: 'include', group: true }),
    stubEntry({ id: 'generated-kit-plugin', parent: 'exclude', name: module }),
  ]);
  const refusal = checkEntryOwnership(elsewhere, {
    directory: 'demo-target',
    entries: ['include:generated-kit-plugin'],
    modules: [module],
  });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /has no loader entry "include:generated-kit-plugin"/);
});
