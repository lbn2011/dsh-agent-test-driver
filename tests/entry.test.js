/**
 * Tests for the host entry and the driver core it mounts.
 *
 * Two rules shape this file:
 *
 * 1. **No host package is imported at test load.** `src/index.js` imports
 *    `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`, which are not
 *    installed for this package, so importing the entry here would fail before a
 *    single assertion ran. The entry is therefore verified the way the brief
 *    requires: by reading its module surface statically, and by exercising the
 *    exact behaviour it delegates to in `src/internal/driver-core.js`, which is
 *    dependency-injected and imports only this package's own modules.
 * 2. **Every collaborator is a fake.** The core's ports are plain functions
 *    defined in this file, so a test can make the arm fail, the loader busy, or
 *    an invocation hang without a DSH process.
 *
 * What this file cannot prove is listed under `KNOWN HOST PROOF GAPS` at the end.
 *
 * @module dsh-agent-test-driver/tests/entry
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  DRIVER_CODES,
  buildStatus,
  checkOwnership,
  createDriverCore,
  describeEntry,
  entryIsAllowlisted,
  isRefusal,
  OWN_TOOL_NAMES,
  passthroughQueue,
  STATUS_LIMITS,
} from '../src/internal/driver-core.js';
import { POLICY_CODES, normalizeConfig } from '../src/policy.js';

const ENTRY_PATH = new URL('../src/index.js', import.meta.url);
const CORE_PATH = new URL('../src/internal/driver-core.js', import.meta.url);

/**
 * Read a source file relative to the package root.
 * @param {URL} url Absolute file URL.
 * @returns {Promise<string>} File contents.
 */
function readSource(url) {
  return readFile(url, 'utf8');
}

/**
 * Remove `//` and `/* *\/` comments so a source assertion cannot be satisfied by
 * a commented-out example. String and template literals are skipped so a `//`
 * inside one is not treated as a comment; the entry contains no regex literals,
 * so those need no handling. Mirrors the helper of the same name in
 * `entry-lifetime.test.js`.
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
 * A normalized configuration with one target and one test tool.
 * @param {object} [overrides] Fields to replace.
 * @returns {object} Normalized config.
 */
function makeConfig({ modules, ...overrides } = {}) {
  const normalized = normalizeConfig({
    pluginTargets: [{ directory: 'practice', entries: ['practice:alpha'] }],
    testTools: [{ name: 'echo_probe', module: 'sample-probe', expect: 'echo_probe' }],
    maxStatusBytes: 1024,
    invocationTimeoutMs: 250,
    ...overrides,
  });
  assert.equal(normalized.ok, true, 'the fixture configuration must be valid');
  // `policy.normalizeTarget()` owns the target directory and entry ids and does
  // not carry module specifiers; the entry supplies them positionally. The
  // fixture mirrors that split rather than routing modules through the policy.
  return {
    ...normalized.config,
    pluginTargets: modules === undefined
      ? normalized.config.pluginTargets
      : normalized.config.pluginTargets.map((target) => ({ ...target, modules: [...modules] })),
  };
}

/**
 * A fake loader entry.
 * @param {{ name?: string, state?: number, disabled?: boolean }} [options] Entry fields.
 * @returns {object} Fake entry.
 */
function makeEntry({ name = 'sample-probe', state = 2, disabled = false } = {}) {
  return { options: { name, disabled }, fiber: { state } };
}

/**
 * A fake loader exposing the three methods the driver uses.
 * @param {Record<string, object>} entries Entries by id.
 * @returns {object} Fake loader.
 */
function makeLoader(entries = { 'practice:alpha': makeEntry() }) {
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
    async await() {},
  };
}

/**
 * A provenance probe result for an armed host.
 * @param {object} config Config carried on the probe result.
 * @returns {object} Probe result.
 */
function armedProbe(config) {
  return {
    armed: true,
    isTestHost: true,
    testRoot: '/tmp/test-root',
    profileName: 'isolated',
    issues: [],
    config,
  };
}

/**
 * Build a core with fakes, exposing the recorded calls.
 * @param {object} [overrides] Port overrides.
 * @returns {{ core: object, calls: object }} Core and call recorder.
 */
function makeCore(overrides = {}) {
  const config = overrides.config ?? makeConfig();
  const calls = {
    probes: 0,
    mutations: [],
    invocations: [],
    created: 0,
    closed: 0,
  };
  const loader = overrides.loader ?? makeLoader();
  const core = createDriverCore({
    provenance: {
      probe: async () => {
        calls.probes += 1;
        return armedProbe(config);
      },
    },
    // The core takes the normalizer as a plain function port
    // (`driver-core.js:689,707,719`), the same shape `src/index.js` now passes.
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
      calls.created += 1;
      calls.invokerOptions = options;
      return {
        async invoke(name, args) {
          calls.invocations.push({ name, args });
          return { ok: true, code: 'INVOKE_OK', status: 'executed' };
        },
        close() {
          calls.closed += 1;
        },
      };
    },
    adminConfig: config,
    resolveToolOwnership: () => ({ ok: false, reason: DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED }),
    ...overrides.ports,
  });
  return { core, calls, config, loader };
}

/** A fake native execution context. */
function makeExec() {
  return { agent: { id: 'session-1' }, signal: new AbortController().signal };
}

// ---------------------------------------------------------------------------
// Entry surface: the parts that can be checked without the host packages.
// ---------------------------------------------------------------------------

