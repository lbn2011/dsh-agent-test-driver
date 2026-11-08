/**
 * Invoke exactly one startup-allowlisted, harmless test tool through the native
 * executor — never by calling a `ToolDefinition.execute` directly.
 *
 * Why the executor and not the definition: a definition is the tool's own body.
 * Calling it skips policy listeners, guards, argument snapshots, result
 * projection and logging. `ctx.tools.execute({ calls, signal, agent, ... })`
 * (`packages/core/tools/src/executor.ts:19-48`) is the only surface that gives
 * the call its owning Agent, applies the host's policy chain, and returns the
 * model-shaped `results: [{ callId, result: { isError, value | error, content } }]`
 * (`executor.ts:50-61`, `contracts.ts:346`).
 *
 * What this module does NOT establish: that the named tool is the *intended*
 * tool. A tool name is not an identity — a different plugin can register the
 * same name, or replace the registration between startup and the call. Nothing
 * here can prove ownership of a live registration. Whoever wires this helper
 * must supply `isOwnedByAllowedSource`, a trusted predicate standing for real
 * foreign-agent ownership evidence, and must get `undefined` back on doubt.
 *
 * Also absent: hard termination. `AbortController` is cooperative; the native
 * executor "never settle[s] while started work is still running"
 * (`executor.ts:79-80`). A host that ignores the signal keeps this promise
 * pending forever, by design. A wall-clock limit belongs to the process that
 * can kill it, not to this function.
 *
 * @module dsh-agent-test-driver/internal/invoke-tool
 */

import { RESERVED_TOOL_NAMES, refuse, validateTestArguments } from '../policy.js';
import { boundedText, positiveInteger } from './redact.js';

/** Closed vocabulary of reported outcomes; refusals are always `DENIED`. */
export const INVOKE_CODES = Object.freeze({
  DENIED: 'INVOKE_DENIED',
  CANCELLED: 'INVOKE_CANCELLED',
  OK: 'INVOKE_OK',
  TOOL_ERROR: 'INVOKE_TOOL_ERROR',
  INTERNAL_ERROR: 'INVOKE_INTERNAL_ERROR',
});

/** Reserved host transport name; never callable through this helper. */
const RUN_CODE = 'run_code';
/** Default bound on one returned status string. */
const DEFAULT_STATUS_LENGTH = 120;

/**
 * Flatten a tool result to its `isError`/`value`/`error` discriminant without
 * reading `content`, `meta`, or any other content-bearing field.
 *
 * `value` is inspected only for liveness: `content` carries the same text, and
 * the caller may have projected it. Everything else is dropped on purpose.
 *
 * @param {unknown} result One native `ToolExecutionResult`.
 * @returns {{ ok: boolean, error: string | null }} Sanitized verdict.
 */
function inspectResult(result) {
  if (result === null || typeof result !== 'object') return { ok: false, error: 'malformed' };
  if (result.isError === false) {
    return result.value === undefined ? { ok: false, error: 'no-value' } : { ok: true, error: null };
  }
  if (result.isError !== true) return { ok: false, error: 'malformed' };
  // Host/plugin error codes are not a trusted closed vocabulary.
  return { ok: false, error: 'tool-error' };
}

/**
 * Validate the request half: the requested tool name and its flat arguments.
 * Startup policy (allowlist, ownership) is deliberately elsewhere.
 *
 * @param {string} toolName Requested tool name; must appear in the allowlist.
 * @param {unknown} args Flat primitive argument object.
 * @param {{ allowlist: ReadonlySet<string>, ownToolNames: readonly string[] }} config
 * @returns {ReturnType<typeof refuse> | { ok: true, name: string, callArgs: Record<string, unknown> }}
 */
