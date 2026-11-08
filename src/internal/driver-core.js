/**
 * The test-driver core: the whole behavioural body of the plugin, expressed
 * against *ports* instead of a live host.
 *
 * Why this shape: the entry (`src/index.js`) is the only file that knows what a
 * Cordis context is, and it is also the only file that cannot be unit tested
 * without a real DSH process. Everything that decides *what happens* — the
 * startup provenance arm, the exclusive slot, the allowlist lookups, the receipt
 * fields — lives here and receives its collaborators as a frozen object.
 * `tests/entry.test.js` builds those collaborators from plain mocks, so this
 * module never loads a host package, never reads `process.env`, and never opens
 * a file or a socket.
 *
 * What this module deliberately does NOT do:
 * - Provenance arrives through `ports.provenance.probe()`, which the entry binds
 *   to the real `probeProvenance()` with the real environment. The core reads no
 *   environment of its own, so a test can arm or disarm it without touching the
 *   process.
 * - Loader mutations go through `ports.setEntryEnabled` and invocations through
 *   `ports.createInvoker`: the entry supplies the real helpers, a test supplies
 *   fakes.
 * - It never enumerates the loader tree. Only ids the administrator configured
 *   are ever resolved.
 *
 * Failure vocabulary is closed on purpose: a caller receives a fixed code and a
 * fixed sentence, never a path, host exception text, or raw tool output. Any
 * outcome that would need such a value to be explained becomes a refusal whose
 * message describes the refusal, not the value.
 *
 * @module dsh-agent-test-driver/internal/driver-core
 */

import {
  POLICY_CODES,
  findAllowedTool,
  findAllowedTarget,
} from '../policy.js';
import { MutationQueue, entryPhase } from './loader-ops.js';
import { boundedText } from './redact.js';

/** Codes owned by this module; each reaches the caller as fixed text. */
export const DRIVER_CODES = Object.freeze({
  /** A control call arrived before the startup arm settled. */
  NOT_READY: 'DRIVER_NOT_READY',
  /** Startup provenance did not arm. The provenance code accompanies it. */
  NOT_ARMED: 'DRIVER_NOT_ARMED',
  /** Another driver operation has not settled; the exclusive slot is held. */
  BUSY: 'DRIVER_BUSY',
  /** No trusted evidence binds the requested tool registration to an allowlisted plugin. */
  TOOL_OWNERSHIP_UNVERIFIED: 'DRIVER_TOOL_OWNERSHIP_UNVERIFIED',
  /** The claimed entry maps to no readable module, so ownership cannot be asked at all. */
  TOOL_OWNERSHIP_UNMAPPABLE: 'DRIVER_TOOL_OWNERSHIP_UNMAPPABLE',
  /** The status projection itself failed. */
  STATUS_UNAVAILABLE: 'DRIVER_STATUS_UNAVAILABLE',
  /** A required host port is missing or failed before producing a receipt. */
  UNAVAILABLE: 'DRIVER_HOST_UNAVAILABLE',
});

/**
 * Names this plugin registers. Frozen: a disposer and the recursion guard both
 * read it, and a mutable list would let one call make a later call legal.
 */
export const OWN_TOOL_NAMES = Object.freeze([
  'test_driver_status',
  'test_driver_plugin_set_enabled',
  'test_driver_invoke_tool',
]);

/** Bounds on what a status projection may describe. */
export const STATUS_LIMITS = Object.freeze({
  /** Ceiling on listed entries, so a large config cannot bloat a status result. */
  maxEntries: 32,
  maxIdLength: 128,
  maxModuleLength: 160,
  /** Bounded sentence length for every fixed message this module emits. */
  maxMessageLength: 200,
});

/**
 * Ceiling on invocations that have not settled yet.
 *
 * The core holds no per-agent cache (see `createSingleToolInvoker`), so this
 * bound is on *concurrently live* invokers, not on how many agents exist over a
 * plugin lifetime: an agent may invoke any number of times. The exclusive slot
 * already admits one invocation at a time, so this ceiling is reached only if
 * earlier invocations never settled; overflow is then refused
 * (`DRIVER_HOST_UNAVAILABLE`) rather than allowed to grow without limit.
 */
export const INVOKER_LIMITS = Object.freeze({
  /** 64 concurrent unsettled invocations are far beyond one exclusive slot. */
  maxAgents: 64,
});

/**
 * Fixed sentences, keyed by code, so no path or host text can reach a caller.
 * A code with no sentence falls back to {@link FALLBACK_DESCRIPTION}.
 */
const DESCRIPTIONS = Object.freeze({
  [POLICY_CODES.PROVENANCE]: 'this driver only operates as an isolated test host; provenance is not armed',
  [POLICY_CODES.CONFIG_INVALID]: 'the driver configuration is invalid, so no target or tool is allowlisted',
  [POLICY_CODES.TARGET_NOT_ALLOWED]: 'the requested plugin target or entry is not on the configured allowlist',
  [POLICY_CODES.TOOL_NOT_ALLOWED]: 'the requested tool is not on the configured allowlist',
  [POLICY_CODES.KNOWN_TOOL_TARGET]: 'the driver refuses to target its own tools',
  [POLICY_CODES.ARGUMENT_INVALID]: 'an argument was rejected by the driver policy',
  [POLICY_CODES.NO_TURN]: 'this tool needs an owning agent and caller signal to dispatch natively',
  [POLICY_CODES.PATH_ESCAPE]: 'the requested target is outside the configured scope',
  [POLICY_CODES.PRODUCTION_TARGET]: 'the requested target resolves into the protected production home',
  [DRIVER_CODES.NOT_READY]: 'the startup provenance check has not settled yet',
  [DRIVER_CODES.NOT_ARMED]: 'isolation provenance could not be established, so no operation is available',
  [DRIVER_CODES.BUSY]: 'another driver operation has not settled yet; retry once it has',
  [DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED]:
    'no trusted evidence binds this tool registration to an allowlisted plugin, so invocation is refused',
  [DRIVER_CODES.TOOL_OWNERSHIP_UNMAPPABLE]:
    'the claimed entry maps to no readable module in the configuration, so its owner cannot be established',
  [DRIVER_CODES.STATUS_UNAVAILABLE]: 'the status projection failed',
  [DRIVER_CODES.UNAVAILABLE]: 'a required host service is unavailable',
});

/** Sentence used when a code belongs to another module and has no entry above. */
const FALLBACK_DESCRIPTION = 'the driver refused this operation';

/** Closed refusal shape. Every outward failure is one of these. */
export const REFUSAL_SHAPE = Object.freeze({ ok: false, code: 'string', message: 'string' });

/**
 * @param {string} code One of {@link DRIVER_CODES} or `POLICY_CODES`.
 * @returns {string} The fixed sentence for `code`.
 */