test('entry declares the official function-plugin exports and no default export', async () => {
  const source = await readSource(ENTRY_PATH);
  for (const declaration of ['export const name', 'export const inject', 'export const Config', 'export async function apply']) {
    assert.ok(source.includes(declaration), `entry must declare: ${declaration}`);
  }
  // A default export makes the Loader skip the named `inject` face
  // (vendor/loader/src/index.ts:196-203), silently dropping the declarations.
  assert.ok(!/export default/.test(source), 'entry must not default-export alongside named plugin exports');
});

test('entry imports schemastery from the official package and builds Config with it', async () => {
  const source = await readSource(ENTRY_PATH);
  assert.match(source, /import z from '@deepseek-ai\/schemastery';/);
  assert.ok(!/from 'schemastery'/.test(source), 'a bare schemastery specifier is not a harness dependency');
  assert.match(source, /export const Config = z\.object\(\{/);
});

test('Config declares the two provenance fields as plain strings, with no default and no required', async () => {
  // Why this is a source assertion: the package has no host dependency
  // installed, so importing `src/index.js` fails before any assertion could run
  // (see `KNOWN HOST PROOF GAPS` below). Reading the declaration is the only
  // in-package way to pin it.
  //
  // Why the assertion is scoped to the Config block: a whole-file match could be
  // satisfied by an identically named declaration anywhere else in the module
  // (a fixture, a helper, a second object). The block is delimited explicitly —
  // `export const Config = z.object({` through the first `\n});` after it — so a
  // match outside it does not count.
  const source = stripComments(await readSource(ENTRY_PATH));
  const start = source.indexOf('export const Config = z.object({');
  assert.notEqual(start, -1, 'the entry must declare Config as a schemastery object literal');
  const end = source.indexOf('\n});', start);
  assert.notEqual(end, -1, 'the Config object literal must be closed');
  const block = source.slice(start, end);

  for (const field of ['testRoot', 'profileMarker']) {
    assert.match(
      block,
      new RegExp(`\\b${field}:\\s*z\\.string\\(\\),`),
      `Config must declare ${field} as a plain z.string()`,
    );
    assert.ok(
      !new RegExp(`\\b${field}:\\s*z\\.string\\(\\)[^,]*\\.default\\(`).test(block),
      `${field} must not carry a default: a default would pick a trust root or marker on the operator's behalf, inside the schema, instead of leaving an unnamed field for the probe to refuse`,
    );
    assert.ok(
      !new RegExp(`\\b${field}:\\s*z\\.string\\(\\)[^,]*\\.required\\(`).test(block),
      `${field} must not be required: an absent value must reach the probe as NOT_CONFIGURED instead of failing the plugin load`,
    );
  }
});

test('entry registers tools through the official defineTool and ctx.tools.register', async () => {
  const source = await readSource(ENTRY_PATH);
  assert.match(source, /import \{ defineTool \} from '@deepseek-ai\/dsh-tools';/);
  const registrations = source.match(/ctx\.tools\.register\(defineTool\(/g) ?? [];
  // The literal 3 is kept here on purpose, and the exact name list is asserted
  // separately below: this line pins the count this test has always asserted,
  // while `entry registers exactly the three reserved names` pins the identities.
  assert.equal(registrations.length, 3, 'the entry registers its three control tools');
  // Test tools are never mounted by the driver: a placeholder under the configured
  // name would be name-equality evidence, which the driver refuses to accept.
  assert.match(source, /Test tools are NOT mounted here/);
  // The ownership note must not overclaim. `ctx.tools.get()` CAN retrieve a
  // definition; what no public API exposes is which plugin registered it. An
  // earlier revision said the definition itself was unobtainable, which is false
  // and would send a reader looking for a workaround that does not exist.
  assert.match(source, /can obtain the \*definition\*/);
  assert.ok(!/no public way to obtain/i.test(source),
    'the entry must not claim the tool definition is unobtainable');
  // The claim that must NOT appear: "the plugin cannot obtain the definition".
  assert.ok(!/cannot obtain the definition/i.test(source));
  // The distinction is the point of the note: definition yes, owner no.
  assert.match(source, /carries no registering\s*\n?\s*\*\s*plugin/, 'the note must state what is actually missing');
  // Every registration declares a renderer: `register()` throws without one
  // (packages/core/tools/src/index.ts:127-155).
  assert.equal((source.match(/render: \(_args, value\) => renderReceipt\(value\)/g) ?? []).length, registrations.length);
});

// ---------------------------------------------------------------------------
// Tool registration: one `ctx.tools.register(defineTool({ name }))` per name in
// OWN_TOOL_NAMES. The core reserves all three names, so a name that is reserved
// and never registered is a hole: the driver refuses calls to a tool the host
// cannot even offer, and the count assertion below catches it. That is exactly
// how a build once shipped with `test_driver_invoke_tool` reserved, advertised,
// and never registered while the suite stayed green on a bare count of 3.
// ---------------------------------------------------------------------------

/**
 * Extract the declared `name:` of every `ctx.tools.register(defineTool({...}))`
 * call, in source order.
 *
 * Written as a brace scan rather than a single regex because the registrations
 * contain nested braces (`output: { ... }`, and `execute` bodies), which a
 * non-greedy pattern would cut short or overrun. `new Function` is not used:
 * the source is host-dependent and must never be evaluated here.
 *
 * @param {string} source Entry module source.
 * @returns {string[]} Registered tool names, one per registration.
 * @throws {AssertionError} When a registration does not declare a literal name.
 */
function registeredToolNames(source) {
  const MARKER = 'ctx.tools.register(defineTool({';
  const names = [];
  let cursor = 0;
  for (;;) {
    const start = source.indexOf(MARKER, cursor);
    if (start === -1) break;
    const open = start + MARKER.length - 1;
    let depth = 0;
    let end = -1;
    for (let index = open; index < source.length; index += 1) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    assert.ok(end > open, 'every defineTool call must close its object literal');
    cursor = end + 1;
    const body = source.slice(open + 1, end);
    const match = /(?:^|[\s{,])(name):\s*'([^']+)'/.exec(body);
    assert.ok(match !== null, 'every defineTool call must declare a literal name');
    names.push(match[2]);
  }
  return names;
}

test('entry registers exactly the three reserved names, each via defineTool', async () => {
  const source = await readSource(ENTRY_PATH);
  const registered = registeredToolNames(source);
  assert.deepEqual(registered, [...OWN_TOOL_NAMES],
    'every name the core reserves must be registered, in the order the core lists them');
  // The count is checked against the reserved list, not a literal, so adding a
  // name to OWN_TOOL_NAMES without registering it fails here instead of shipping.
  assert.equal((source.match(/ctx\.tools\.register\(defineTool\(/g) ?? []).length, OWN_TOOL_NAMES.length);
});

test('the invoke tool is registered and forwards the native exec context to the core', async () => {
  // Regression: `test_driver_invoke_tool` was reserved in OWN_TOOL_NAMES and
  // documented, but no registration existed, so `invokeTool` was unreachable
  // through any host surface. Name-only assertions passed: the string appears in
  // OWN_TOOL_NAMES and in the status test fixture regardless.
  const source = await readSource(ENTRY_PATH);
  assert.ok(registeredToolNames(source).includes('test_driver_invoke_tool'),
    'test_driver_invoke_tool must be registered through ctx.tools.register(defineTool(...))');
  // The core signature is `invokeTool(request, exec)`; `exec` is the native
  // ToolRunContext, whose two load-bearing fields are `agent` and `signal`
  // (`packages/core/tools/src/contracts.ts:174-208,244`). Omitting it silently
  // degrades every call that gets past ownership to `POLICY_CODES.NO_TURN`
  // (`driver-core.js:709-710`), so the binding is asserted literally rather than
  // inferred from the presence of a name.
  assert.match(source, /async execute\(args, exec\) \{\s*return core\.invokeTool\(args, exec\);\s*\}/,
    'the invoke executor must hand the native exec context to core.invokeTool');
  // A registration that does not recycle the shared parameters and renderer
  // would have drifted from the other two; both are named constants.
  assert.match(source, /parameters: INVOKE_PARAMETERS,/);
  assert.match(source, /render: \(_args, value\) => renderReceipt\(value\)/);
});

test('the invoke executor refuses rather than throws when the core is unarmed', async () => {
  // Behavioural half of the same regression: the registration is only useful if
  // the path it binds reports refusal as a receipt. This exercises the exact
  // `core.invokeTool(args, exec)` call the executor makes, against an unarmed
  // host, and checks the receipt survives `renderReceipt` in the entry.
  const { core } = makeCore({
    ports: {
      provenance: {
        probe: async () => ({ armed: false, isTestHost: false, issues: [{ code: 'PROVENANCE_NOT_TEST_HOST' }] }),
      },
    },
  });
  const receipt = await core.invokeTool({ tool: 'echo_probe' }, makeExec());
  assert.equal(receipt.ok, false);
  // `refuseFrom()` (`driver-core.js:157-159`) deliberately KEEPS the code the
  // probe reported and only falls back to `NOT_ARMED` when it reported none: an
  // unarmed host must say WHY it is unarmed, not collapse every cause into one
  // word. This fixture's probe reports `PROVENANCE_NOT_TEST_HOST`, so that is the
  // receipt — asserting `NOT_ARMED` here would overwrite the more specific
  // refusal the driver exists to produce.
  assert.equal(receipt.code, 'PROVENANCE_NOT_TEST_HOST', 'the probe\'s own refusal code survives');
  // The receipt is what the entry renders; it must be plain JSON with no path.
  assert.equal(typeof JSON.stringify(receipt), 'string');
  assert.ok(!JSON.stringify(receipt).includes('/tmp/test-root'));
});

test('entry arms provenance before any control is registered', async () => {
  const source = await readSource(ENTRY_PATH);
  // Scan the CODE, not the raw file: the module header documents the host
  // primitives it relies on, so the literal `ctx.tools.register()` appears in a
  // COMMENT (`src/index.js:17`) thousands of characters before the first real
  // registration. Indexing the raw source therefore compared the arm against a
  // docstring and failed no matter what the code did.
  const code = stripComments(source);
  const armAt = code.indexOf('await core.arm()');
  const firstRegisterAt = code.indexOf('ctx.tools.register(');
  assert.ok(armAt > 0 && firstRegisterAt > 0);
  assert.ok(armAt < firstRegisterAt, 'the startup arm must precede registration');
  // Match the call's SHAPE, not one particular spacing: the probe is wired as
  // `probe: () => probeProvenance({ config, ctx, env: process.env })`, and a
  // regex that pins the exact whitespace inside the braces fails on a reindent
  // without anything behavioural changing.
  assert.match(code, /probe:\s*\(\s*\)\s*=>\s*probeProvenance\(\s*\{[^}]*\bconfig\b[^}]*\bctx\b[^}]*\benv:\s*process\.env\b[^}]*\}\s*\)/,
    'the entry must pass config, ctx and process.env to probeProvenance');
});

test('entry owns exactly the three fixed tool names and reserves them', () => {
  assert.deepEqual([...OWN_TOOL_NAMES], [
    'test_driver_status',
    'test_driver_plugin_set_enabled',
    'test_driver_invoke_tool',
  ]);
});

test('the ownership port refuses every request and never compares names', async () => {
  const source = await readSource(ENTRY_PATH);
  assert.match(source, /return \(\) => \(\{ ok: false, reason: DRIVER_CODES\.TOOL_OWNERSHIP_UNVERIFIED \}\);/);
  const { core } = makeCore();
  const result = await core.invokeTool({ tool: 'echo_probe' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED);
});

// ---------------------------------------------------------------------------
// Startup arm
// ---------------------------------------------------------------------------

test('arm probes once and carries the normalized configuration', async () => {
  const { core, calls } = makeCore();
  const first = await core.arm();
  const second = await core.arm();
  assert.equal(first.ok, true);
  assert.equal(calls.probes, 1, 'a second arm call must not re-probe');
  assert.equal(first.provenance.armed, true);
  assert.equal(first.config.pluginTargets[0].directory, 'practice');
  assert.equal(second, first);
});

test('an unarmed probe refuses controls with the provenance code, not a path', async () => {
  const { core } = makeCore({
    ports: {
      provenance: {
        probe: async () => ({ armed: false, issues: [{ code: 'PROVENANCE_NOT_TEST_HOST' }] }),
      },
    },
  });
  const lifecycle = await core.pluginSetEnabled({ plugin: 'practice', entry: 'practice:alpha', enabled: false }, makeExec());
  assert.equal(lifecycle.ok, false);
  assert.equal(lifecycle.code, 'PROVENANCE_NOT_TEST_HOST');
  // The message is whatever `deny()` can say about THAT code. `DESCRIPTIONS`
  // (`driver-core.js:97-117`) has sentences for the driver's own codes and for
  // `POLICY_PROVENANCE`, but not for the fine-grained `PROVENANCE_*` codes the
  // probe reports, so `descriptionFor()` falls back to
  // `FALLBACK_DESCRIPTION` (`driver-core.js:120`). That is the shipped
  // behaviour: the specific cause is carried by the CODE, and the sentence stays
  // a fixed string so no probe detail or path can leak into it. Asserting a
  // richer sentence would require inventing vocabulary the driver does not have.
  assert.equal(lifecycle.message, 'the driver refused this operation');
  assert.equal(lifecycle.message.includes('/tmp'), false, 'the refusal text carries no path');
  const status = await core.status();
  assert.equal(status.ok, true);
  assert.equal(status.armed, false);
});

test('a throwing probe is a refusal, never an exception across the tool boundary', async () => {
  const { core } = makeCore({
    ports: {
      provenance: {
        probe: async () => {
          throw new Error('/home/secret/path');
        },
      },
    },
  });
  const result = await core.invokeTool({ tool: 'echo_probe' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.NOT_ARMED);
  assert.ok(!result.message.includes('/home/secret'), 'host exception text must not reach the caller');
});

test('the entry falls back to the configuration it was mounted with', async () => {
  // The provenance probe does not carry configuration, so the entry supplies the
  // admin config to the arm step. This pins that wiring: a probe result without
  // a config still arms from `apply()`'s own argument.
  const source = await readSource(ENTRY_PATH);
  assert.match(source, /await core\.arm\(\);/);
  // Same shape-not-spacing rule as the arm-order test above: assert that the
  // three arguments reach `probeProvenance`, not that they share one line.
  assert.match(stripComments(source),
    /probeProvenance\(\s*\{[^}]*\bconfig\b[^}]*\bctx\b[^}]*\benv:\s*process\.env\b[^}]*\}\s*\)/,
    'the entry must wire probeProvenance to the mounted config, ctx and env');
  assert.match(source, /adminConfig: config,/,
    'the entry must pass its mounted configuration to the core');
  const { core } = makeCore({
    config: makeConfig(),
    ports: {
      provenance: { probe: async () => ({ armed: true, isTestHost: true, issues: [] }) },
    },
  });
  const armedState = await core.arm();
  assert.equal(armedState.ok, true);
  assert.equal(armedState.config.testTools[0].name, 'echo_probe');
});

