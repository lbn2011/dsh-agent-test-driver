import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INVOKE_CODES, createSingleToolInvoker } from '../src/internal/invoke-tool.js';

// The fake below is an explicit MOCK of `ctx.tools.execute`. It reproduces ONLY
// the calling surface this helper depends on:
//   - `executor.ts:19-34` ToolBatchInput: { calls, signal, agent, maxParallelToolCalls }
//   - `executor.ts:57-61` ToolBatchResult: { results, additionalContexts, concluded }
//   - `contracts.ts:328-346` success carries value, failure carries error; both carry content.
// It enforces NO policy, NO allowlist and NO ownership. Every denial asserted
// here is produced by the helper before the fake is reached — none of these
// tests demonstrate that the real host would deny anything.

/** Owning agent stand-in; the helper only requires a non-null object identity. */
const AGENT = Object.freeze({ id: 'test-agent' });

/**
 * Build a fake native executor.
 * @param {object} [options]
 * @param {boolean} [options.error] Construct a ToolExecutionFailure instead of a success.
 * @param {string} [options.failureCode] Host error code for the failure.
 * @param {Promise<void>} [options.gate] Settle only after this resolves (deferred drain).
 * @param {'success' | 'reject'} [options.mode] Resolve a batch or reject like ToolBatchExecutionError.
 * @param {unknown} [options.value] Canonical value on success.
 */
function fakeExecutor({ error = false, failureCode = 'HOST_TOOL_ERROR', gate, mode = 'success', value = { ok: true } } = {}) {
  const calls = [];
  return {
    calls,
    async execute(input) {
      calls.push(input);
      if (gate !== undefined) await gate;
      if (mode === 'reject') throw new Error('Tool batch execution failed');
      const [block] = input.calls;
      const content = [{ type: 'text', text: 'raw tool content that must not leak' }];
      const result = error
        ? { isError: true, error: { code: failureCode, message: 'secret-bearing host message' }, content }
        : { isError: false, value, content };
      return { results: [{ callId: block.id, result }], additionalContexts: [], concluded: false };
    },
  };
}

/** Standard startup configuration; each test overrides only what it exercises. */
function invoker(overrides = {}) {
  return createSingleToolInvoker({
    tools: fakeExecutor(),
    agent: AGENT,
    signal: new AbortController().signal,
    allowlist: ['probe_echo'],
    ownToolNames: ['driver.invoke_tool'],
    isOwnedByAllowedSource: () => true,
    ...overrides,
  });
}

test('receipts omit callback exceptions, unknown names and arbitrary host error codes', async () => {
  const secret = 'sensitive-marker-DO-NOT-RETURN';
  const denied = await invoker({ isOwnedByAllowedSource: () => { throw new Error(secret); } }).invoke('probe_echo', {});
  assert.equal(denied.ok, false);
  assert.equal(JSON.stringify(denied).includes(secret), false);
  const unknown = await invoker().invoke(secret, {});
  assert.equal(JSON.stringify(unknown).includes(secret), false);
  const failed = await invoker({ tools: fakeExecutor({ error: true, failureCode: secret }) }).invoke('probe_echo', {});
  assert.equal(failed.code, INVOKE_CODES.TOOL_ERROR);
  assert.equal(JSON.stringify(failed).includes(secret), false);
});

test('invokes through the native executor with the owning agent and one call', async () => {
  const tools = fakeExecutor();
  const signal = new AbortController().signal;
  const run = invoker({ tools, signal });

  const verdict = await run.invoke('probe_echo', { text: 'hello', times: 2 });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, INVOKE_CODES.OK);
  assert.equal(tools.calls.length, 1);
  const [input] = tools.calls;
  assert.equal(input.agent, AGENT);
  // The batch gets a derived signal, so caller cancellation can be forwarded
  // without the helper ever aborting the caller's own controller.
  assert.equal(input.signal instanceof AbortSignal, true);
  assert.notEqual(input.signal, signal);
  assert.equal(input.maxParallelToolCalls, 1);
  assert.equal(input.calls.length, 1);
  const [block] = input.calls;
  assert.equal(block.type, 'tool-call');
  assert.equal(block.name, 'probe_echo');
  assert.deepEqual(JSON.parse(block.arguments), { text: 'hello', times: 2 });
  assert.match(block.id, /^invoke-/);
});