export function descriptionFor(code) {
  return DESCRIPTIONS[code] ?? FALLBACK_DESCRIPTION;
}

/**
 * Build a refusal. The message is always the fixed sentence for `code`; callers
 * cannot pass free text into a refusal, which is what keeps paths and host
 * exception messages out of model-visible output.
 *
 * @param {string} code Fixed code.
 * @returns {{ ok: false, code: string, message: string }} The refusal.
 */
export function deny(code) {
  return {
    ok: false,
    code: boundedText(code, 64),
    message: boundedText(descriptionFor(code), STATUS_LIMITS.maxMessageLength),
  };
}

/**
 * Reduce a policy/helper refusal to the outward shape without forwarding its
 * message, which may echo a requested name or an entry id.
 *
 * @param {{ code?: unknown } | undefined} refusal Refusal from a policy or helper call.
 * @param {string} fallbackCode Code to use when `refusal.code` is absent.
 * @returns {{ ok: false, code: string, message: string }} The refusal.
 */
export function refuseFrom(refusal, fallbackCode) {
  return deny(typeof refusal?.code === 'string' && refusal.code !== '' ? refusal.code : fallbackCode);
}

/**
 * Classify a value as a core refusal.
 *
 * The queue reports its own failures (`DRIVER_TIMEOUT`, `DRIVER_CANCELLED`,
 * `DRIVER_ENTRY_BUSY`) and helpers report theirs; both arrive as `{ok:false,
 * code}`. Anything else is not a receipt and must not be passed through.
 *
 * @param {unknown} value Candidate receipt.
 * @returns {boolean} Whether `value` is a refusal object.
 */
export function isRefusal(value) {
  return value !== null && typeof value === 'object' && value.ok === false && typeof value.code === 'string';
}

/**
 * Whether `value` is usable as the owning agent of a native dispatch.
 *
 * `ToolExecutionInput.agent?: Agent` (`packages/core/tools/src/contracts.ts`,
 * "The agent on whose behalf the call runs (set by the agent loop)") is optional
 * and an `Agent` is identified by its session-backed `id`
 * (`packages/core/agent/src/types.ts:16-19`). A truthy non-object is therefore
 * not an agent, and accepting one would let a call reach the executor with no
 * resolvable scope. This is a *shape* check only; it is not ownership evidence.
 *
 * @param {unknown} value Candidate native execution context or agent.
 * @returns {boolean} Whether the value carries a usable agent handle.
 */
export function isAgentHandle(value) {
  return value !== null && typeof value === 'object';
}

/**
 * Build a fresh cancellation signal for exactly one invocation.
 *
 * An `AbortSignal` cannot be reset, and the native helper captures the signal it
 * was constructed with, so isolation requires a *new controller per call* rather
 * than a cached or placeholder one: aborting call A must never abort call B, and
 * the reasons differ, so the first reason observed wins (a caller cancellation
 * forwarded before an internal deadline is never relabelled as a deadline).
 *
 * @param {AbortSignal | undefined} lifetime Plugin-lifetime cancellation.
 * @param {AbortSignal} callerSignal This call's cancellation.
 * @param {number | undefined} deadlineMs Cooperative timer bound for this call.
 * @returns {{ signal: AbortSignal, dispose: () => void }} The signal and its release.
 */
export function callSignal(lifetime, callerSignal, deadlineMs) {
  const controller = new AbortController();
  const abort = (reason) => {
    // Later aborts are no-ops for the reason: the first one is what happened.
    if (controller.signal.aborted) return;
    controller.abort(reason);
  };
  const forward = () => abort(callerSignal.reason);
  // Ordinary calls pass through `exclusive()`, which already refused a call whose
  // caller signal was aborted, so the branch below is for a signal that aborts
  // between that check and here — it must never end up as an unobserved abort.
  const watchLifetime = lifetime !== undefined && lifetime !== null;
  const onLifetime = () => abort(lifetime.reason);
  if (watchLifetime) {
    if (lifetime.aborted) onLifetime();
    else lifetime.addEventListener('abort', onLifetime, { once: true });
  }
  if (callerSignal.aborted) {
    forward();
  } else {
    callerSignal.addEventListener('abort', forward, { once: true });
  }
  let timer;
  if (deadlineMs !== undefined) {
    timer = setTimeout(() => abort(new Error('invocation deadline elapsed')), deadlineMs);
    // The timer only asks the host to stop; the caller still waits for the drain.
    timer?.unref?.();
  }
  let disposed = false;
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (watchLifetime && !lifetime.aborted) lifetime.removeEventListener('abort', onLifetime);
      callerSignal.removeEventListener('abort', forward);
    },
  };
}

/**
 * Resolve the module specifier a configured target declares for one entry.
 *
 * `policy.normalizeTarget()` owns `directory` and `entries` and deliberately
 * does not carry `modules`; the entry adds them positionally. That split means the
 * positional mapping is validated here, at the arm, and NOT in the policy — the
 * policy's public shape stays `{directory, entries}` and no allowlist rule is
 * modified by this function.
 *
 * Fail closed on every ambiguity, because a wrong positional read would pair an
 * entry id with another entry's module and make `checkEntryModule()` in
 * `loader-ops` verify the wrong thing:
 * - no `modules` at all (`undefined`) — the target declares none;
 * - any non-array, or a length that differs from `entries` — the mapping is
 *   unreadable, so no entry of this target is resolvable;
 * - any element that is not a non-empty string — a hole or a non-string makes
 *   the whole mapping unreadable rather than only that position.
 *
 * The distinction between "declares none" (`null`) and "declares something
 * unreadable" (`undefined`) is load-bearing: `buildStatus()` must be able to
 * report an unreadable target as `unreadable` instead of as `undeclared`.
 *
 * @param {{ entries?: unknown, modules?: unknown }} target Normalized target.
 * @returns {string[] | null | undefined} One module per entry, `null` when the
 *   target declares none, `undefined` when the declaration cannot be read.
 */
export function targetModules(target) {
  const raw = target?.modules;
  if (raw === undefined) return null;
  const entries = target?.entries;
  if (!Array.isArray(raw) || !Array.isArray(entries) || raw.length !== entries.length) return undefined;
  // An indexed loop, not `every()`: `Array.prototype.every` SKIPS holes, so a
  // sparse mapping (`['a', , ]`) whose `length` matches `entries` would pass a
  // per-element check that never ran on the hole, and `[...raw]` would then hand
  // `undefined` to the loader as if it were a specifier. Reading every index
  // makes the hole fail the rule above in the doc block, which is the only
  // fail-closed reading of "a hole makes the whole mapping unreadable".
  for (let index = 0; index < raw.length; index += 1) {
    const module = raw[index];
    if (typeof module !== 'string' || module === '') return undefined;
  }
  return raw.slice();
}

