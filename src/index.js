/**
 * Host plugin entry for the isolated test driver.
 *
 * This is the only file that knows what a Cordis context is. It binds official
 * host APIs to the ports of `./internal/driver-core.js`; every decision lives in
 * the core, so the behaviour is unit tested without a DSH process.
 *
 * Official API facts used here, and where each was read (`.cache/upstream`,
 * pinned ce7073d…0.2.2-alpha.2):
 * - Function-plugin shape `name` / `inject` / `Config` / `apply` —
 *   `packages/todo/tool-todo/src/index.ts:22-23,41-43,112-117` and
 *   `packages/guard/timeout-policy/src/index.ts:26-31`.
 * - Schemastery comes from `@deepseek-ai/schemastery` and is typed `z<Config>`
 *   — `tool-todo/src/index.ts:9,41` and `packages/core/tools/src/index.ts:3`. No
 *   harness package imports a bare `schemastery` specifier.
 * - `defineTool()` — `packages/core/tools/src/schema.ts:555-626`.
 * - `ctx.tools.register()` — `packages/core/tools/src/index.ts:127-155`
 *   (validates the JSON schema, reserves `run_code`, disposes with the plugin).
 * - Loader export normalization keeps named exports for a module with no default
 *   export — `vendor/loader/src/index.ts:196-203`. This module exports no default.
 * - `ctx.effect(execute)` is the official teardown primitive; `execute` runs
 *   immediately, and the disposer it returns runs on fiber unload —
 *   `.cache/upstream/vendor/cordis/src/fiber.ts:408-421`. Every shipped plugin
 *   unloads through it (`packages/api/remote-access/src/index.ts:136`,
 *   `packages/acp/acp/src/index.ts:436`).
 *
 * NO PLUGIN-LIFETIME SIGNAL EXISTS ON THE CONTEXT
 * -----------------------------------------------
 * `.cache/upstream/vendor/cordis/src` contains no `signal` member on any of
 * `context.ts`, `events.ts`, `fiber.ts`, `reflect.ts`, `registry.ts`, or
 * `service.ts`, and `ctx.scope` is not a context property either — `scope` there
 * is only the word used for service-isolation prose (`context.ts:17,110-119`).
 * The `Events` interface (`events.ts:334-371`) declares no `'dispose'` event, and
 * no plugin in `.cache/upstream/packages` listens for one. An earlier revision of
 * this file read `ctx.scope?.signal` and registered `ctx.on('dispose', ...)`;
 * both were invented, and the first silently passed `undefined`, so every
 * invoker got a placeholder signal that could never abort on unload.
 *
 * This entry therefore owns its own `AbortController`, created once per `apply()`
 * and aborted by the disposer registered through `ctx.effect()`. That controller
 * is the lifetime signal handed to the core.
 *
 * TOOL OWNERSHIP — READ BEFORE CHANGING `ownershipUnavailable()`
 * ---------------------------------------------------------------
 * No public host API reports which plugin registered a tool name.
 * `ctx.tools.get(name, scope)` can obtain the *definition* a scope resolves
 * (`packages/core/tools/src/index.ts:238-245`), but the definition is a value
 * copied into the registry at registration time: it carries no registering
 * plugin, no disposer, and no owner handle, and the registry layer itself
 * exposes none. A tool *name* is not provenance either: any plugin loaded for
 * the exercise, including untrusted code, may register the same name, and can
 * replace the registration between startup and the call.
 *
 * This entry therefore refuses every invocation with the fixed code
 * `DRIVER_TOOL_OWNERSHIP_UNVERIFIED`, which is the brief's requirement — refuse
 * until a trusted exact definition binding exists. When the host gains one,
 * replace this single function; never weaken it into a name comparison.
 *
 * @module dsh-agent-test-driver
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { normalizeConfig, POLICY_CODES } from './policy.js';
import { probeProvenance } from './provenance.js';
import { createSingleToolInvoker } from './internal/invoke-tool.js';
import { setEntryEnabled } from './internal/loader-ops.js';
import {
  DRIVER_CODES,
  OWN_TOOL_NAMES,
  createDriverCore,
} from './internal/driver-core.js';

/** Plugin name. */
export const name = 'dsh-agent-test-driver';