test('reports a sanitized success without the raw value or content', async () => {
  const run = invoker({ tools: fakeExecutor({ value: { secret: 'sk-live-abcdefghijkl' } }) });
  const verdict = await run.invoke('probe_echo', {});
  assert.equal(verdict.ok, true);
  assert.equal(JSON.stringify(verdict).includes('sk-live'), false);
  assert.equal(JSON.stringify(verdict).includes('raw tool content'), false);
  assert.deepEqual(Object.keys(verdict).sort(), ['code', 'ok', 'status']);
});

test('maps a native failure to a bounded status without the host message', async () => {
  const run = invoker({ tools: fakeExecutor({ error: true, failureCode: 'ARGS_REJECTED' }) });
  const verdict = await run.invoke('probe_echo', {});
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, INVOKE_CODES.TOOL_ERROR);
  assert.equal(verdict.status, 'tool failed: tool-error');
  assert.equal(verdict.status.includes('ARGS_REJECTED'), false);
  assert.equal(verdict.status.includes('secret-bearing'), false);
});

test('denies without the owning agent instead of calling the executor', async () => {
  const tools = fakeExecutor();
  const run = createSingleToolInvoker({
    tools,
    agent: undefined,
    signal: new AbortController().signal,
    allowlist: ['probe_echo'],
    isOwnedByAllowedSource: () => true,
  });
  const verdict = await run.invoke('probe_echo', {});
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, INVOKE_CODES.DENIED);
  assert.equal(tools.calls.length, 0);
});

test('rejects an empty or malformed startup allowlist', () => {
  assert.throws(() => invoker({ allowlist: [] }), TypeError);
  assert.throws(() => invoker({ allowlist: [''] }), TypeError);
  assert.throws(() => invoker({ allowlist: 'probe_echo' }), TypeError);
});

test('denies a request name outside the startup allowlist without calling the executor', async () => {
  const tools = fakeExecutor();
  const run = invoker({ tools });
  for (const name of ['probe_write', '', '../probe_echo', 'probe_echo2']) {
    const verdict = await run.invoke(name, {});
    assert.equal(verdict.ok, false, `expected denial for ${name}`);
    assert.equal(verdict.code, INVOKE_CODES.DENIED);
  }
  assert.equal(tools.calls.length, 0);
});

test('denies run_code and this plugin\'s own tools even when allowlisted', async () => {
  const tools = fakeExecutor();
  const run = invoker({ tools, allowlist: ['run_code', 'driver.invoke_tool'], ownToolNames: ['driver.invoke_tool'] });
  assert.equal((await run.invoke('run_code', {})).code, INVOKE_CODES.DENIED);
  assert.equal((await run.invoke('driver.invoke_tool', {})).code, INVOKE_CODES.DENIED);
  assert.equal(tools.calls.length, 0);
});

test('denies nested arguments that the flat argument policy rejects', async () => {
  const tools = fakeExecutor();
  const run = invoker({ tools });
  for (const args of [{ nested: { deeper: true } }, JSON.parse('{"__proto__":"x"}'), [], 'text', { big: 'x'.repeat(2048) }]) {
    const verdict = await run.invoke('probe_echo', args);
    assert.equal(verdict.ok, false, `expected denial for ${JSON.stringify(args)}`);
  }
  assert.equal(tools.calls.length, 0);
});

test('requires injected ownership evidence and denies when it is absent, false or throws', async () => {
  assert.throws(() => invoker({ isOwnedByAllowedSource: undefined }), TypeError);
  for (const predicate of [() => false, () => undefined, () => { throw new Error('no registry'); }]) {
    const tools = fakeExecutor();
    const run = invoker({ tools, isOwnedByAllowedSource: predicate });
    const verdict = await run.invoke('probe_echo', {});
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, INVOKE_CODES.DENIED);
    assert.equal(tools.calls.length, 0);
  }
});