/**
 * The module a normalized target declares for one of its entry ids.
 *
 * @param {{ entries?: string[], modules?: unknown }} target Normalized target.
 * @param {string} entryId Entry id known to be in `target.entries`.
 * @returns {string | undefined} The declared module, or `undefined` when the
 *   mapping is absent or unreadable.
 */
export function positionalModule(target, entryId) {
  const modules = targetModules(target);
  if (modules === null || modules === undefined) return undefined;
  const index = (Array.isArray(target?.entries) ? target.entries : []).indexOf(entryId);
  if (index < 0) return undefined;
  return modules[index];
}

/**
 * Re-attach each policy-normalized target's entry-owned `modules` mapping.
 *
 * `normalizeTarget()` deliberately owns only `directory` and `entries`
 * (`policy.js:90-115`), so its output cannot carry `modules`; the entry's
 * `Config` schema is what declares and validates
 * `pluginTargets[].modules` (`src/index.js`, `z.array(z.string())`, positional
 * and one-to-one with `entries`). This joins the two by target directory.
 *
 * Only the *value* is copied across, untouched and unvalidated: positional
 * validation belongs to the arm (`positionalModule()`), so a malformed mapping
 * arrives there intact and is refused instead of being silently repaired or
 * silently dropped.
 *
 * @param {{ pluginTargets?: Array<{ directory: string, entries: string[] }>, testTools?: unknown[], maxStatusBytes?: number, invocationTimeoutMs?: number }} normalized
 *   Policy-normalized config.
 * @param {unknown} raw The admin configuration the entry was mounted with.
 * @returns {object} A new config object; `normalized` is not mutated.
 */
export function reattachModules(normalized, raw) {
  const rawTargets = Array.isArray(raw?.pluginTargets) ? raw.pluginTargets : [];
  const targets = Array.isArray(normalized?.pluginTargets) ? normalized.pluginTargets : [];
  const byDirectory = new Map();
  for (const candidate of rawTargets) {
    const directory = candidate?.directory;
    // Duplicate directories are already a policy error; first wins is enough to
    // keep the join deterministic and never invents a mapping.
    if (typeof directory === 'string' && !byDirectory.has(directory)) byDirectory.set(directory, candidate);
  }
  return {
    ...normalized,
    pluginTargets: targets.map((target) => {
      const original = byDirectory.get(target.directory);
      if (original === undefined || !Object.hasOwn(original, 'modules')) return { ...target };
      return { ...target, modules: original.modules };
    }),
  };
}

/**
 * Probe one loader entry at read time.
 *
 * Resolution failures are reported as `absent` rather than distinguished: an
 * unknown leaf and an unknown parent segment both mean "this driver cannot see
 * the entry", and the loader's own message names a host path this module must
 * not echo.
 *
 * @param {{ resolve?: (id: string) => any } | undefined} loader Live loader, or undefined.
 * @param {string} entryId Configured entry id.
 * @param {string | undefined} module Module specifier the target declares for the entry.
 * @returns {{ id: string, phase: string, module: string, mismatch: boolean, present: boolean }}
 *   A record with no free-form host text.
 */
export function describeEntry(loader, entryId, module) {
  const id = boundedText(entryId, STATUS_LIMITS.maxIdLength);
  const declared = typeof module === 'string' ? boundedText(module, STATUS_LIMITS.maxModuleLength) : '';
  if (loader === null || loader === undefined || typeof loader.resolve !== 'function') {
    return { id, phase: 'unavailable', module: declared, mismatch: false, present: false };
  }
  let entry;
  try {
    entry = loader.resolve(entryId);
  } catch {
    // `EntryTree.resolve()` throws for an unknown id; the message names the id
    // and its parent, so it is swallowed rather than reported.
    return { id, phase: 'absent', module: declared, mismatch: false, present: false };
  }
  if (entry === null || entry === undefined) {
    return { id, phase: 'absent', module: declared, mismatch: false, present: false };
  }
  const liveName = entry?.options?.name;
  const liveModule = typeof liveName === 'string' && liveName !== ''
    ? boundedText(liveName, STATUS_LIMITS.maxModuleLength)
    : '';
  return {
    id,
    phase: entryPhase(entry),
    module: declared,
    // A mismatch is reported, never corrected: the receipt says the live entry
    // is not the declared module, and a mutation against it is refused.
    mismatch: liveModule !== declared,
    present: true,
  };
}

/**
 * Build the sanitized status payload.
 *
 * Rules that keep it safe:
 * - Only configured targets and configured entry ids are listed. The loader tree
 *   is never enumerated, so a status read cannot become an inventory of every
 *   plugin the host happens to load.
 * - The only path present is the canonical test root that the startup probe
 *   already resolved and proved is not the protected production home. The
 *   protected home itself is never part of the projection.
 * - No configuration values, no environment, no foreign tool names.
 *
 * @param {object} input Status inputs.
 * @param {{ armed?: boolean, testRoot?: string, profileName?: string, issues?: Array<{ code?: string }> }} [input.provenance]
 *   Startup probe result.
 * @param {{ pluginTargets?: Array<{ directory: string, entries: string[], modules?: string[] }>, testTools?: Array<{ name: string }> }} [input.config]
 *   Normalized configuration, or an empty stand-in when the driver is unarmed.
 * @param {{ resolve?: Function } | undefined} [input.loader] Live loader, or undefined.
 * @returns {object} Frozen, JSON-safe status with fixed-size fields.
 */
export function buildStatus({ provenance, config, loader }) {
  const armed = provenance?.armed === true;
  const targets = Array.isArray(config?.pluginTargets) ? config.pluginTargets : [];
  const tools = Array.isArray(config?.testTools) ? config.testTools : [];
  const entries = [];

  for (const target of targets) {
    if (entries.length >= STATUS_LIMITS.maxEntries) break;
    const ids = Array.isArray(target.entries) ? target.entries : [];
    // `null` = the target declares no modules; `undefined` = it declares
    // something unreadable. The two are reported differently and neither is
    // guessed: an entry with no declared module cannot be toggled (the helper
    // refuses it), so its status is `undeclared`, and an unreadable mapping is
    // `unreadable` rather than a partially-trusted positional read.
    const modules = targetModules(target);
    for (const [index, entryId] of ids.entries()) {
      if (entries.length >= STATUS_LIMITS.maxEntries) break;
      const record = Array.isArray(modules)
        ? describeEntry(loader, entryId, modules[index])
        : {
          id: boundedText(entryId, STATUS_LIMITS.maxIdLength),
          phase: modules === undefined ? 'unreadable' : 'undeclared',
          module: '',
          mismatch: false,
          present: false,
        };
      entries.push(Object.freeze({ target: boundedText(target.directory, 64), ...record }));
    }
  }

  return Object.freeze({
    ok: true,
    armed,
    provenance: Object.freeze({
      armed,
      ...(typeof provenance?.testRoot === 'string'
        ? { testRoot: boundedText(provenance.testRoot, 200) }
        : {}),
      ...(typeof provenance?.profileName === 'string'
        ? { profileName: boundedText(provenance.profileName, 64) }
        : {}),
      codes: Object.freeze(
        (Array.isArray(provenance?.issues) ? provenance.issues : [])
          .slice(0, 8)
          .map((issue) => boundedText(issue?.code, 64)),
      ),
    }),
    // Configured directories are listed as *names*: `normalizeTarget()` rejects
    // anything containing a separator, so a listed directory cannot be a path.
    targets: Object.freeze(targets.map((target) => Object.freeze({
      directory: boundedText(target.directory, 64),
      entries: Object.freeze(
        (Array.isArray(target.entries) ? target.entries : [])
          .slice(0, STATUS_LIMITS.maxEntries)
          .map((entryId) => boundedText(entryId, STATUS_LIMITS.maxIdLength)),
      ),
    }))),
    entries: Object.freeze(entries),
    tools: Object.freeze(tools.slice(0, STATUS_LIMITS.maxEntries).map((tool) => boundedText(tool.name, 64))),
  });
}

