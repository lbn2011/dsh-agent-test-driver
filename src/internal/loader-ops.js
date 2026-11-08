/**
 * The only place in this plugin that changes host state.
 *
 * Scope, deliberately narrow: **enable or disable already-loaded loader
 * entries** that admin configuration allowlisted. It does not `loader.create()`
 * (which would load code the admin never reviewed) and it does not
 * `loader.remove()`.
 *
 * Three properties are enforced here rather than left to callers:
 *
 * 1. **Serialization past the visible change.** `EntryTree.update()`
 *    (`vendor/loader/src/config/tree.ts:98-110`) awaits `entry.update()`, and
 *    `Entry.update()` awaits both `fiber.dispose()` (`entry.ts:139-141`) and
 *    `init()` (`entry.ts:158`). The operation is exclusive until
 *    `loader.await()` (`tree.ts:43-50`) observes no lifecycle tasks left, so a
 *    second mutation never starts on an entry that is still mounting.
 * 2. **Re-read before act.** The entry is resolved from the live tree at the
 *    moment of the change, never from a cached list.
 * 3. **Ownership from the configured id *and* module.** Ids are arbitrary
 *    (`EntryTree.ensureId()`), so an id match alone proves nothing: the live
 *    entry's public id must be the configured id and its `options.name` the
 *    configured module.
 *
 *    The public id is `Entry.id` (`vendor/loader/src/config/entry.ts:67-73`),
 *    not `options.id`. For a root entry the two coincide; for a nested entry the
 *    getter prefixes the owning entry's full id, which is exactly the shape
 *    `EntryTree.resolve()` (`tree.ts:62-73`) traverses, while `options.id` stays
 *    node-local. A configured `include:generated-kit-plugin` therefore has
 *    `options.id === 'generated-kit-plugin'` and
 *    `id === 'include:generated-kit-plugin'`. Ownership is decided by exact
 *    equality against that full public id: no suffix matching, no separator
 *    stripping, and an unreadable public id is a refusal rather than a fallback
 *    to the leaf.
 *
 * A caller timeout bounds only the caller's wait. It does not cancel the
 * mutation, so the queue stays held until the update really settles; while
 * that outstanding mutation is uncertain, new mutations are refused as busy
 * instead of being appended.
 *
 * What this cannot do: make same-process plugin code safe. Enabling a plugin
 * runs its `apply()` in this process with this process's authority.
 *
 * @module dsh-agent-test-driver/internal/loader-ops
 */

import { POLICY_CODES, describeError, refuse } from '../policy.js';

/**
 * Mirror of the host's `FiberState` (`vendor/cordis/src/fiber.ts`), which is a
 * `const enum`: at runtime `fiber.state` is a NUMBER.
 */
export const FIBER_STATE = Object.freeze({
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
});

/** Number → phase name; the single place the numbers are interpreted. */
const STATE_NAMES = Object.freeze({
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: 'disposed',
  [FIBER_STATE.UNLOADING]: 'unloading',
});

/** Phase names the host can report, plus `unknown` for an absent or unrecognized state. */
export const ENTRY_PHASES = Object.freeze([...new Set(Object.values(STATE_NAMES)), 'unknown']);

/**
 * @typedef {{ ok: true, receipt: {
 *   action: 'enable' | 'disable',
 *   target: string,
 *   entry: string,
 *   module: string,
 *   before: string,
 *   after: string,
 *   changed: boolean,
 *   persisted: 'unknown',
 *   settled: boolean,
 * } }} ChangeSuccess
 * @typedef {{ ok: false, code: string, message: string, entry?: string, before?: string }} ChangeRefusal
 */

/**
 * Read one entry's phase name without trusting a cached value.
 *
 * @param {any} entry Loader entry.
 * @returns {string} One of `ENTRY_PHASES`.
 */
export function entryPhase(entry) {
  const state = entry?.fiber?.state;
  if (typeof state !== 'number' || !Object.hasOwn(STATE_NAMES, state)) return 'unknown';
  return STATE_NAMES[state];
}