function validateRequest(toolName, args, config) {
  if (typeof toolName !== 'string' || toolName === '') {
    return refuse(INVOKE_CODES.DENIED, 'tool must be the registered name of one allowlisted test tool');
  }
  if (toolName === RUN_CODE || RESERVED_TOOL_NAMES.includes(toolName)) {
    return refuse(INVOKE_CODES.DENIED, `"${toolName}" is a host transport and cannot be driven`);
  }
  if (config.ownToolNames.includes(toolName)) {
    return refuse(INVOKE_CODES.DENIED, `"${toolName}" is one of this plugin's own tools and cannot be driven`);
  }
  if (!config.allowlist.has(toolName)) {
    return refuse(INVOKE_CODES.DENIED, `"${boundedText(toolName, 64)}" is not an allowlisted test tool`);
  }
  const checked = validateTestArguments(args);
  if (!checked.ok) return refuse(INVOKE_CODES.DENIED, 'arguments were rejected by the argument policy');
  return { ok: true, name: toolName, callArgs: checked.args };
}

/**
 * Assess the startup-supplied ownership evidence. A missing, throwing or
 * falsy answer is a denial, because the caller could not name an allowed owner
 * for this exact call; it is not evidence that the tool is safe.
 *
 * @param {unknown} predicate Injected predicate; must be a function.
 * @param {string} name Tool name under consideration.
 * @returns {{ ok: boolean, reason: string }}
 */
function checkOwnership(predicate, name) {
  if (typeof predicate !== 'function') return { ok: false, reason: 'no-ownership-evidence' };
  let verdict;
  try {
    verdict = predicate(name);
  } catch {
    return { ok: false, reason: 'ownership-denied' };
  }
  return verdict === true ? { ok: true, reason: 'attested' } : { ok: false, reason: 'ownership-denied' };
}

/**
 * Build the executor's single-call batch. The call id is generated here, not
 * taken from the request, so a caller cannot correlate or spoof host ids.
 *
 * @param {string} name Tool name.
 * @param {Record<string, unknown>} callArgs Validated flat arguments.
 * @returns {Readonly<{ type: 'tool-call', id: string, name: string, arguments: string }>}
 */
function toolCallBlock(name, callArgs) {
  const id = `invoke-${globalThis.crypto.randomUUID()}`;
  return Object.freeze({ type: 'tool-call', id, name, arguments: JSON.stringify(callArgs) });
}

/**
 * Create one single-flight invoker over a given native executor surface.
 *
 * Single-flight is per instance: a second call while one is running is refused
 * rather than queued, so two drivers never overlap inside one host tool call.
 * The in-flight flag is released only when the executor promise actually
 * settles — an aborted request that the host refuses to drain stays "in flight",
 * which is truthful: work may still be running.
 *
 * @param {object} options
 * @param {{ execute: Function }} options.tools Native tools service (`ctx.tools`).
 * @param {object} options.agent Owning Agent; required by the executor for scope and context.
 * @param {AbortSignal} options.signal Caller cancellation; observed, not enforced.
 * @param {ReadonlyArray<string>} options.allowlist Startup tool names; never from the request.
 * @param {ReadonlyArray<string>} [options.ownToolNames] This plugin's tools (recursion denial).
 * @param {(name: string) => boolean | undefined} options.isOwnedByAllowedSource
 *   Trusted predicate attesting registration ownership; `true` only with evidence.
 * @param {number} [options.deadlineMs] Cooperative timer that aborts `signal`.
 * @param {number} [options.maxStatusLength] Bound on returned status text.
 * @returns {{ invoke: (toolName: string, args: unknown) => Promise<object>, close: () => void }}
 *   `invoke` resolves to `{ ok, code, status }`; it never rejects for denials.
 * @throws {TypeError} When startup configuration is missing or malformed.
 */