/**
 * Ask the ownership port and flatten its answer to a verdict.
 *
 * The port is the only source of ownership evidence. A throwing port, a missing
 * owner, or any answer other than `{ok:true, owner:<non-empty string>}` denies;
 * nothing here treats a tool *name* as proof of who registered it. The `owner`
 * string is an attestation returned by the injected dependency, not a proof
 * derived from the request, so it is returned for the caller to compare and is
 * never treated as identity on its own.
 *
 * @param {Function} port Trusted ownership port.
 * @param {{ tool: string, entry: string | null, module: string | null, agent: unknown }} request
 *   Ownership question. `entry`/`module` are `null` only when the caller has no
 *   configured entry to claim; `agent` is the handle of the call being attributed.
 * @returns {{ ok: boolean, owner?: string }} The verdict; `owner` is set only on grant.
 */
export function checkOwnership(port, request) {
  let verdict;
  try {
    verdict = port(request);
  } catch {
    return { ok: false };
  }
  if (verdict === null || typeof verdict !== 'object' || verdict.ok !== true) return { ok: false };
  if (typeof verdict.owner !== 'string' || verdict.owner === '') return { ok: false };
  return { ok: true, owner: verdict.owner };
}

/**
 * @typedef {object} OwnershipClaim
 * @property {string} tool Allowlisted tool name under consideration.
 * @property {string | null} entry Configured entry the caller claims owns `tool`.
 * @property {string | null} module Module the configuration declares for `entry`.
 * @property {unknown} agent Owning agent handle of this call.
 */

/**
 * Build the ownership question for one call, or refuse before it is asked.
 *
 * Three things are bound here, and all three are needed by a query that can
 * actually be answered by a real fixture:
 *
 * - **`module`** is the one the *configured tool* declares
 *   (`testTools[].module`, which `policy.normalizeTestTool()` already validates
 *   as a package subpath), not one derived from the claimed entry. The tool's
 *   registration is what ownership is about, so its configured module is the
 *   specifier a provenance source can be matched against.
 * - **`entry`** positions that module in its target: the configuration must
 *   declare a readable, positional module for the claimed entry
 *   ({@link positionalModule}) and it must equal the tool's module. A mismatch
 *   means the claimed entry cannot be the one that registered this tool; an
 *   unreadable or absent mapping means the claim cannot be checked at all.
 *   Both refuse — the query is never asked about an entry that maps to nothing,
 *   and ambiguity is never resolved in the caller's favour.
 * - **`agent`** is the exact caller handle, so the port can attribute the
 *   registration to a caller instead of to a name.
 *
 * `toolSet` is deliberately absent: the native executor offers no such
 * grouping, and inventing one here would be a field the host never supports.
 *
 * This is a *lookup*; whether the delegation holds is decided on the answer
 * (see {@link recheckOwnership}) and re-decided identically inside the helper
 * predicate. Nothing here proves the registration is unchangeable afterwards.
 *
 * @param {{ config: { pluginTargets?: Array<object>, testTools?: Array<object> } }} current Armed state.
 * @param {{ name: string }} allowedTool Tool record from `findAllowedTool()`.
 * @param {unknown} claimedEntry Entry id the caller claimed, if any.
 * @param {unknown} agent Owning agent handle of this call.
 * @returns {{ ok: true, claim: OwnershipClaim } | { ok: false, code: string }}
 *   The claim to ask about, or the fixed refusal code.
 */
export function ownershipClaim(current, allowedTool, claimedEntry, agent) {
  const toolName = allowedTool?.name;
  if (typeof toolName !== 'string' || toolName === '') {
    return { ok: false, code: POLICY_CODES.TOOL_NOT_ALLOWED };
  }
  if (!isAgentHandle(agent)) return { ok: false, code: POLICY_CODES.NO_TURN };
  const declared = allowedTool.module;
  if (typeof declared !== 'string' || declared === '') {
    // The policy refuses such a tool at the arm, so this is a defensive branch.
    return { ok: false, code: DRIVER_CODES.TOOL_OWNERSHIP_UNMAPPABLE };
  }
  if (claimedEntry === undefined || claimedEntry === null) {
    // No entry claimed: the question is still asked (a provenance source may
    // attest a tool without an entry), but with no entry and no entry module.
    return { ok: true, claim: { tool: toolName, entry: null, module: declared, agent } };
  }
  const targets = Array.isArray(current?.config?.pluginTargets) ? current.config.pluginTargets : [];
  const owner = targets.find((target) => (Array.isArray(target?.entries) ? target.entries : []).includes(claimedEntry));
  if (owner === undefined) return { ok: false, code: DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED };
  const module = positionalModule(owner, claimedEntry);
  if (typeof module !== 'string' || module === '') {
    // Absent or malformed positional mapping: the claim cannot be evaluated.
    return { ok: false, code: DRIVER_CODES.TOOL_OWNERSHIP_UNMAPPABLE };
  }
  if (module !== declared) {
    // The claimed entry hosts a different module than the configured tool.
    return { ok: false, code: DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED };
  }
  return { ok: true, claim: { tool: toolName, entry: claimedEntry, module: declared, agent } };
}

/**
 * Ask the ownership port about one claim and re-assert the identity binding on
 * its answer.
 *
 * Two checks ride on one answer, and both must hold:
 * 1. the port attests a non-empty owner;
 * 2. that owner is the *same* string for the same question — a grant that
 *    names a different owner than {@link ownershipClaim} bound denies, because
 *    the delegation would otherwise be an attestation of something else.
 *
 * The last check is a string comparison of two values from the same injected
 * dependency, not an inference from the tool name: it cannot make a
 * non-attestation pass, and it can only narrow a grant.
 *
 * @param {Function} port Trusted ownership port.
 * @param {OwnershipClaim} claim Question to ask.
 * @param {string} expectedOwner Owner string the claim was bound to.
 * @returns {{ ok: boolean, owner?: string }} The verdict.
 */
