/**
 * Trusted fixture binding: pin ONE published `{ entryId, module, definition }`
 * to the exact `ToolDefinition` object a given agent may reach through the
 * native `tools.executable(...)` lookup — never by calling the tool body.
 *
 * Why identity and not the name: `tools.register()` stores the *very*
 * `definition` object (`packages/core/tools/src/index.ts:128-152`) and
 * `executable(name, scope, toolSet)` returns it unchanged
 * (`index.ts:251-254`). A name is only a routing key, so any other layer may
 * register the same name; comparing object identity is the only check that
 * binds this call to the definition the caller published.
 *
 * Known limits, deliberately not papered over:
 * - This is NOT a security boundary against a malicious same-process plugin.
 *   Such a plugin can read this module, call the service directly, or wrap it.
 * - There is NO TOCTOU immunity. A check-then-execute window remains open: an
 *   asynchronous rebind (group toggle, `tools.restrict()`, a disposed layer)
 *   can change what the executor resolves between verification and the native
 *   executor call. A binding minimizes the window; it cannot close it.
 * - The final guard still has to be re-run immediately before handing the call
 *   to the native executor, and owner pipeline/wiring must re-verify there.
 *
 * @module dsh-agent-test-driver/internal/fixture-binding
 */

/** Closed vocabulary of binding outcomes; no host text ever leaves this module. */
export const FIXTURE_CODES = Object.freeze({
  OK: 'FIXTURE_OK',
  UNKNOWN_GENERATION: 'FIXTURE_UNKNOWN_GENERATION',
  MODULE_MISMATCH: 'FIXTURE_MODULE_MISMATCH',
  ENTRY_MISMATCH: 'FIXTURE_ENTRY_MISMATCH',
  IDENTITY_MISMATCH: 'FIXTURE_IDENTITY_MISMATCH',
});

/** Reserved host transport; never bindable or dispatchable. */
const RUN_CODE = 'run_code';

const deny = (code, reason) => Object.freeze({ ok: false, code, reason });
const isText = (value) => typeof value === 'string' && value !== '';

/**
 * Require a non-empty function, throwing on misuse of this module's own API.
 * @param {unknown} value Supplied callback.
 * @param {string} label Parameter name for the error message.
 * @returns {Function} The same callback.
 */
function requireFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

/**
 * Read the declared name from a candidate definition without trusting it.
 * @param {unknown} definition Resolved candidate.
 * @returns {string | undefined} Declared `name`, when it is a non-empty string.
 */
function definitionName(definition) {
  const name = definition !== null && typeof definition === 'object' ? definition.name : undefined;
  return isText(name) ? name : undefined;
}

/**
 * Create one trusted-fixture registry. Generations are monotonic for the life
 * of the instance: publishing again invalidates every earlier generation,
 * including bindings made from one, even when the same objects are republished.
 *
 * @param {object} options
 * @param {{ executable: Function }} options.tools Native tools service (`ctx.tools`).
 * @returns {{
 *   publish: (fixture: { entryId: unknown, module: unknown, definition: unknown }) => { generation: number, revoke: () => void },
 *   verify: (request: { generation: unknown, entryId: unknown, module: unknown, name: unknown, agent: object, toolSet?: unknown }) => Readonly<object>,
 *   close: () => void,
 * }}
 * @throws {TypeError} When the native lookup surface or a fixture is missing.
 */
export function createFixtureBinding(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options must be an object');
  const { tools } = options;
  if (typeof tools?.executable !== 'function') throw new TypeError('tools must expose executable(name, agent, toolSet)');

  /** @type {{ generation: number, entryId: unknown, module: unknown, definition: unknown, revoked: boolean } | undefined} */
  let current;
  let lastGeneration = 0;
  let closed = false;

  /**
   * Publish one fixture for binding. The object identity is what gets pinned;
   * nothing about the definition is copied, wrapped, or executed.
   * @param {{ entryId: unknown, module: unknown, definition: unknown }} fixture
   * @returns {{ generation: number, revoke: () => void }}
   * @throws {TypeError} When closed or the fixture is malformed.
   */
  function publish(fixture) {
    if (closed) throw new TypeError('binding is closed');
    if (fixture === null || typeof fixture !== 'object') throw new TypeError('fixture must be an object');
    const { entryId, module: mod, definition } = fixture;
    if (!isText(entryId)) throw new TypeError('fixture.entryId must be a non-empty string');
    if (!isText(mod)) throw new TypeError('fixture.module must be a non-empty string');
    if (definition === null || typeof definition !== 'object') throw new TypeError('fixture.definition must be an object');
    if (definitionName(definition) === RUN_CODE) throw new TypeError(`"${RUN_CODE}" is a host transport and cannot be bound`);
    lastGeneration += 1;
    const generation = lastGeneration;
    current = { generation, entryId, module: mod, definition, revoked: false };
    const record = current;
    /** Revoke only this generation; revoking a replaced generation is a no-op. */
    const revoke = () => {
      if (current === record) record.revoked = true;
    };
    return Object.freeze({ generation, revoke });
  }

  /**
   * Re-derive what the agent would actually reach and compare it to the pin.
   * Call this immediately before the native executor and treat anything but
   * `ok: true` as a hard refusal; it is not atomic with respect to the call.
   * @param {{ generation: unknown, entryId: unknown, module: unknown, name: unknown,
   *   agent: object, toolSet?: unknown }} request
   * @returns {Readonly<{ ok: boolean, code: string, reason: string, generation: number }>}
   */
  function verify(request) {
    if (request === null || typeof request !== 'object') throw new TypeError('verify request must be an object');
    const { generation, entryId, module: mod, name, agent, toolSet } = request;
    const pinned = current;
    if (closed || pinned === undefined || pinned.revoked || pinned.generation !== generation) {
      return deny(FIXTURE_CODES.UNKNOWN_GENERATION, 'generation is not the live, unrevoked binding');
    }
    // Agent scope decides shadowing; an absent agent cannot be resolved at all.
    if (agent === null || typeof agent !== 'object') return deny(FIXTURE_CODES.IDENTITY_MISMATCH, 'no agent scope to resolve against');
    if (!isText(mod) || mod !== pinned.module) return deny(FIXTURE_CODES.MODULE_MISMATCH, 'module does not match the bound module');
    if (!isText(entryId) || entryId !== pinned.entryId) return deny(FIXTURE_CODES.ENTRY_MISMATCH, 'entry does not match the bound entry');
    if (!isText(name) || name !== definitionName(pinned.definition) || name === RUN_CODE) {
      return deny(FIXTURE_CODES.IDENTITY_MISMATCH, 'name does not match the bound definition');
    }
    let resolved;
    try {
      // `toolSet` is the step admission set: when supplied it decides, otherwise
      // `undefined` keeps the call outside a model step (index.ts:251-254).
      resolved = toolSet === undefined
        ? tools.executable(name, agent)
        : tools.executable(name, agent, toolSet);
    } catch {
      return deny(FIXTURE_CODES.IDENTITY_MISMATCH, 'executable lookup failed');
    }
    if (resolved !== pinned.definition) {
      return deny(FIXTURE_CODES.IDENTITY_MISMATCH, 'agent resolves a different definition object');
    }
    return Object.freeze({ ok: true, code: FIXTURE_CODES.OK, reason: 'exact identity', generation: pinned.generation });
  }

  /** Refuse all further publishes and verifications; does not touch the host. */
  function close() {
    closed = true;
  }

  return Object.freeze({ publish, verify, close });
}