test('the entry evaluates the admin config once, before any port is called', async () => {
  const source = await readSource(ENTRY_PATH);
  const normalizeAt = source.indexOf('const normalized = normalizeConfig(config);');
  const createAt = source.indexOf('const core = createDriverCore({');
  assert.ok(normalizeAt > 0 && createAt > normalizeAt, 'the config is read before the core is built');
  assert.match(source, /deadlineMs = normalized\.ok === true \? normalized\.config\.invocationTimeoutMs : undefined/);
});

test('status before arm reports the unarmed state instead of a refusal', async () => {
  // `status()` is the one control that must answer before the arm settles — the
  // entry arms during activation, and a status call can arrive in the same tick.
  // Its implementation (`driver-core.js:920-936`) therefore does NOT return
  // `NOT_READY`: it reports `ok: true, armed: false` with an empty projection,
  // because "nothing is armed yet" is a readable state, not an error. (The
  // `NOT_READY` code lives in `state()` and is only reached by operations that
  // must refuse; `exclusive()` callers consume it.) Assert the real contract.
  const { core, loader } = makeCore();
  const status = await core.status();
  assert.equal(status.ok, true, 'status answers before the arm settles');
  assert.equal(status.armed, false);
  assert.deepEqual(status.targets, [], 'nothing is allowlisted before the arm validates configuration');
  assert.deepEqual(status.tools, []);
  assert.equal(loader.calls.length, 0, 'status must not mutate the loader');
});