export function recheckOwnership(port, claim, expectedOwner) {
  const verdict = checkOwnership(port, {
    tool: claim.tool,
    entry: claim.entry,
    module: claim.module,
    agent: claim.agent,
  });
  if (verdict.ok !== true) return { ok: false };
  if (typeof expectedOwner === 'string' && verdict.owner !== expectedOwner) return { ok: false };
  return verdict;
}

/**
 * Whether `entryId` appears in any configured target's entry list.
 *
 * @param {Array<{ entries?: string[] }>} pluginTargets Normalized targets.
 * @param {unknown} entryId Candidate entry id.
 * @returns {boolean} Whether the id is configured.
 */
export function entryIsAllowlisted(pluginTargets, entryId) {
  if (typeof entryId !== 'string' || entryId === '') return false;
  return (Array.isArray(pluginTargets) ? pluginTargets : [])
    .some((target) => (Array.isArray(target.entries) ? target.entries : []).includes(entryId));
}

/**
 * A queue that never serializes on its own.
 *
 * `setEntryEnabled()` expects a `MutationQueue`, but the driver already holds
 * the single exclusive slot for every operation. Handing it a second queue would
 * create two competing locks and a `DRIVER_ENTRY_BUSY` refusal of the driver's
 * own making. This adapter grants the inner slot immediately; exclusivity stays
 * the outer queue's responsibility, and the helper's post-`await()` checks still
 * run.
 *
 * @returns {{ run: (options: object, work: Function) => Promise<any> }} Immediate-grant queue.
 */
export function passthroughQueue() {
  return {
    run(_options, work) {
      return Promise.resolve().then(() => work(Promise.resolve()));
    },
  };
}

/**
 * Reduce a helper outcome to the outward receipt: closed fields only. Helper
 * messages are replaced rather than forwarded, because they can carry entry ids,
 * fiber phases, and plugin internals.
 *
 * @param {unknown} outcome Helper result.
 * @param {'lifecycle' | 'invocation'} kind Which helper produced it.
 * @returns {object} A receipt or refusal.
 */
export function receiptOf(outcome, kind) {
  if (outcome === null || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
    return deny(DRIVER_CODES.UNAVAILABLE);
  }
  if (outcome.ok === false) {
    // The helper's code is preserved so the caller can act on it; its message is
    // not, because `loader-ops` phrases failures with entry ids and phases.
    return {
      ok: false,
      code: boundedText(outcome.code, 64),
      message: kind === 'lifecycle'
        ? 'the loader did not apply the requested change'
        : 'the native executor did not complete the call',
    };
  }
  if (kind === 'lifecycle') {
    const receipt = outcome.receipt ?? {};
    return {
      ok: true,
      kind,
      action: boundedText(receipt.action, 16),
      target: boundedText(receipt.target, 64),
      entry: boundedText(receipt.entry, STATUS_LIMITS.maxIdLength),
      module: boundedText(receipt.module, STATUS_LIMITS.maxModuleLength),
      before: boundedText(receipt.before, 16),
      after: boundedText(receipt.after, 16),
      changed: receipt.changed === true,
      settled: receipt.settled === true,
      // The helper reports persistence as unknown; the driver does not upgrade
      // that into a claim it cannot check.
      persisted: 'unknown',
    };
  }
  return {
    ok: true,
    kind,
    code: boundedText(outcome.code, 64),
    status: boundedText(outcome.status, 120),
  };
}

/**
 * Create the driver core.
 *
 * `ports` is copied and frozen once. A caller (the model) has no way to reach it,
 * and mutating the object passed in cannot swap a port between two calls.
 *
 * @param {object} ports Injected collaborators.
 * @param {{ probe: () => Promise<object> }} ports.provenance Startup arm probe; called once, never from a tool.
 * @param {{ normalize: (raw: unknown) => object }} ports.config Pure config normalizer (`policy.normalizeConfig`).
 * @param {() => any} ports.loader Returns the live loader, or throws when it is absent.
 * @param {(input: object) => Promise<object>} ports.setEntryEnabled `loader-ops.setEntryEnabled`.
 * @param {(options: object) => { invoke: Function, close: Function }} ports.createInvoker `createSingleToolInvoker`.
 * @param {(request: { tool: string, entry: string | null, module: string | null, agent: unknown }) => { ok: boolean, owner?: string }} ports.resolveToolOwnership
 *   Trusted ownership evidence; see the module note in `src/index.js`. It is
 *   answered twice per call with the same question: once before the exclusive
 *   slot and once inside the helper predicate, both through
 *   {@link recheckOwnership}.
 * @param {AbortSignal} [ports.signal] Plugin-lifetime cancellation.
 * @param {Function} [ports.log] Host logger; receives no arguments or output.
 * @param {unknown} [ports.adminConfig] The configuration the entry was mounted with.
 * @returns {object} The frozen core surface.
 */