/**
 * Refuse to touch an entry that is mid-transition.
 *
 * `pending`, `loading` and `unloading` are transient states owned by the
 * loader; `failed` is different: the host already gave up, and teaching a
 * failed plugin off is a legitimate action.
 *
 * @param {string} phase
 * @returns {boolean}
 */
export function phaseIsSettled(phase) {
  return phase === 'active' || phase === 'failed' || phase === 'disposed';
}

/**
 * Serializes loader mutations for this plugin instance.
 *
 * `run(work)` bounds the caller's wait; the exclusive slot is released only
 * when `work` settles, whichever comes first. A settlement that outlives the
 * timeout is remembered as *unsettled*: `begin()` refuses while it is
 * outstanding, so a second mutation can never be issued against an entry whose
 * fate is unknown.
 */
export class MutationQueue {
  /** @type {Promise<void>}
   *  Resolves when no exclusive work remains. */
  #tail = Promise.resolve();
  /** @type {number} */
  #pending = 0;
  /** @type {{ entryId: string, slot: Promise<void> } | undefined} */
  #unsettled;

  /** Mutations currently queued or running. */
  get pending() {
    return this.#pending;
  }

  /** The mutation whose outcome is still unknown, if any. */
  get unsettled() {
    return this.#unsettled === undefined ? undefined : { entryId: this.#unsettled.entryId };
  }

  /**
   * Claim the exclusive slot without waiting.
   * @param {string} entryId
   * @returns {{ settle: () => void, slot: Promise<void> } | ChangeRefusal}
   */
  begin(entryId) {
    if (this.#pending > 0) {
      return {
        ok: false,
        code: 'DRIVER_ENTRY_BUSY',
        message: 'an earlier loader change has not settled yet; retry once it has',
        entry: entryId,
      };
    }
    this.#pending += 1;
    let settle;
    const slot = new Promise((resolve) => {
      settle = resolve;
    });
    this.#tail = slot;
    return { ok: true, settle, slot };
  }

  /**
   * Run `work` exclusively, bounded by `timeoutMs` for the caller only.
   * @template T
   * @param {{ entryId: string, timeoutMs: number, signal?: AbortSignal }} options
   * @param {(slot: Promise<void>) => Promise<T>} work
   * @returns {Promise<T | ChangeRefusal>}
   */
  async run({ entryId, timeoutMs, signal }, work) {
    const claimed = this.begin(entryId);
    if (claimed.ok !== true) return claimed;
    const { settle, slot } = claimed;
    const done = Promise.resolve().then(() => work(slot)).then(
      (value) => { settle(); return value; },
      (error) => { settle(); throw error; },
    ).finally(() => {
      this.#pending -= 1;
      // The real settlement clears the uncertain record, whether or not the
      // caller is still waiting.
      if (this.#unsettled?.slot === slot) this.#unsettled = undefined;
    });
    done.catch(() => {});
    const outcome = await waitBounded(done, timeoutMs, signal);
    if (outcome.kind === 'value') return outcome.value;
    if (outcome.kind === 'error') throw outcome.error;
    if (this.#pending > 0) this.#unsettled = { entryId, slot };
    const reason = outcome.kind === 'aborted' ? 'the request was cancelled' : `it did not settle within ${timeoutMs}ms`;
    return {
      ok: false,
      code: outcome.kind === 'aborted' ? 'DRIVER_CANCELLED' : 'DRIVER_TIMEOUT',
      message: `the loader change for "${entryId}" is still running because ${reason}; its outcome is unknown and further changes are refused until it settles`,
      entry: entryId,
    };
  }
}

/**
 * Race `promise` against a timer and an optional abort signal.
 * @param {Promise<any>} promise
 * @param {number} timeoutMs
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ kind: 'value', value: any } | { kind: 'error', error: unknown } | { kind: 'timeout' } | { kind: 'aborted' }>}
 */
function waitBounded(promise, timeoutMs, signal) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (winner) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(winner);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    timer.unref?.();
    const onAbort = () => finish({ kind: 'aborted' });
    if (signal) {
      if (signal.aborted) finish({ kind: 'aborted' });
      else signal.addEventListener?.('abort', onAbort, { once: true });
    }
    promise.then(
      (value) => finish({ kind: 'value', value }),
      (error) => finish({ kind: 'error', error }),
    );
  });
}