// ---------------------------------------------------------------------------
// Status projection
// ---------------------------------------------------------------------------

test('status lists only configured targets and probes configured entries', async () => {
  const { core, loader } = makeCore();
  // Arm explicitly: the projection lists what the arm VALIDATED, so reading it
  // before the arm settles would assert the empty pre-arm view instead.
  const armedState = await core.arm();
  assert.equal(armedState.ok, true, 'the fixture configuration arms');
  const status = await core.status();
  assert.equal(status.ok, true);
  assert.equal(status.armed, true);
  assert.equal(status.provenance.testRoot, '/tmp/test-root');
  // The protected production home is never part of the projection.
  assert.equal('protectedHome' in status.provenance, false);
  assert.deepEqual(status.targets, [{ directory: 'practice', entries: ['practice:alpha'] }]);
  assert.deepEqual(status.tools, ['echo_probe']);
  assert.equal(loader.calls.length, 0, 'status must not mutate the loader');
});

test('status reports an entry that the target declares no module for as undeclared', async () => {
  const config = makeConfig();
  const { core } = makeCore({ config });
  const armedState = await core.arm();
  assert.equal(armedState.ok, true, 'the fixture configuration arms');
  const status = await core.status();
  // No positional module is declared for `practice:alpha` in this fixture, so
  // there is no specifier to report and nothing to compare a live registration
  // against. `Undeclared` is the honest projection; it is NOT a mapping failure,
  // which is why the tool still lists and invocation is refused separately.
  assert.equal(status.entries[0].phase, 'undeclared');
  assert.equal(status.entries[0].present, false);
});