/**
 * Required services.
 *
 * Both are mandatory rather than optional: a driver without `tools` can neither
 * register nor invoke anything, and a driver without `loader` can neither enable
 * nor disable anything. A single missing-dependency error at load is clearer
 * than mounting a plugin that silently does nothing.
 */
export const inject = ['tools', 'loader'];

/**
 * Configuration schema handed to the host config parser.
 *
 * Must be a callable schemastery schema (`z.object(...)`), never a literal.
 * The four policy fields (`pluginTargets`, `testTools`, `maxStatusBytes`,
 * `invocationTimeoutMs`) mirror `policy.normalizeConfig()`, which remains the
 * owner of their normalization and value checks — this schema declares shapes
 * for the host parser and does not replace that step. The two provenance fields
 * (`testRoot`, `profileMarker`) are declared here for the host config parser
 * only: they are never returned by `normalizeConfig()`, and the probe reads them
 * from the raw mounted config that {@link apply} also hands to the core as
 * `adminConfig`.
 *
 * Both provenance fields are deliberately `z.string()` with no `.default()` and
 * no `.required()`. No default, because a default would pick an operator's trust
 * root or marker inside the schema, where neither the probe nor the launcher
 * chose it; the fields exist so that the *operator* names them, and an unnamed
 * field is reported by the probe rather than invented here. (A default would not
 * by itself make `NOT_CONFIGURED` unreachable: a host can still pass `null`, an
 * empty string, or omit the other field.) No `.required()`, because an absent
 * value must keep flowing to that same refusal instead of failing the plugin
 * load. The tradeoff is explicit: a *present, non-null, non-undefined value of
 * another type* now fails host config parsing (a load-time `ValidationError`)
 * instead of reaching the probe and being reported as `NOT_CONFIGURED` — the
 * schema's string check does not accept `null` or `undefined` in that position,
 * so those two keep reaching the probe.
 *
 * Declaring them is also what keeps them alive across a config rewrite: the
 * host persists an updated entry config through `Config.simplify()`, and
 * `simplify` drops keys the schema does not declare.
 *
 * `pluginTargets[].modules` is positional and must match `entries` one-to-one
 * when present (the core enforces that). It carries the module specifier each
 * loader entry currently mounts, which is what lets the driver prove a live entry
 * is the allowlisted one. It is separate from `directory`, which the policy owns
 * as a bare directory name.
 *
 * `testTools[].module` stays a package specifier: the policy owns that field and
 * this entry does not reinterpret it. Test tools are therefore not mounted by
 * this plugin at all — see the note in {@link apply}.
 */
export const Config = z.object({
  pluginTargets: z.array(z.object({
    directory: z.string(),
    entries: z.array(z.string()),
    modules: z.array(z.string()),
  })).default([]),
  testTools: z.array(z.object({
    name: z.string(),
    module: z.string(),
    expect: z.string(),
  })).default([]),
  maxStatusBytes: z.number().min(512).max(65536).default(8192),
  invocationTimeoutMs: z.number().min(1).max(60000).default(5000),
  // Read by `provenance.js` only (static checks at `:302-303`, canonicalization
  // at `:659-660`, alias check at `:670`, and the re-run at `:683`). Kept
  // optional and defaultless on purpose — see the note on this schema.
  testRoot: z.string(),
  profileMarker: z.string(),
});

/**
 * Build the tool-ownership port.
 *
 * A named seam rather than an inline arrow: the refusal is greppable and a
 * future trusted ownership API lands in exactly one place.
 *
 * @returns {(request: { tool: string, entry: string | null }) => { ok: false, reason: string }}
 *   A port that never grants ownership.
 */
export function ownershipUnavailable() {
  return () => ({ ok: false, reason: DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED });
}

/** Fixed, path-free text for receipt rendering. */
const TEXT = Object.freeze({
  refused: 'the test driver refused this operation; see the code for the reason',
  status: 'dsh-agent-test-driver status',
  // Used when the resolved tool definition is null and must be reported, not thrown.
  undelivered: 'the test driver refused this operation before delivery',
});

