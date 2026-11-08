import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FIXTURE_CODES, createFixtureBinding } from '../src/internal/fixture-binding.js';

// The fake below is an explicit MOCK of `ctx.tools.executable(name, scope, toolSet)`.
// It reproduces ONLY the lookup contract this module depends on:
//   - `index.ts:251-254`: with a toolSet the set decides; without one, a
//     registration carrying `when` is unavailable and the visible view decides.
// It enforces NO policy and NO ownership. Every denial asserted here is produced
// by the binding before any executor would be reached; no test demonstrates that
// the real host would deny anything, and none claims atomicity or isolation from
// a malicious same-process plugin.

const GLOBAL = Object.freeze({ id: 'global-scope' });
const AGENT = Object.freeze({ id: 'agent-a' });
const OTHER_AGENT = Object.freeze({ id: 'agent-b' });

/** Definition stand-in shaped like `ToolDefinition` for the fields read here. */
function definition(name, marker = 'x') {
  return Object.freeze({ name, description: marker, execute: () => marker });
}

/**
 * Fake native lookup table.
 * @param {Array<{ name: string, scope?: object, definition: object, when?: unknown }>} registrations
 */
function fakeTools(registrations = []) {
  /** Visible view: scoped registrations shadow globals within the key. */
  function view(scope) {
    const found = new Map();
    for (const reg of registrations) {
      if (reg.scope === undefined) found.set(reg.name, reg);
    }
    for (const reg of registrations) {
      if (reg.scope !== undefined && reg.scope === scope) found.set(reg.name, reg);
    }
    const visible = new Map();
    for (const [name, reg] of found) visible.set(name, reg.definition);
    return { registrations: found, visible };
  }
  const calls = [];
  return {
    calls,
    register(reg) {
      registrations.push(reg);
    },
    /** Mirrors `executable`: admission set wins; else conditional is unavailable. */
    executable(name, scope, toolSet) {
      calls.push({ name, scope, toolSet });
      if (toolSet !== undefined) return toolSet.get(name);
      const v = view(scope);
      return v.registrations.get(name)?.when === undefined ? v.visible.get(name) : undefined;
    },
  };
}

/** A published fixture triple; `definition` stays the exact object identity. */
function fixture(entryId = 'entry-1', module = 'fixture-module', name = 'fixture_tool') {
  const def = definition(name);
  return { entryId, module, definition: def };
}

test('publish pins the exact definition and verify passes for the matching agent', () => {
  const def = definition('fixture_tool');
  const tools = fakeTools([{ name: 'fixture_tool', definition: def }]);
  const binding = createFixtureBinding({ tools });
  const handle = binding.publish({ entryId: 'e1', module: 'm1', definition: def });

  assert.equal(handle.generation, 1);
  assert.equal(typeof handle.revoke, 'function');

  const verdict = binding.verify({ generation: handle.generation, entryId: 'e1', module: 'm1', name: 'fixture_tool', agent: AGENT });
  assert.deepEqual({ ...verdict }, { ok: true, code: FIXTURE_CODES.OK, reason: 'exact identity', generation: 1 });
  assert.equal(tools.calls.at(-1).scope, AGENT);
});

test('revoked generation is invalid, and revoke is idempotent', () => {
  const def = definition('fixture_tool');
  const binding = createFixtureBinding({ tools: fakeTools([{ name: 'fixture_tool', definition: def }]) });
  const handle = binding.publish({ entryId: 'e1', module: 'm1', definition: def });
  handle.revoke();
  handle.revoke();

  const verdict = binding.verify({ generation: handle.generation, entryId: 'e1', module: 'm1', name: 'fixture_tool', agent: AGENT });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, FIXTURE_CODES.UNKNOWN_GENERATION);
});

test('republishing replaces the generation even for the same objects', () => {
  const def = definition('fixture_tool');
  const binding = createFixtureBinding({ tools: fakeTools([{ name: 'fixture_tool', definition: def }]) });
  const first = binding.publish({ entryId: 'e1', module: 'm1', definition: def });
  const second = binding.publish({ entryId: 'e1', module: 'm1', definition: def });

  assert.equal(second.generation, 2);
  const stale = binding.verify({ generation: first.generation, entryId: 'e1', module: 'm1', name: 'fixture_tool', agent: AGENT });
  assert.equal(stale.code, FIXTURE_CODES.UNKNOWN_GENERATION);
  const live = binding.verify({ generation: second.generation, entryId: 'e1', module: 'm1', name: 'fixture_tool', agent: AGENT });
  assert.equal(live.ok, true);

  // Revoking the retired handle must not retire the live generation.
  first.revoke();
  assert.equal(binding.verify({ generation: second.generation, entryId: 'e1', module: 'm1', name: 'fixture_tool', agent: AGENT }).ok, true);
});