test('a mismatched live module is reported, not corrected', () => {
  const loader = makeLoader({ 'practice:alpha': makeEntry({ name: 'someone-else' }) });
  const record = describeEntry(loader, 'practice:alpha', 'sample-probe');
  assert.equal(record.present, true);
  assert.equal(record.mismatch, true);
  assert.equal(record.module, 'sample-probe');
});

test('an unresolvable entry is absent and its loader error is not echoed', () => {
  const record = describeEntry(makeLoader({}), 'practice:missing', 'sample-probe');
  assert.equal(record.present, false);
  assert.equal(record.phase, 'absent');
  assert.ok(!JSON.stringify(record).includes('unknown entry'));
});

test('status bounds the entry list', () => {
  const entries = Array.from({ length: 64 }, (_, index) => `practice:e${index}`);
  const status = buildStatus({
    provenance: { armed: true },
    config: { pluginTargets: [{ directory: 'practice', entries }], testTools: [] },
    loader: makeLoader(),
  });
  assert.equal(status.entries.length, STATUS_LIMITS.maxEntries);
  assert.equal(status.targets[0].entries.length, STATUS_LIMITS.maxEntries);
});

test('buildStatus is callable on its own for the projection cases', () => {
  const status = buildStatus({
    provenance: { armed: true, testRoot: '/tmp/test-root', issues: [{ code: 'PROVENANCE_OK' }] },
    config: { pluginTargets: [], testTools: [] },
    loader: undefined,
  });
  assert.equal(status.armed, true);
  assert.deepEqual(status.provenance.codes, ['PROVENANCE_OK']);
  assert.deepEqual(status.entries, []);
  assert.equal(Object.isFrozen(status), true);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('lifecycle refuses a directory that is not configured', async () => {
  const { core, calls } = makeCore();
  const result = await core.pluginSetEnabled({ plugin: 'other', entry: 'practice:alpha', enabled: false }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.TARGET_NOT_ALLOWED);
  assert.equal(calls.mutations.length, 0);
});

test('lifecycle refuses a path-shaped plugin argument', async () => {
  const { core } = makeCore();
  const result = await core.pluginSetEnabled({ plugin: '../practice', entry: 'practice:alpha', enabled: false }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.PATH_ESCAPE);
});

test('lifecycle refuses an entry that the target does not list', async () => {
  const { core, calls } = makeCore();
  const result = await core.pluginSetEnabled({ plugin: 'practice', entry: 'practice:beta', enabled: false }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.TARGET_NOT_ALLOWED);
  assert.equal(calls.mutations.length, 0);
});

test('lifecycle refuses a non-boolean enabled value', async () => {
  const { core } = makeCore();
  const result = await core.pluginSetEnabled({ plugin: 'practice', entry: 'practice:alpha', enabled: 'yes' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.ARGUMENT_INVALID);
});

test('lifecycle refuses when the target declares no module for the entry', async () => {
  const { core, calls } = makeCore();
  const result = await core.pluginSetEnabled({ plugin: 'practice', entry: 'practice:alpha', enabled: false }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.UNAVAILABLE);
  assert.equal(calls.mutations.length, 0, 'an unverifiable target must not reach the loader');
});

test('lifecycle forwards the configured module and returns a closed receipt', async () => {
  const config = makeConfig({ modules: ['sample-probe'] });
  const { core, calls } = makeCore({ config });
  const result = await core.pluginSetEnabled({ plugin: 'practice', entry: 'practice:alpha', enabled: false }, makeExec());
  assert.equal(result.ok, true);
  assert.equal(result.action, 'disable');
  assert.equal(result.module, 'sample-probe');
  assert.equal(result.persisted, 'unknown', 'the driver never upgrades the helper\'s persistence report');
  assert.equal(calls.mutations.length, 1);
  assert.equal(calls.mutations[0].module, 'sample-probe');
  // The helper gets an immediate-grant queue: the driver already holds the slot.
  const inner = calls.mutations[0].queue;
  assert.equal(typeof inner.run, 'function');
  assert.equal(await inner.run({}, async () => 'ran'), 'ran');
});

test('lifecycle replaces a helper message with fixed text', async () => {
  const config = makeConfig({ modules: ['sample-probe'] });
  const { core } = makeCore({
    config,
    ports: {
      setEntryEnabled: async () => ({
        ok: false,
        code: 'DRIVER_UPDATE_FAILED',
        message: 'the loader rejected the change for "practice:alpha" at fiber state 3',
        entry: 'practice:alpha',
      }),
    },
  });
  const result = await core.pluginSetEnabled({ plugin: 'practice', entry: 'practice:alpha', enabled: true }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DRIVER_UPDATE_FAILED');
  assert.equal(result.message, 'the loader did not apply the requested change');
  assert.ok(!result.message.includes('practice:alpha'));
});

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

test('invocation refuses a tool that is not allowlisted', async () => {
  const { core } = makeCore();
  const result = await core.invokeTool({ tool: 'shell_exec' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.TOOL_NOT_ALLOWED);
});

test('invocation refuses the driver\'s own tools even when they are allowlisted', async () => {
  // The admin allowlist names one of the driver's own tools; the driver must
  // still refuse to route a call into itself.
  const { core } = makeCore({
    config: makeConfig({ testTools: [{ name: 'test_driver_status', module: 'sample-probe' }] }),
    ports: { resolveToolOwnership: () => ({ ok: true, owner: 'practice' }) },
  });
  const result = await core.invokeTool({ tool: 'test_driver_status' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.KNOWN_TOOL_TARGET);
});

test('invocation refuses a claimed entry that is not configured', async () => {
  const { core, calls } = makeCore();
  const result = await core.invokeTool({ tool: 'echo_probe', entry: 'other:beta' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED);
  assert.equal(calls.invocations.length, 0);
});

test('invocation refuses when ownership evidence is absent, even with an allowlisted name', async () => {
  // The fixture declares the entry's positional module so the claim is readable:
  // with no `modules` at all the core refuses earlier with
  // `TOOL_OWNERSHIP_UNMAPPABLE`, which is a different fact ("its owner cannot be
  // established from configuration") and has its own coverage. What this test
  // pins is that a readable, matching mapping with no trusted evidence is still
  // refused — name equality is not provenance.
  const { core, calls } = makeCore({ config: makeConfig({ modules: ['sample-probe'] }) });
  const result = await core.invokeTool({ tool: 'echo_probe', entry: 'practice:alpha' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED);
  assert.equal(result.message, 'no trusted evidence binds this tool registration to an allowlisted plugin, so invocation is refused');
  assert.equal(calls.invocations.length, 0, 'name equality is not provenance');
});

test('invocation refuses without an owning agent', async () => {
  const { core } = makeCore({ ports: { resolveToolOwnership: () => ({ ok: true, owner: 'practice' }) } });
  const result = await core.invokeTool({ tool: 'echo_probe' }, { signal: new AbortController().signal });
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.NO_TURN);
});

test('invocation refuses without a caller signal', async () => {
  const { core } = makeCore({ ports: { resolveToolOwnership: () => ({ ok: true, owner: 'practice' }) } });
  const result = await core.invokeTool({ tool: 'echo_probe' }, { agent: { id: 'session-1' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_CODES.NO_TURN);
});

test('invocation forwards the owning agent and the admin allowlist to the helper', async () => {
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: () => ({ ok: true, owner: 'practice' }) } });
  const exec = makeExec();
  const result = await core.invokeTool({ tool: 'echo_probe', args: { text: 'hello' } }, exec);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'INVOKE_OK');
  assert.equal(result.status, 'executed');
  assert.equal(calls.created, 1, 'the invoker is built once per plugin instance');
  assert.equal(calls.invokerOptions.agent, exec.agent, 'the native call keeps its owning agent');
  assert.deepEqual(calls.invokerOptions.allowlist, ['echo_probe']);
  assert.deepEqual([...calls.invokerOptions.ownToolNames], [...OWN_TOOL_NAMES]);
  assert.deepEqual(calls.invocations, [{ name: 'echo_probe', args: { text: 'hello' } }]);
});

test('invocation replaces a helper status with a bounded string', async () => {
  const { core } = makeCore({
    ports: {
      resolveToolOwnership: () => ({ ok: true, owner: 'practice' }),
      createInvoker: () => ({
        async invoke() {
          return { ok: false, code: 'INVOKE_TOOL_ERROR', status: 'the tool failed at /home/secret/path' };
        },
        close() {},
      }),
    },
  });
  const result = await core.invokeTool({ tool: 'echo_probe' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVOKE_TOOL_ERROR');
  assert.ok(result.status.length <= 120);
});

test('invocation treats a throwing helper as unavailable, not as an exception', async () => {
  const { core } = makeCore({
    ports: {
      resolveToolOwnership: () => ({ ok: true, owner: 'practice' }),
      createInvoker: () => ({
        async invoke() {
          throw new Error('boom');
        },
        close() {},
      }),
    },
  });
  const result = await core.invokeTool({ tool: 'echo_probe' }, makeExec());
  assert.equal(result.ok, false);
  assert.equal(result.code, DRIVER_CODES.UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// Exclusive slot
// ---------------------------------------------------------------------------

test('a lifecycle change cannot begin while an invocation is unsettled', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const config = makeConfig({ modules: ['sample-probe'] });
  const { core, calls } = makeCore({
    config,
    ports: {
      resolveToolOwnership: () => ({ ok: true, owner: 'practice' }),
      createInvoker: () => ({
        async invoke() {
          await gate;
          return { ok: true, code: 'INVOKE_OK', status: 'executed' };
        },
        close() {},
      }),
    },
  });
  const pending = core.invokeTool({ tool: 'echo_probe' }, makeExec());
  // The lifecycle call arrives while the invocation holds the slot.
  const lifecycle = await core.pluginSetEnabled({ plugin: 'practice', entry: 'practice:alpha', enabled: false }, makeExec());
  assert.equal(lifecycle.ok, false);
  assert.equal(lifecycle.code, DRIVER_CODES.BUSY);
  assert.equal(calls.mutations.length, 0);
  release();
  const finished = await pending;
  assert.equal(finished.ok, true);
});

test('a caller timeout refuses that caller but keeps the slot held until settlement', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { core } = makeCore({
    config: makeConfig({ invocationTimeoutMs: 20 }),
    ports: {
      resolveToolOwnership: () => ({ ok: true, owner: 'practice' }),
      createInvoker: () => ({
        async invoke() {
          await gate;
          return { ok: true, code: 'INVOKE_OK', status: 'executed' };
        },
        close() {},
      }),
    },
  });
  const first = await core.invokeTool({ tool: 'echo_probe' }, makeExec());
  assert.equal(first.ok, false);
  assert.equal(first.code, DRIVER_CODES.BUSY, 'a timeout is reported as the driver\'s single busy code');
  // The native work has not settled, so the slot is still held.
  const second = await core.invokeTool({ tool: 'echo_probe' }, makeExec());
  assert.equal(second.ok, false);
  assert.equal(second.code, DRIVER_CODES.BUSY);
  release();
});

test('status is available while the exclusive slot is held', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { core } = makeCore({
    ports: {
      resolveToolOwnership: () => ({ ok: true, owner: 'practice' }),
      createInvoker: () => ({
        async invoke() {
          await gate;
          return { ok: true, code: 'INVOKE_OK', status: 'executed' };
        },
        close() {},
      }),
    },
  });
  const pending = core.invokeTool({ tool: 'echo_probe' }, makeExec());
  // Wait until the invocation really holds the slot. Reading status immediately
  // after the call reads the PRE-arm view (`armed: false`) and would assert the
  // opposite of this test's name; the slot is entered a few microtasks after the
  // arm settles, so wait for the observable fact instead of a tick count.
  for (let tick = 0; tick < 8 && core.queue.pending === 0; tick += 1) await Promise.resolve();
  assert.equal(core.queue.pending, 1, 'the invocation holds the exclusive slot');
  const status = await core.status();
  assert.equal(status.ok, true);
  assert.equal(status.armed, true);
  release();
  await pending;
});

test('the plugin-wide slot is one queue shared by lifecycle and invocation', () => {
  const { core } = makeCore();
  assert.equal(typeof core.queue.run, 'function');
  assert.equal(typeof core.queue.begin, 'function');
  assert.equal(core.queue.pending, 0);
  assert.equal(core.queue.unsettled, undefined);
});

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

test('dispose closes the invoker and refuses later operations', async () => {
  const { core, calls } = makeCore({ ports: { resolveToolOwnership: () => ({ ok: true, owner: 'practice' }) } });
  await core.invokeTool({ tool: 'echo_probe' }, makeExec());
  core.dispose();
  assert.equal(core.closed, true);
  assert.equal(calls.closed, 1);
  const after = await core.invokeTool({ tool: 'echo_probe' }, makeExec());
  assert.equal(after.ok, false);
  assert.equal(after.code, DRIVER_CODES.UNAVAILABLE);
});

test('dispose never throws even when the invoker close throws', () => {
  const { core } = makeCore({
    ports: {
      resolveToolOwnership: () => ({ ok: true, owner: 'practice' }),
      createInvoker: () => ({ invoke: async () => ({ ok: true }), close() { throw new Error('close failed'); } }),
    },
  });
  assert.doesNotThrow(() => core.dispose());
  assert.equal(core.closed, true);
});

// ---------------------------------------------------------------------------
// Fixed vocabulary and small helpers
// ---------------------------------------------------------------------------

test('every refusal is a closed code and a fixed sentence', () => {
  const refusal = isRefusal({ ok: false, code: 'X', message: 'm' });
  assert.equal(refusal, true);
  assert.equal(isRefusal({ ok: true }), false);
  assert.equal(isRefusal(null), false);
});

test('ownership verdicts require a non-empty owner string', () => {
  assert.deepEqual(checkOwnership(() => ({ ok: true, owner: 'practice' }), { tool: 't', entry: null }), { ok: true, owner: 'practice' });
  assert.deepEqual(checkOwnership(() => ({ ok: true }), { tool: 't', entry: null }), { ok: false });
  assert.deepEqual(checkOwnership(() => ({ ok: true, owner: '' }), { tool: 't', entry: null }), { ok: false });
  assert.deepEqual(checkOwnership(() => {
    throw new Error('no');
  }, { tool: 't', entry: null }), { ok: false });
});

test('entry allowlist membership requires an exact configured id', () => {
  const targets = [{ directory: 'practice', entries: ['practice:alpha'] }];
  assert.equal(entryIsAllowlisted(targets, 'practice:alpha'), true);
  assert.equal(entryIsAllowlisted(targets, 'practice:beta'), false);
  assert.equal(entryIsAllowlisted(targets, ''), false);
});

test('the passthrough queue grants immediately and forwards the work result', async () => {
  let ran = 0;
  const value = await passthroughQueue().run({ entryId: 'x', timeoutMs: 1 }, async () => {
    ran += 1;
    return 'value';
  });
  assert.equal(value, 'value');
  assert.equal(ran, 1);
});

test('a receipt is a plain, non-frozen JSON object the entry can render', () => {
  // The renderer lives in the entry (which imports host packages); this pins the
  // property it relies on — every core outcome is JSON-serializable plain data.
  const { core } = makeCore();
  return core.status().then((status) => {
    assert.equal(typeof JSON.stringify(status), 'string');
    assert.equal(Array.isArray(status), false);
  });
});

test('the core module imports only its own package files', async () => {
  const source = await readSource(CORE_PATH);
  const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, 'the core must import the policy and helpers');
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('./') || specifier.startsWith('../'),
      `the core must only import its own modules, found: ${specifier}`);
  }
});

test('the entry\'s receipt renderer produces the same single text block', async () => {
  // The renderer is pure and imports nothing at call time, so its source can be
  // evaluated in isolation even though the entry module itself cannot be loaded
  // without the host packages.
  const source = await readSource(ENTRY_PATH);
  const start = source.indexOf('export function renderReceipt');
  assert.ok(start > 0, 'the entry must export renderReceipt');
  const body = source.slice(start, source.indexOf('\n}\n', start) + 3);
  // `renderReceipt` closes over the entry's `TEXT` constant, so the isolated
  // evaluation must receive it alongside `DRIVER_CODES`; the same source scan
  // then proves the evaluated body is the one the entry actually ships.
  const textStart = source.indexOf('const TEXT = Object.freeze({');
  assert.ok(textStart > 0, 'the entry must declare the fixed receipt text');
  const textBlock = source.slice(textStart, source.indexOf('});\n', textStart) + 4);
  // `textBlock` itself DECLARES `const TEXT`, so the parameter list must not also
  // name `TEXT`: `new Function('TEXT', 'const TEXT = ...')` is a SyntaxError
  // ("Identifier 'TEXT' has already been declared"), not a renderer failure. The
  // block is passed as source and the resulting value is what gets bound.
  const factory = new Function(
    'DRIVER_CODES',
    `${textBlock}\n${body.replace('export function', 'function')}\nreturn renderReceipt;`,
  );
  const text = new Function(`${textBlock}\nreturn TEXT;`)();
  const render = factory(DRIVER_CODES);
  assert.ok(typeof text.status === 'string' && text.status !== '', 'TEXT must carry the status heading');
  const blocks = render({ ok: true, kind: 'invocation', code: 'INVOKE_OK', status: 'executed' });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.ok(blocks[0].text.startsWith(text.status), 'the rendered block starts with the fixed status heading');
  assert.ok(blocks[0].text.includes('INVOKE_OK'));
  const empty = render(undefined);
  assert.ok(empty[0].text.includes(DRIVER_CODES.UNAVAILABLE));
});

/**
 * KNOWN HOST PROOF GAPS — what this suite cannot establish, and what the parent
 * must prove with a real DSH process under the hard cgroup:
 *
 * 1. That `Config` is accepted by the host config parser and that `inject` is
 *    satisfied. Both need a mounted Loader entry; this package has no host
 *    dependency installed, so the test cannot import `src/index.js`.
 * 2. That `defineTool(...)` accepts these `parameters`/`output` objects and that
 *    `ctx.tools.register()` does not throw. The JSON-schema validation performed
 *    by `register()` (`packages/core/tools/src/index.ts:127-155`) is not
 *    reproduced here.
 * 3. That a native `tools.execute` call keeps the owning Agent's guard pipeline
 *    and that a guard denial is visible as `INVOKE_TOOL_ERROR`. This suite fakes
 *    the invoker by design; only a real executor shows the guard.
 * 4. That tool-ownership evidence exists at all. No public API returns the
 *    registering plugin, so `ownershipUnavailable()` refuses every invocation.
 *    Until a trusted exact definition binding exists, `test_driver_invoke_tool`
 *    is a refusal-only tool in production.
 * 5. That the loader's `update(id, { disabled })` semantics match the helper's
 *    expectations for re-enabling an entry with no fiber. The driver itself
 *    refuses to `create()` entries, so "load" means "re-enable an allowlisted,
 *    already-mounted entry".
 * 6. That the cgroup actually kills an over-long native call. `MutationQueue`
 *    bounds the caller, not the process; the hard limit belongs to the cgroup.
 */