export function createSingleToolInvoker(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options must be an object');
  const { tools, agent, signal, allowlist, ownToolNames = [], isOwnedByAllowedSource, deadlineMs } = options;
  if (!Array.isArray(allowlist) || allowlist.length === 0) throw new TypeError('allowlist must be a non-empty array');
  if (!allowlist.every((name) => typeof name === 'string' && name !== '')) throw new TypeError('allowlist entries must be non-empty strings');
  if (!Array.isArray(ownToolNames)) throw new TypeError('ownToolNames must be an array');
  if (typeof isOwnedByAllowedSource !== 'function') throw new TypeError('isOwnedByAllowedSource must be a function');
  if (typeof tools?.execute !== 'function') throw new TypeError('tools must be the native tools service (ctx.tools)');
  if (signal === null || typeof signal !== 'object' || typeof signal.addEventListener !== 'function') {
    throw new TypeError('signal must be an AbortSignal');
  }
  const maxStatusLength = positiveInteger(options.maxStatusLength ?? DEFAULT_STATUS_LENGTH, 'maxStatusLength');
  const deadline = deadlineMs === undefined ? undefined : positiveInteger(deadlineMs, 'deadlineMs');
  const allowed = new Set(allowlist);
  const own = Object.freeze([...ownToolNames]);
  let inFlight = false;
  let closed = false;

  const report = (ok, code, text) => Object.freeze({ ok, code, status: boundedText(text, maxStatusLength) });
  const deny = (reason) => report(false, INVOKE_CODES.DENIED, reason);

  /**
   * Invoke one allowlisted tool and resolve to a generic, bounded verdict.
   * @param {string} toolName
   * @param {unknown} args
   * @returns {Promise<{ ok: boolean, code: string, status: string }>}
   */
  async function invoke(toolName, args) {
    if (agent === null || typeof agent !== 'object') return deny('owning agent is required');
    if (closed) return deny('invoker is closed');
    if (inFlight) return deny('another invocation is already in flight');
    if (signal.aborted) return deny('the request was already cancelled');
    const request = validateRequest(toolName, args, { allowlist: allowed, ownToolNames: own });
    // Requested names can also carry sensitive text; keep outward denials fixed.
    if (!request.ok) return deny('request rejected by invocation policy');
    const ownership = checkOwnership(isOwnedByAllowedSource, request.name);
    if (!ownership.ok) return deny(ownership.reason);
    const block = toolCallBlock(request.name, request.callArgs);

    inFlight = true;
    const local = new AbortController();
    /** Forward (never manufacture) caller cancellation into the native batch. */
    const forward = () => local.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true });
    let timer;
    if (deadline !== undefined) {
      // Only asks the host to stop; the await below still waits for its drain.
      timer = setTimeout(() => local.abort(new Error('invocation deadline elapsed')), deadline);
    }
    try {
      const batch = await tools.execute({ calls: [block], signal: local.signal, agent, maxParallelToolCalls: 1 });
      const results = batch !== null && typeof batch === 'object' ? batch.results : undefined;
      const entry = Array.isArray(results) ? results.find((item) => item?.callId === block.id) : undefined;
      if (entry === undefined) return report(false, INVOKE_CODES.INTERNAL_ERROR, 'no result matched the call');
      const verdict = inspectResult(entry.result);
      if (verdict.ok) return report(true, INVOKE_CODES.OK, 'tool completed');
      if (local.signal.aborted) return report(false, INVOKE_CODES.CANCELLED, 'request cancelled; no status reported');
      return report(false, INVOKE_CODES.TOOL_ERROR, `tool failed: ${verdict.error}`);
    } catch {
      // Internal failures (including a drained ToolBatchExecutionError) carry
      // host text that may include arguments or session ids; report the class only.
      if (local.signal.aborted) return report(false, INVOKE_CODES.CANCELLED, 'executor failed after cancellation');
      return report(false, INVOKE_CODES.INTERNAL_ERROR, 'executor failed: internal');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', forward);
      // Reached only after the executor promise settled or threw.
      inFlight = false;
    }
  }

  /** Refuse further invocations; does not cancel work already awaiting the host. */
  function close() {
    closed = true;
  }

  return Object.freeze({ invoke, close });
}