export function createDriverCore(ports) {
  if (ports === null || typeof ports !== 'object') throw new TypeError('ports must be an object');
  const {
    provenance,
    config: normalize,
    loader,
    setEntryEnabled,
    createInvoker,
    resolveToolOwnership,
    signal,
    log,
    // The configuration the entry was mounted with. The probe describes the host
    // and carries no config of its own, so this is what the core validates.
    adminConfig,
  } = Object.freeze({ ...ports });
  if (typeof provenance?.probe !== 'function') throw new TypeError('ports.provenance.probe must be a function');
  if (typeof normalize !== 'function') throw new TypeError('ports.config.normalize must be a function');
  if (typeof loader !== 'function') throw new TypeError('ports.loader must be a function');
  if (typeof setEntryEnabled !== 'function') throw new TypeError('ports.setEntryEnabled must be a function');
  if (typeof createInvoker !== 'function') throw new TypeError('ports.createInvoker must be a function');
  if (typeof resolveToolOwnership !== 'function') throw new TypeError('ports.resolveToolOwnership must be a function');
  if (signal !== undefined && signal !== null
    && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function')) {
    throw new TypeError('ports.signal must be an AbortSignal when present');
  }

  /** Startup outcome; `undefined` until {@link arm} settles. */
  let armed;
  /** Plugin-lifetime signal. */
  const lifetime = signal ?? new AbortController().signal;
  /**
   * THE exclusive slot. One queue for lifecycle *and* invocation:
   * `MutationQueue.begin()` refuses while an earlier holder has not settled, so a
   * lifecycle mutation can never begin on top of an invocation that may still be
   * running in the isolated host, and vice versa. This is the plugin-wide
   * single-flight the per-call helper deliberately does not provide.
   */
  const queue = new MutationQueue();
  /**
   * Invokers whose invocation has not settled yet, by the agent handle of that
   * call. `dispose()` closes everything still here.
   *
   * This is NOT a cache. `createSingleToolInvoker()` destructures `agent` and
   * `signal` ONCE at construction (`internal/invoke-tool.js:151`) and forwards
   * that same `agent` into `tools.execute({ ..., agent })` on every call
   * (`internal/invoke-tool.js:199`). An invoker therefore belongs to exactly one
   * call: its agent identity and its cancellation are both fixed when it is
   * built. Reusing one across calls would either dispatch a second agent's call
   * under the first agent's identity, or bind a finished call's signal (or a
   * never-aborting placeholder) into the next — the latter silently drops
   * cancellation for every call that follows. A "per-agent" invoker was one of
   * those two bugs whichever way it was wired, so it is created per call, inside
   * the exclusive slot, and removed when the native promise really settles.
   *
   * @type {Set<{ invoke: Function, close: Function }>}
   */
  const liveInvokers = new Set();
  /**
   * Per-call bookkeeping for each tracked invoker: its own gate and itself.
   * Keyed by the invoker object so `closeInvoker()` can release the signal of
   * exactly the call that settled. Nothing here outlives its call: an entry is
   * removed in the same step that closes the invoker.
   *
   * @type {Map<object, { gate: { signal: AbortSignal, dispose: () => void }, created: object }>}
   */
  const tracker = new Map();
  /** Set by {@link dispose}; no operation may proceed afterwards. */
  let closed = false;

  /**
   * Read the live loader without letting a throwing accessor escape.
   *
   * @returns {any} The loader, or undefined when it is unavailable.
   */
  function liveLoader() {
    try {
      return loader() ?? undefined;
    } catch {
      // The entry throws when the injected service is absent; that is a
      // host-unavailable state, not an exception for the model to read.
      return undefined;
    }
  }

  /**
   * Establish startup provenance, then validate configuration through the policy
   * normalizer. Runs at most once per instance; every tool awaits it first.
   *
   * @returns {Promise<{ ok: true, provenance: object, config: object } | { ok: false, code: string, message: string, provenance: object }>}
   *   The settled arm state.
   */
  async function arm() {
    if (armed !== undefined) return armed;
    let probeResult;
    try {
      probeResult = await provenance.probe();
    } catch {
      // A throwing probe is indistinguishable from a failed one for the caller;
      // neither may be reported as armed.
      armed = { ...deny(DRIVER_CODES.NOT_ARMED), provenance: Object.freeze({ armed: false }) };
      return armed;
    }
    if (probeResult?.armed !== true) {
      const firstCode = Array.isArray(probeResult?.issues) && typeof probeResult.issues[0]?.code === 'string'
        ? probeResult.issues[0].code
        : DRIVER_CODES.NOT_ARMED;
      // The specific provenance code is preserved (it is a closed code, not host
      // text) so an operator can tell "not a test host" from "env malformed".
      armed = { ...deny(firstCode), provenance: Object.freeze({ armed: false }) };
      return armed;
    }
    // The probe describes the host and carries no configuration; the entry owns
    // the admin configuration, so it is the fallback rather than the reverse.
    //
    // `normalizeConfig()` validates values but owns only `directory` and
    // `entries` (`policy.js:114`: `normalizeTarget` returns `{ directory, entries }`
    // and drops everything else), so normalizing the admin config alone would
    // DISCARD `pluginTargets[].modules` — the positional mapping this core
    // needs to prove a live entry is the allowlisted one. The policy stays the
    // single validator; its result is re-attached to the entry-owned `modules`
    // read from the raw admin config. Nothing is invented here: a target whose
    // `modules` is absent or malformed simply yields `undefined` at the arm
    // below and is refused.
    const normalized = normalize(adminConfig);
    if (normalized?.ok !== true) {
      armed = {
        ...deny(POLICY_CODES.CONFIG_INVALID),
        provenance: Object.freeze({
          armed: true,
          ...(typeof probeResult.testRoot === 'string' ? { testRoot: probeResult.testRoot } : {}),
        }),
      };
      return armed;
    }
    armed = {
      ok: true,
      provenance: probeResult,
      config: reattachModules(normalized.config, adminConfig),
    };
    return armed;
  }

  /**
   * Current arm state without re-probing.
   *
   * @returns {object} The settled arm state, or a not-ready refusal.
   */
  function state() {
    if (closed) return { ...deny(DRIVER_CODES.UNAVAILABLE), provenance: Object.freeze({ armed: false }) };
    return armed ?? { ...deny(DRIVER_CODES.NOT_READY), provenance: Object.freeze({ armed: false }) };
  }

  /**
   * Run `work` inside the exclusive slot.
   *
   * The slot is released only when `work` settles. `MutationQueue.run()` bounds
   * the *caller's* wait and remembers an unsettled mutation, so a timeout refuses
   * the caller but leaves the slot held until the native operation settles: an
   * invocation is never assumed finished because its caller gave up.
   *
   * @param {string} label Slot label, used only in the queue's internal record.
   * @param {number} timeoutMs Caller-side bound from admin configuration.
   * @param {AbortSignal | undefined} callerSignal Cancel signal for this call.
   * @param {() => Promise<object>} work Operation to run exclusively.
   * @returns {Promise<object>} The operation receipt or a fixed refusal.
   */
  async function exclusive(label, timeoutMs, callerSignal, work) {
    if (closed) return deny(DRIVER_CODES.UNAVAILABLE);
    const effective = callerSignal ?? lifetime;
    // A queued refusal and a refusal produced *by* `work` are different facts and
    // must not be conflated: a busy/timeout/cancelled slot is `DRIVER_BUSY`, while
    // a refusal returned by the operation itself carries its own code
    // (`receiptOf` preserves the helper's code for exactly this reason).
    //
    // `MutationQueue.run()` reports queue refusals as RETURNED values
    // (`loader-ops.js:164` for busy, `:181-186` for timeout/cancel), so the
    // result alone cannot say who produced a refusal. `work` is therefore
    // wrapped: this flag records whether `work` actually ran and what it
    // returned, and only a refusal from outside that wrapper is a slot refusal.
    let workRan = false;
    let workOutcome;
    let outcome;
    try {
      outcome = await queue.run({ entryId: label, timeoutMs, signal: effective }, async (slot) => {
        workRan = true;
        workOutcome = await work(slot);
        return workOutcome;
      });
    } catch {
      // `run()` rethrows only when `work` threw; a refusal is not a throw.
      return deny(DRIVER_CODES.UNAVAILABLE);
    }
    // `work` ran and `run` handed its value back untouched: the operation's own
    // result, including its own refusal code, returns verbatim.
    if (workRan && outcome === workOutcome) return outcome;
    // Otherwise the queue answered without running `work`: busy, timeout, cancel.
    return isRefusal(outcome) ? deny(DRIVER_CODES.BUSY) : deny(DRIVER_CODES.UNAVAILABLE);
  }

  /**
   * Sanitized status.
   *
   * The only tool that does not take the exclusive slot: it mutates nothing and
   * invokes nothing, and blocking a read behind a long invocation would make the
   * driver unobservable exactly when an operator needs to see it.
   *
   * @returns {Promise<object>} The status payload or a fixed refusal.
   */
  async function status() {
    if (closed) return deny(DRIVER_CODES.UNAVAILABLE);
    const current = state();
    try {
      return buildStatus({
        provenance: current.provenance ?? { armed: false },
        // Unarmed: nothing is allowlisted, so the listed set is empty. Reporting
        // a configuration the arm never validated would suggest it is usable.
        config: current.ok === true ? current.config : { pluginTargets: [], testTools: [] },
        loader: current.ok === true ? liveLoader() : undefined,
      });
    } catch {
      return deny(DRIVER_CODES.STATUS_UNAVAILABLE);
    }
  }

  /**
   * Enable or disable one allowlisted loader entry.
   *
   * Request fields and why each is shaped this way:
   * - `plugin`: the configured target *directory name*. `normalizeTarget()`
   *   rejects separators, so no path can be smuggled in here.
   * - `entry`: one of the entry ids the configured target lists.
   * - `enabled`: a boolean. There is no `load(path)` / `unload(name)` form: the
   *   loader can only re-mount what it already knows, and this driver never
   *   creates or removes entries.
   *
   * @param {object} request Model-supplied arguments.
   * @param {unknown} request.plugin Target directory name.
   * @param {unknown} request.entry Entry id.
   * @param {unknown} request.enabled Desired enabled state.
   * @param {object} [exec] Native execution context; `signal` bounds this call.
   * @returns {Promise<object>} The lifecycle receipt or a fixed refusal.
   */
  async function pluginSetEnabled(request, exec) {
    const current = await arm();
    if (current.ok !== true) return refuseFrom(current, DRIVER_CODES.NOT_ARMED);
    const allowed = findAllowedTarget(current.config.pluginTargets, request?.plugin);
    if (allowed.ok !== true) return refuseFrom(allowed, POLICY_CODES.TARGET_NOT_ALLOWED);
    const entryId = request?.entry;
    if (typeof entryId !== 'string' || !allowed.target.entries.includes(entryId)) {
      return deny(POLICY_CODES.TARGET_NOT_ALLOWED);
    }
    if (typeof request?.enabled !== 'boolean') return deny(POLICY_CODES.ARGUMENT_INVALID);

    const module = positionalModule(allowed.target, entryId);
    if (typeof module !== 'string' || module === '') {
      // Without a declared, readable module the live entry cannot be shown to be
      // the allowlisted one, and `loader-ops` refuses to mutate it anyway.
      return deny(DRIVER_CODES.UNAVAILABLE);
    }

    return exclusive(
      `lifecycle:${allowed.target.directory}:${entryId}`,
      current.config.invocationTimeoutMs,
      exec?.signal,
      async () => {
        const live = liveLoader();
        if (live === undefined) return deny(DRIVER_CODES.UNAVAILABLE);
        let outcome;
        try {
          outcome = await setEntryEnabled({
            loader: live,
            queue: passthroughQueue(),
            target: allowed.target.directory,
            entryId,
            module,
            enabled: request.enabled,
            timeoutMs: current.config.invocationTimeoutMs,
            signal: exec?.signal ?? lifetime,
            log,
          });
        } catch {
          return deny(DRIVER_CODES.UNAVAILABLE);
        }
        return receiptOf(outcome, 'lifecycle');
      },
    );
  }

  /**
   * Build the invoker for exactly one call, from that call's own agent and a
   * fresh cancellation gate, and track it until it settles.
   *
   * The helper reads both `agent` and `signal` only at construction
   * (`internal/invoke-tool.js:151`), so everything this call needs is passed
   * here, once, and nothing is shared with any other call. No placeholder and no
   * getter is involved: the signal handed over is the live one for this call,
   * and it is released by {@link closeInvoker} on the settlement path.
   *
   * The second ownership check is built from the SAME {@link OwnershipClaim} the
   * pre-slot check asked about — tool, claimed entry, its positional module and
   * this call's agent — plus the owner string that answer named. Discarding the
   * entry here (asking with `entry: null`) would make the helper's slot-time
   * check a different question from the one that was answered, which is how a
   * call could be admitted for an entry nobody ever attested.
   *
   * @param {{ config: object }} current Armed arm state supplying the allowlist.
   * @param {object} exec Native execution context; supplies the owning agent.
   * @param {OwnershipClaim} claim The exact claim the pre-slot check answered.
   * @param {string} expectedOwner Owner string that answer named.
   * @param {AbortSignal | undefined} lifetimeSignal Plugin-lifetime cancellation.
   * @param {AbortSignal} callerSignal This call's cancellation.
   * @returns {{ invoke: Function, close: Function } | undefined} The invoker, or undefined.
   */
  function openInvoker(current, exec, claim, expectedOwner, lifetimeSignal, callerSignal) {
    if (exec === null || typeof exec !== 'object') return undefined;
    if (claim === null || typeof claim !== 'object' || claim.agent !== exec.agent) return undefined;
    const agent = exec.agent;
    if (!isAgentHandle(agent)) return undefined;
    if (liveInvokers.size >= INVOKER_LIMITS.maxAgents) return undefined;
    // Created before the port, so a throwing `createInvoker` still has its
    // listeners removed by the `catch` below rather than leaking a timer.
    const gate = callSignal(lifetimeSignal, callerSignal, undefined);
    let created;
    try {
      created = createInvoker({
        agent,
        signal: gate.signal,
        allowlist: current.config.testTools.map((tool) => tool.name),
        ownToolNames: OWN_TOOL_NAMES,
        // Second, independent check, asked inside the shared slot: the helper
        // re-validates the name against its own allowlist after this predicate
        // answers, so this cannot replace that check. It asks the identical
        // query and requires the identical owner, so a revocation, or a
        // different attestation, between the two checks denies here.
        isOwnedByAllowedSource: (toolName) => {
          if (typeof toolName !== 'string' || toolName !== claim.tool) return false;
          return recheckOwnership(resolveToolOwnership, claim, expectedOwner).ok;
        },
      });
    } catch {
      gate.dispose();
      return undefined;
    }
    if (created === null || typeof created !== 'object' || typeof created.invoke !== 'function') {
      gate.dispose();
      return undefined;
    }
    liveInvokers.add(created);
    tracker.set(created, { gate, created });
    return created;
  }

  /**
   * Close one invoker, release its per-call signal, and stop tracking it.
   * Idempotent and never throws: closing happens on a settlement path that must
   * not turn a real result into a failure.
   *
   * @param {object} single Tracked invoker returned by {@link openInvoker}.
   * @returns {void}
   */
  function closeInvoker(single) {
    const record = tracker.get(single);
    if (record === undefined) return;
    tracker.delete(single);
    liveInvokers.delete(single);
    try {
      single.close?.();
    } catch {
      // Best effort; the native promise already settled either way.
    } finally {
      record.gate.dispose();
    }
  }

  /**
   * Invoke one allowlisted test tool through the native executor.
   *
   * Order is load-bearing:
   * 1. startup provenance — never a request argument;
   * 2. allowlist membership of the tool;
   * 3. the owning agent and caller signal — an ownership question needs a caller;
   * 4. the claimed entry's membership and its positional module
   *    ({@link ownershipClaim}): an unreadable or mismatched mapping refuses
   *    before the port is asked;
   * 5. trusted ownership evidence for exactly that query — absent it, the call is
   *    refused, and no tool name substitutes for it;
   * 6. the exclusive slot, so an invocation never overlaps a lifecycle change;
   * 7. a per-call invoker built inside that slot from THIS call's agent and a
   *    fresh combined signal, whose predicate re-asks the identical query, closed
   *    only after the native promise settles.
   *
   * Steps 5 and 7 are two checks of one claim, not a proof that the registration
   * cannot change after step 7: the executor resolves the name when it runs.
   *
   * `exec` supplies `agent` and `signal`; both are guaranteed on `ToolRunContext`
   * (`packages/core/tools/src/contracts.ts`, `ToolExecutionInput.agent` /
   * `ToolExecutionInput.signal`). Nothing here invents a dispatch context or a
   * caller signal: an absent or non-object `agent`, or an absent `signal`, is
   * `POLICY_NO_TURN`.
   *
   * @param {object} request Model-supplied arguments.
   * @param {unknown} request.tool Allowlisted tool name.
   * @param {unknown} [request.entry] Configured entry the caller claims owns the tool.
   * @param {unknown} [request.args] Arguments forwarded to the test tool.
   * @param {object} exec Native execution context; `agent` and `signal` are required.
   * @returns {Promise<object>} The invocation receipt or a fixed refusal.
   */
  async function invokeTool(request, exec) {
    const current = await arm();
    if (current.ok !== true) return refuseFrom(current, DRIVER_CODES.NOT_ARMED);
    const allowed = findAllowedTool(current.config.testTools, request?.tool);
    if (allowed.ok !== true) return refuseFrom(allowed, POLICY_CODES.TOOL_NOT_ALLOWED);
    if (OWN_TOOL_NAMES.includes(allowed.tool.name)) return deny(POLICY_CODES.KNOWN_TOOL_TARGET);

    // Agent first: an ownership question about a call with no owning agent is
    // not answerable, so the port must never be asked to reason about one.
    if (exec?.agent === null || exec?.agent === undefined) return deny(POLICY_CODES.NO_TURN);
    if (exec?.signal === null || exec?.signal === undefined) return deny(POLICY_CODES.NO_TURN);
    if (!isAgentHandle(exec.agent)) return deny(POLICY_CODES.NO_TURN);

    // A call that was already cancelled must not dispatch. Without this guard the
    // call still entered the slot, built an invoker, ran the helper all the way
    // into `tools.execute()`, and left `invoke:<tool>` recorded as an UNSETTLED
    // mutation — so one abandoned call blocked every later call with `BUSY` for
    // work nobody wanted. `callSignal()` would forward the abort, but forwarding
    // is not a reason to start the work: the helper checks `signal.aborted` only
    // after it has already built and entered the native batch. The refusal is the
    // pre-existing `BUSY` code (`waitBounded()` already reports an
    // already-aborted signal that way, and `exclusive()` maps it to `BUSY`), so
    // no code is invented or renamed here.
    if (exec.signal.aborted === true) return deny(DRIVER_CODES.BUSY);

    // The claimed entry is checked against the configuration before ownership is
    // consulted, so the ownership port never reasons about an unconfigured
    // entry; the claim also carries the configured tool's module and this call's
    // agent, so the question names everything a real fixture needs to bind.
    const claimed = ownershipClaim(current, allowed.tool, request?.entry, exec.agent);
    if (claimed.ok !== true) return deny(claimed.code);
    const claim = claimed.claim;
    const ownership = recheckOwnership(resolveToolOwnership, claim, undefined);
    if (ownership.ok !== true) return deny(DRIVER_CODES.TOOL_OWNERSHIP_UNVERIFIED);
    const attestedOwner = ownership.owner;

    return exclusive(
      `invoke:${allowed.tool.name}`,
      current.config.invocationTimeoutMs,
      exec.signal,
      async () => {
        let single;
        try {
          single = openInvoker(current, exec, claim, attestedOwner, lifetime, exec.signal);
        } catch {
          return deny(DRIVER_CODES.UNAVAILABLE);
        }
        if (single === undefined) return deny(DRIVER_CODES.UNAVAILABLE);
        let outcome;
        try {
          outcome = await single.invoke(allowed.tool.name, request?.args ?? {});
        } catch {
          outcome = deny(DRIVER_CODES.UNAVAILABLE);
        } finally {
          // Reached only after the native promise settled or threw. The slot is
          // NOT released here beyond what `queue.run()` does for a settled
          // helper: a timeout already left the slot held until this point, which
          // is the honest record that the work may still have been running.
          closeInvoker(single);
        }
        // A refusal built above is already the outward shape; a helper result goes
        // through the closed receipt projection.
        return isRefusal(outcome) ? outcome : receiptOf(outcome, 'invocation');
      },
    );
  }

  /**
   * Dispose the plugin instance.
   *
   * The exclusive slot is deliberately not force-released: `MutationQueue` keeps
   * an unsettled mutation on record, so a reload cannot start a second mutation
   * against an entry whose fate is unknown.
   *
   * Every invocation still in flight is closed, not only the most recent: an
   * invoker belongs to one call, so leaving any open would let a dropped call's
   * executor keep accepting work after unload. `close()` refuses further
   * invocations; it does not cancel the native call already awaiting the host,
   * which stays pending exactly as the in-flight record says.
   *
   * @returns {void}
   */
  function dispose() {
    closed = true;
    const open = [...tracker.values()];
    tracker.clear();
    for (const record of open) {
      // Keep the two structures consistent even if a later reader inspects them.
      liveInvokers.delete(record.created);
      try {
        record.created.close();
      } catch {
        // Closing is best effort; `dispose()` must never throw during unload.
      } finally {
        record.gate.dispose();
      }
    }
  }

  return Object.freeze({
    arm,
    status,
    pluginSetEnabled,
    invokeTool,
    dispose,
    /** Whether `dispose()` ran on this instance. */
    get closed() {
      return closed;
    },
    /** The plugin-wide slot, exposed for tests that assert single-flight. */
    get queue() {
      return queue;
    },
  });
}