/**
 * Resolve an allowlisted entry id through the live loader tree.
 *
 * `EntryTree.resolve()` (`tree.ts:62-73`) *throws* for an unknown id as well as
 * for an unresolvable parent segment, so a throw is reported as
 * "no such entry", not as a success.
 *
 * @param {any} loader Loader instance (`resolve(id)` from `EntryTree`).
 * @param {string} id Entry id.
 * @returns {{ ok: true, entry: any } | ChangeRefusal}
 */
export function resolveEntry(loader, id) {
  try {
    const entry = loader.resolve(id);
    if (entry === undefined || entry === null) throw new Error(`no entry for ${id}`);
    return { ok: true, entry };
  } catch (error) {
    return {
      ok: false,
      code: POLICY_CODES.CONFIG_INVALID,
      message: `the isolated test host has no loader entry "${id}" (${describeError(error)}); this driver only toggles entries the test host already loaded`,
      entry: id,
    };
  }
}

/**
 * Read the entry's public id — `Entry.id` (`entry.ts:67-73`).
 *
 * The getter dereferences the owning tree to prefix its id, so it can throw for
 * an entry detached from a tree; anything that is not a non-empty string is
 * unreadable. `undefined` is returned instead of falling back to
 * `options.id`, which is a *different* value for every nested entry.
 *
 * @param {any} entry Loader entry.
 * @returns {string | undefined}
 */