test('a name-only lookup fails when the agent resolves a different definition object', () => {
  // Same name, different object: exactly the shadowing a name comparison misses.
  const mine = definition('fixture_tool', 'mine');
  const impostor = definition('fixture_tool', 'impostor');
  const tools = fakeTools([
    { name: 'fixture_tool', definition: mine },
    { name: 'fixture_tool', definition: impostor, scope: AGENT },
  ]);
  const binding = createFixtureBinding({ tools });
  const handle = binding.publish({ entryId: 'e1', module: 'm1', definition: mine });

  const shadowed = binding.verify({ generation: handle.generation, entryId: 'e1', module: 'm1', name: 'fixture_tool', agent: AGENT });
  assert.equal(shadowed.ok, false);
  assert.equal(shadowed.code, FIXTURE_CODES.IDENTITY_MISMATCH);

  // The published definition is still reachable from a scope without the shadow.
  const clean = binding.verify({ generation: handle.generation, entryId: 'e1', module: 'm1', name: 'fixture_tool', agent: OTHER_AGENT });
  assert.equal(clean.ok, true);
});

test('a different entryId or module is refused before the lookup runs', () => {
  const def = definition('fixture_tool');
  const tools = fakeTools([{ name: 'fixture_tool', definition: def }]);
  const binding = createFixtureBinding({ tools });
  const handle = binding.publish({ entryId: 'e1', module: 'm1', definition: def });
  const base = { generation: handle.generation, entryId: 'e1', module: 'm1', name: 'fixture_tool', agent: AGENT };
  const before = tools.calls.length;

  assert.equal(binding.verify({ ...base, entryId: 'e2' }).code, FIXTURE_CODES.ENTRY_MISMATCH);
  assert.equal(binding.verify({ ...base, module: 'm2' }).code, FIXTURE_CODES.MODULE_MISMATCH);
  assert.equal(tools.calls.length, before, 'mismatched module/entry must not reach the host lookup');
});

test('a missing or disabled public tools.executable is refused at construction', () => {
  assert.throws(() => createFixtureBinding(), TypeError);
  assert.throws(() => createFixtureBinding({}), TypeError);
  assert.throws(() => createFixtureBinding({ tools: {} }), TypeError);
  assert.throws(() => createFixtureBinding({ tools: { executable: 'nope' } }), TypeError);
  // A private registry surface is not a substitute and is never accepted.
  assert.throws(() => createFixtureBinding({ tools: { get: () => undefined, view: () => undefined } }), TypeError);
});

test('a step admission set decides admission; a conditional registration is unavailable without one', () => {
  const def = definition('fixture_tool');
  const tools = fakeTools([{ name: 'fixture_tool', definition: def, when: { condition: () => true } }]);
  const binding = createFixtureBinding({ tools });
  const handle = binding.publish({ entryId: 'e1', module: 'm1', definition: def });
  const request = { generation: handle.generation, entryId: 'e1', module: 'm1', name: 'fixture_tool', agent: AGENT };

  // Outside a model step a `when`-guarded registration is not executable.
  assert.equal(binding.verify(request).code, FIXTURE_CODES.IDENTITY_MISMATCH);
  // Admitted by the step's set: identity matches again.
  assert.equal(binding.verify({ ...request, toolSet: new Map([['fixture_tool', def]]) }).ok, true);
  // Admitted set containing a different object is still a mismatch.
  const swapped = binding.verify({ ...request, toolSet: new Map([['fixture_tool', definition('fixture_tool', 'other')]]) });
  assert.equal(swapped.code, FIXTURE_CODES.IDENTITY_MISMATCH);
  assert.equal(tools.calls.at(-1).toolSet instanceof Map, true);
});

test('unrelated and transport names, absent agents, and a closed binding are refused', () => {
  const def = definition('fixture_tool');
  const tools = fakeTools([{ name: 'fixture_tool', definition: def }]);
  const binding = createFixtureBinding({ tools });
  const handle = binding.publish({ entryId: 'e1', module: 'm1', definition: def });
  const base = { generation: handle.generation, entryId: 'e1', module: 'm1', name: 'fixture_tool', agent: AGENT };

  assert.equal(binding.verify({ ...base, name: 'other_tool' }).code, FIXTURE_CODES.IDENTITY_MISMATCH);
  assert.equal(binding.verify({ ...base, name: 'run_code' }).code, FIXTURE_CODES.IDENTITY_MISMATCH);
  assert.equal(binding.verify({ ...base, agent: null }).code, FIXTURE_CODES.IDENTITY_MISMATCH);
  assert.equal(binding.verify({ ...base, generation: 99 }).code, FIXTURE_CODES.UNKNOWN_GENERATION);

  assert.throws(() => binding.publish({ entryId: 'e2', module: 'm2', definition: definition('run_code') }), TypeError);
  assert.throws(() => binding.publish({ entryId: '', module: 'm2', definition: def }), TypeError);

  binding.close();
  assert.throws(() => binding.publish({ entryId: 'e2', module: 'm2', definition: def }), TypeError);
  assert.equal(binding.verify(base).code, FIXTURE_CODES.UNKNOWN_GENERATION);
});