/**
 * Render one driver receipt as a single text content block.
 *
 * Only closed fields reach the model: codes, fixed sentences, and bounded status
 * strings. The core already reduced every outcome to those fields, so a receipt
 * cannot carry a path, a host exception message, or raw tool output.
 *
 * @param {unknown} value Receipt returned by the core.
 * @returns {Array<{ type: 'text', text: string }>} Content blocks for the tool result.
 */
export function renderReceipt(value) {
  const payload = value ?? { ok: false, code: DRIVER_CODES.UNAVAILABLE, message: TEXT.refused };
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    // A receipt is a plain object by construction, so this only triggers if a
    // future change lets a cycle or a BigInt into one. Report it as refused
    // rather than letting the renderer throw inside the tool result path.
    body = JSON.stringify({ ok: false, code: DRIVER_CODES.UNAVAILABLE, message: TEXT.undelivered });
  }
  return [{ type: 'text', text: `${TEXT.status}\n${body}` }];
}

/** Output schema shared by the driver tools: the receipt object. */
const RECEIPT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: { ok: { type: 'boolean' }, code: { type: 'string' } },
  additionalProperties: true,
});

/** Arguments of the status tool: none. */
const NO_PARAMETERS = Object.freeze({});

/** Arguments of a lifecycle action. */
const LIFECYCLE_PARAMETERS = Object.freeze({
  plugin: { type: 'string', description: 'Configured target directory name (not a path).', required: true },
  entry: { type: 'string', description: 'One configured loader entry id of that target.', required: true },
  enabled: { type: 'boolean', description: 'true to enable, false to disable.', required: true },
});

/** Arguments of the invocation tool. */
const INVOKE_PARAMETERS = Object.freeze({
  tool: { type: 'string', description: 'An allowlisted test tool name.', required: true },
  entry: { type: 'string', description: 'The configured entry the tool is claimed to belong to.' },
  args: { type: 'object', properties: {}, additionalProperties: true, description: 'Arguments passed to the test tool.' },
});