test('rejects a second call while one is in flight and releases only after settlement', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tools = fakeExecutor({ gate });
  const run = invoker({ tools });
  const first = run.invoke('probe_echo', {});
  const second = await run.invoke('probe_echo', {});
  assert.equal(second.ok, false);
  assert.equal(tools.calls.length, 1, 'the concurrent call must not reach the executor');

  release();
  assert.equal((await first).ok, true);
  assert.equal((await run.invoke('probe_echo', {})).ok, true);
  assert.equal(tools.calls.length, 2);
});

test('keeps the caller pending until the native executor drains, even after abort', async () => {
  const controller = new AbortController();
  const gate = new Promise(() => {});
  const tools = fakeExecutor({ gate });
  const run = invoker({ tools, signal: controller.signal });

  let settled = false;
  const pending = run.invoke('probe_echo', {}).finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false, 'helper must not resolve while host work is running');
  assert.equal(tools.calls[0].signal.aborted, true, 'caller abort was forwarded into the batch');

  // A cooperative host would now settle; this fake never does, and the helper
  // is still single-flight because the first call has not settled.
  const second = await run.invoke('probe_echo', {});
  assert.equal(second.ok, false);
  void pending;
});

test('a cooperative abort settles through the executor and reports cancellation', async () => {
  const controller = new AbortController();
  const tools = {
    calls: [],
    async execute(input) {
      tools.calls.push(input);
      await new Promise((resolve) => input.signal.addEventListener('abort', resolve, { once: true }));
      return {
        results: [{ callId: input.calls[0].id, result: { isError: true, error: { code: 'TOOL_ABORTED' }, content: [] } }],
        additionalContexts: [],
        concluded: false,
      };
    },
  };
  const run = invoker({ tools, signal: controller.signal });
  const pending = run.invoke('probe_echo', {});
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const verdict = await pending;
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, INVOKE_CODES.CANCELLED);
});

test('denies before dispatch when the caller signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const tools = fakeExecutor();
  const run = invoker({ tools, signal: controller.signal });
  assert.equal((await run.invoke('probe_echo', {})).code, INVOKE_CODES.DENIED);
  assert.equal(tools.calls.length, 0);
});

test('cooperative deadline aborts the batch and clears its timer', async () => {
  const tools = {
    calls: [],
    async execute(input) {
      tools.calls.push(input);
      await new Promise((resolve) => input.signal.addEventListener('abort', resolve, { once: true }));
      return { results: [{ callId: input.calls[0].id, result: { isError: true, error: { code: 'TOOL_ABORTED' }, content: [] } }], additionalContexts: [], concluded: false };
    },
  };
  const run = invoker({ tools, deadlineMs: 5 });
  const verdict = await run.invoke('probe_echo', {});
  assert.equal(verdict.code, INVOKE_CODES.CANCELLED);
});

test('an internal executor rejection becomes a generic error code', async () => {
  const run = invoker({ tools: fakeExecutor({ mode: 'reject' }) });
  const verdict = await run.invoke('probe_echo', {});
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, INVOKE_CODES.INTERNAL_ERROR);
  assert.equal(verdict.status.includes('batch execution failed'), false);
});

test('a batch without a matching call id is an internal error, not a success', async () => {
  const tools = { calls: [], async execute() { return { results: [], additionalContexts: [], concluded: false }; } };
  const run = invoker({ tools });
  assert.equal((await run.invoke('probe_echo', {})).code, INVOKE_CODES.INTERNAL_ERROR);
});

test('close refuses further calls without cancelling work already awaiting the host', async () => {
  const tools = fakeExecutor();
  const run = invoker({ tools });
  run.close();
  assert.equal((await run.invoke('probe_echo', {})).code, INVOKE_CODES.DENIED);
  assert.equal(tools.calls.length, 0);
});