function entryPublicIdOf(entry) {
  try {
    const id = entry?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The public id and module the live entry carries; `undefined` when the entry
 * exposes no options object at all.
 *
 * @param {any} entry Loader entry.
 * @returns {{ publicId: string | undefined, name: string | undefined } | undefined}
 */
function entryOptionsOf(entry) {
  const options = entry?.options;
  if (typeof options !== 'object' || options === null) return undefined;
  return {
    publicId: entryPublicIdOf(entry),
    name: typeof options.name === 'string' && options.name !== '' ? options.name : undefined,
  };
}

/**
 * Verify that `entry` is the module the configured target intended: the live
 * public id must equal the configured id and the live module must equal the
 * declared one.
 *
 * The comparison is exact in both directions. Ids are arbitrary
 * (`EntryTree.ensureId()`) and nested ids share their leaf with their siblings,
 * so a suffix match would let `exclude:generated-kit-plugin` pass as
 * `include:generated-kit-plugin`; identifiers that are merely related are
 * therefore refused, not normalized.
 *
 * @param {any} entry Loader entry resolved for the configured id.
 * @param {{ entryId: string, module: string }} expected Configured id and module.
 * @returns {ChangeRefusal | undefined} Refusal when ownership is unproven.
 */
export function checkEntryModule(entry, { entryId, module }) {
  const options = entryOptionsOf(entry);
  if (options === undefined) {
    return refuse(POLICY_CODES.CONFIG_INVALID, `"${entryId}" exposes no readable loader options, so its module cannot be verified; refusing`);
  }
  if (options.publicId === undefined) {
    return refuse(POLICY_CODES.CONFIG_INVALID, `"${entryId}" exposes no readable public entry id, so its identity cannot be verified; refusing`);
  }
  if (options.publicId !== entryId) {
    return refuse(POLICY_CODES.CONFIG_INVALID, `the live entry resolved for "${entryId}" carries id "${options.publicId}"; refusing`);
  }
  if (options.name === undefined) {
    return refuse(POLICY_CODES.CONFIG_INVALID, `"${entryId}" has no module specifier, so the target's intended module is unverified; refusing`);
  }
  if (options.name !== module) {
    return refuse(POLICY_CODES.CONFIG_INVALID, `"${entryId}" loads "${options.name}" but the target declares "${module}"; refusing to toggle another module`);
  }
  return undefined;
}

/**
 * Verify a target's configured ids against the live tree.
 *
 * Only the configured ids are checked, each against its own module; no other
 * entry in the tree is inspected. `modules` is only used when it names one
 * module per entry; otherwise each configured id is checked for readability.
 *
 * @param {any} loader Loader.
 * @param {{ directory: string, entries: string[], modules?: string[] }} target Configured target.
 * @returns {ChangeRefusal | undefined} Refusal when an id is missing or loads another module.
 */
export function checkEntryOwnership(loader, target) {
  const entries = Array.isArray(target?.entries) ? target.entries : [];
  const modules = Array.isArray(target?.modules) ? target.modules : [];
  for (const entryId of entries) {
    const index = entries.indexOf(entryId);
    const found = resolveEntry(loader, entryId);
    if (found.ok !== true) return found;
    const modulesAtId = modules.length === entries.length ? [modules[index]] : modules;
    for (const module of modulesAtId) {
      if (typeof module !== 'string') continue;
      const refusal = checkEntryModule(found.entry, { entryId, module });
      if (refusal !== undefined) return refusal;
    }
  }
  return undefined;
}

/**
 * The effective disabled state, mirroring `Entry.disabled` (`entry.ts:76-95`).
 *
 * A `!!js` expression (`isJsExpr`) is not evaluated here; an unreadable
 * expression is reported as undecidable rather than guessed at.
 *
 * @param {any} entry Loader entry.
 * @returns {boolean | undefined} `undefined` when the state cannot be read.
 */
function entryDisabled(entry) {
  const raw = entry?.options?.disabled;
  if (typeof raw === 'function' || (typeof raw === 'object' && raw !== null && '__jsExpr' in raw)) return undefined;
  return Boolean(raw);
}

/**
 * Whether the requested state is currently in effect.
 *
 * @param {string} phase
 * @param {boolean | undefined} disabled
 * @param {boolean} enable
 * @returns {boolean | undefined} `undefined` when it cannot be decided.
 */
function stateMatches(phase, disabled, enable) {
  // `unknown` is either no fiber (never mounted: disabled) or an
  // unrecognized state, which the caller must not read as success.
  if (enable) return disabled === false && phase === 'active';
  return disabled === true && (phase === 'disposed' || phase === 'unknown');
}

/**
 * Enable or disable one allowlisted loader entry.
 *
 * @param {object} input
 * @param {any} input.loader Loader (`ctx.loader`).
 * @param {MutationQueue} input.queue Serializer owned by the plugin instance.
 * @param {string} input.target Allowlisted directory name (for the receipt).
 * @param {string} input.entryId Allowlisted loader entry id.
 * @param {string} input.module Module specifier the target says this id loads.
 * @param {boolean} input.enabled Desired state; must be a boolean.
 * @param {number} [input.timeoutMs] Bound on the caller's wait, not on the change.
 * @param {AbortSignal} [input.signal]
 * @param {(text: string) => void} [input.log]
 * @returns {Promise<ChangeSuccess | ChangeRefusal>}
 */
export async function setEntryEnabled({ loader, queue, target, entryId, module, enabled, timeoutMs = 10_000, signal, log }) {
  if (typeof loader?.resolve !== 'function' || typeof loader?.update !== 'function' || typeof loader?.await !== 'function') {
    return refuse(POLICY_CODES.CONFIG_INVALID, 'the isolated test host exposes no loader with resolve/update/await');
  }
  if (typeof entryId !== 'string' || entryId === '') {
    return refuse(POLICY_CODES.CONFIG_INVALID, 'entryId must be a non-empty id from the allowlist');
  }
  if (typeof module !== 'string' || module === '') {
    return refuse(POLICY_CODES.CONFIG_INVALID, `no intended module is declared for "${entryId}"; refusing an unverifiable target`);
  }
  if (typeof enabled !== 'boolean') {
    return refuse(POLICY_CODES.CONFIG_INVALID, 'enabled must be true or false');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return refuse(POLICY_CODES.CONFIG_INVALID, 'timeoutMs must be a positive integer');
  }

  const work = async () => {
    const found = resolveEntry(loader, entryId);
    if (found.ok !== true) return found;
    const entry = found.entry;

    const owned = checkEntryModule(entry, { entryId, module });
    if (owned !== undefined) return owned;

    const disabled = entryDisabled(entry);
    if (disabled === undefined) {
      return refuse(POLICY_CODES.CONFIG_INVALID, `"${entryId}" has a dynamic disabled expression; this driver does not evaluate it`);
    }

    const before = entryPhase(entry);
    const hasFiber = entry?.fiber !== undefined && entry?.fiber !== null;
    if (hasFiber && !phaseIsSettled(before)) {
      return {
        ok: false,
        code: 'DRIVER_ENTRY_BUSY',
        message: `"${entryId}" is in phase "${before}" and must settle before it can be toggled`,
        entry: entryId,
        before,
      };
    }
    // No fiber is only valid for an already-disabled entry: enabling an entry
    // the host never mounted would start code the allowlist never saw run.
    if (!hasFiber && !(disabled === true && enabled === false)) {
      return {
        ok: false,
        code: 'DRIVER_ENTRY_BUSY',
        message: `"${entryId}" has no fiber yet; wait for the host to load it before enabling`,
        entry: entryId,
        before,
      };
    }

    if (disabled === !enabled) {
      const matches = stateMatches(before, disabled, enabled);
      return {
        ok: true,
        receipt: {
          action: enabled ? 'enable' : 'disable',
          target,
          entry: entryId,
          module,
          before,
          after: before,
          changed: false,
          persisted: 'unknown',
          settled: matches === true,
        },
      };
    }

    // `true` unmounts the fiber, `false` mounts it: the key is the loader's.
    const failUpdate = (error) => {
      log?.(`loader update failed for ${entryId}: ${describeError(error)}`);
      return {
        ok: false,
        code: 'DRIVER_UPDATE_FAILED',
        message: `the loader rejected the change for "${entryId}"; it is reported generically because the host error may contain plugin internals`,
        entry: entryId,
        before,
      };
    };
    try {
      await loader.update(entryId, { disabled: !enabled });
    } catch (error) {
      return failUpdate(error);
    }
    await loader.await();

    // Verify the same entry object and module, not merely the same id.
    const reread = resolveEntry(loader, entryId);
    if (reread.ok !== true) return reread;
    if (reread.entry !== entry) {
      return refuse(POLICY_CODES.CONFIG_INVALID, `"${entryId}" was replaced while it changed; the new entry is unverified`);
    }
    const stillOurs = checkEntryModule(reread.entry, { entryId, module });
    if (stillOurs !== undefined) return stillOurs;

    const after = entryPhase(reread.entry);
    const nowDisabled = entryDisabled(reread.entry);
    const applied = stateMatches(after, nowDisabled, enabled);
    if (applied !== true) {
      return {
        ok: false,
        code: 'DRIVER_UPDATE_FAILED',
        message: `"${entryId}" settled in phase "${after}" instead of ${enabled ? 'active' : 'disabled'}; the requested state was not applied`,
        entry: entryId,
        before,
      };
    }
    return {
      ok: true,
      receipt: {
        action: enabled ? 'enable' : 'disable',
        target,
        entry: entryId,
        module,
        before,
        after,
        changed: after !== before,
        persisted: 'unknown',
        settled: true,
      },
    };
  };

  return queue.run({ entryId, timeoutMs, signal }, () => work());
}