/**
 * Mount the driver.
 *
 * Provenance comes first, before any control is registered, matching the design
 * plan. `arm()` never throws, and an unarmed driver still registers its tools,
 * which then refuse with a fixed code: a driver that registered nothing when
 * unarmed would make "the guard is off" indistinguishable from "the plugin
 * failed to load", and an operator could not read the reason through the tools
 * they were told to use.
 *
 * @param {object} ctx Host plugin context exposing `tools`, `loader`, `effect`.
 * @param {object} config Raw configuration validated by {@link Config}.
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  // The plugin-lifetime controller, owned by this `apply()` call. See the module
  // note: the host context exposes no lifetime signal, so one is created here
  // rather than read from a member that does not exist.
  const lifetime = new AbortController();

  // Read the admin configuration once, so neither a request argument nor a later
  // config mutation can widen the executor deadline.
  const normalized = normalizeConfig(config);
  const deadlineMs = normalized.ok === true ? normalized.config.invocationTimeoutMs : undefined;

  const core = createDriverCore({
    provenance: {
      // The real probe reads the real environment; the core never does. The
      // mounted config is forwarded so the probe can anchor the test host to the
      // configured targets instead of trusting the environment alone.
      probe: () => probeProvenance({ config, ctx, env: process.env }),
    },
    // The normalizer is passed as a FUNCTION, which is the documented port shape
    // (`createDriverCore()` destructures `ports.config` and requires it to be a
    // function: `driver-core.js:689,707,719`; every core test constructs
    // `config: normalizeConfig`). Passing a wrapper object here made the core
    // throw `ports.config.normalize must be a function` at creation time, so the
    // plugin could never mount.
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
    // The configuration the entry was mounted with: the probe describes the host
    // and never carries config, so the core validates this value instead.
    adminConfig: config,
    // Plugin-lifetime cancellation, so aborting the plugin reaches every queued
    // operation instead of being reconstructed per call.
    signal: lifetime.signal,
    log: () => {},
  });

  // Registered BEFORE `arm()` and before any tool registration, so a partial
  // activation — an arm that rejects, or a `register()` that throws midway — still
  // gets torn down. `ctx.effect` runs the body now and keeps the returned disposer
  // until the fiber unloads (fiber.ts:408-421), which is the only teardown hook
  // the host actually offers; there is no `'dispose'` event to listen for.
  //
  // Order inside the disposer is deliberate: abort first, so nothing new is
  // dispatched with a dead plugin behind it, then dispose the core so in-flight
  // invokers are closed. Both steps are idempotent, and neither may throw.
  ctx.effect(() => () => {
    lifetime.abort();
    core.dispose();
  }, 'dsh-agent-test-driver: lifetime');

  // Armed before any registration, so a control that arrives immediately after
  // load reads the settled arm state instead of `DRIVER_NOT_READY`. The outcome —
  // armed or refused — is deliberately not inspected here: `arm()` records its
  // own receipt, and every control reports it (`driver-core.js:836-844` keeps a
  // policy refusal and a provenance refusal distinct), so a failed arm still
  // registers the three tools that can explain it.
  await core.arm();

  // The normalizer is handed to the core as the `config` port itself, so this
  // entry holds no second copy of it: the deadline above and `arm()` below both
  // evaluate the same function.

  // Registered for every arm state: the receipts below are the only report an
  // operator gets when the arm fails.
  ctx.tools.register(defineTool({
    name: 'test_driver_status',
    description: 'Report the test driver\'s isolated-host status: arm state, configured targets, and live entry phases.',
    parameters: NO_PARAMETERS,
    output: {
      schema: RECEIPT_OUTPUT_SCHEMA,
      render: (_args, value) => renderReceipt(value),
    },
    async execute() {
      return core.status();
    },
  }));

  ctx.tools.register(defineTool({
    name: 'test_driver_plugin_set_enabled',
    description: 'Enable or disable one configured loader entry. Requires an armed isolated test host.',
    parameters: LIFECYCLE_PARAMETERS,
    output: {
      schema: RECEIPT_OUTPUT_SCHEMA,
      render: (_args, value) => renderReceipt(value),
    },
    async execute(args, exec) {
      return core.pluginSetEnabled(args, exec);
    },
  }));

  // Registered third, after the two controls, because it is the only tool that
  // can dispatch into another registration. It is still registered for every arm
  // state: an unarmed driver refuses with `DRIVER_NOT_ARMED` rather than
  // disappearing, so the operator reads *why* it cannot invoke.
  //
  // `execute` forwards the native context untouched. The core reads `exec.agent`
  // and `exec.signal` from it — the two fields `ToolRunContext` guarantees
  // (`packages/core/tools/src/contracts.ts:174-208,244`) — and this entry adds no
  // context of its own: no scope, agent, or signal is manufactured here.
  ctx.tools.register(defineTool({
    name: 'test_driver_invoke_tool',
    description: 'Invoke one allowlisted test tool through the native executor, as the calling agent. Requires an armed isolated test host and trusted ownership evidence.',
    parameters: INVOKE_PARAMETERS,
    output: {
      schema: RECEIPT_OUTPUT_SCHEMA,
      render: (_args, value) => renderReceipt(value),
    },
    async execute(args, exec) {
      return core.invokeTool(args, exec);
    },
  }));

  // Test tools are NOT mounted here. The driver can read a definition through
  // `ctx.tools.get()`, but no public API maps that definition to the plugin that
  // registered it (see the ownership note at the top), and mounting a placeholder
  // under the configured name would manufacture exactly the name-equality
  // evidence the driver must not accept. `testTools` therefore describes tools the
  // *host* mounts; the driver needs their names to allowlist a call, and it
  // refuses that call until real ownership evidence exists.

  // Cleanup was registered at the top of `apply()`, before `arm()`: see the
  // `ctx.effect(...)` call there. Nothing is registered here, because a listener
  // added at the end would not exist for a load that failed earlier, and no
  // `'dispose'` event exists to listen for in the first place.
}

export { DRIVER_CODES, OWN_TOOL_NAMES, POLICY_CODES };
