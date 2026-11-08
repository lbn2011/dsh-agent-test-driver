/**
 * Policy: the part that decides "may this happen?" without touching a host.
 *
 * Everything here is pure and synchronous. It takes an already-probed
 * provenance result and an already-parsed configuration, and returns either a
 * plan (what to call on the loader) or a refusal with a code. Keeping the
 * decision out of the effectful service means the allowlist, traversal,
 * production and malformed-input rules can be tested deterministically with no
 * DSH process at all.
 *
 * Deliberate omissions: no filesystem access, no loader access, no tool
 * invocation, no environment reads. A caller that wants any of those gets it
 * from a separate module that first asks this one.
 *
 * @module dsh-agent-test-driver/policy
 */

import { ISOLATION_ENV, PROVENANCE_CODES } from './provenance.js';
import { boundedText } from './internal/redact.js';

/** Host's own tool-name rule (`register()` rejects anything else). */
const HOST_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Loader entry id characters. A contributed row id is prefixed by its own
 * package name and a colon (`<pkg>:<plugin-id>`), so the colon is part of the
 * vocabulary rather than an escape.
 */
const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
/**
 * Package and subpath segments, the conservative subset of npm's rule:
 * lowercase names, plus the usual un-prefixed file extensions step
 * (`.test.js`). The `@` is only legal on the scope, handled separately.
 */
const SUBPATH_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SCOPE_SEGMENT_PATTERN = /^@[a-z0-9][a-z0-9._-]*$/;

/** Tool names the host reserves for itself; a test tool may not shadow them. */
export const RESERVED_TOOL_NAMES = Object.freeze(['run_code']);

/** Closed vocabulary of policy refusal codes. */
export const POLICY_CODES = Object.freeze({
  PROVENANCE: 'POLICY_PROVENANCE',
  CONFIG_INVALID: 'POLICY_CONFIG_INVALID',
  TARGET_NOT_ALLOWED: 'POLICY_TARGET_NOT_ALLOWED',
  TOOL_NOT_ALLOWED: 'POLICY_TOOL_NOT_ALLOWED',
  PATH_ESCAPE: 'POLICY_PATH_ESCAPE',
  PRODUCTION_TARGET: 'POLICY_PRODUCTION_TARGET',
  KNOWN_TOOL_TARGET: 'POLICY_KNOWN_TOOL_TARGET',
  ARGUMENT_INVALID: 'POLICY_ARGUMENT_INVALID',
  NO_TURN: 'POLICY_NO_TURN',
});

/**
 * A refusal. Never thrown across the tool boundary — returned, so the caller
 * sees a receipt instead of an exception that the host might wrap.
 * @typedef {{ ok: false, code: string, message: string }} Refusal
 */

/**
 * Map any thrown value onto a bounded, secret-redacted message.
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return boundedText(text, 200) || 'unknown error';
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Refusal}
 */
export function refuse(code, message) {
  return { ok: false, code, message: boundedText(message, 400) };
}

/**
 * Normalize one allowlisted plugin target from admin configuration.
 *
 * A target is a directory name under the test root plus the loader entry ids
 * that directory contributes. Nothing here accepts a path, a package name or a
 * URL: the admin names a *local directory the admin already placed in the test
 * root*, and the plugin resolves it under that root at use time.
 *
 * @param {unknown} raw
 * @param {number} index Position in the configuration array, for messages.
 * @returns {{ ok: true, target: { directory: string, entries: string[] } } | Refusal}
 */
export function normalizeTarget(raw, index) {
  const where = `pluginTargets[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return refuse(POLICY_CODES.CONFIG_INVALID, `${where} must be an object`);
  }
  const directory = raw.directory;
  if (typeof directory !== 'string' || directory === '') {
    return refuse(POLICY_CODES.CONFIG_INVALID, `${where}.directory is required`);
  }
  if (directory === '.' || directory === '..' || /[\\/\0]/.test(directory) || directory.startsWith('.')) {
    return refuse(POLICY_CODES.PATH_ESCAPE, `${where}.directory must be a single visible directory name under the test root`);
  }
  const entries = raw.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return refuse(POLICY_CODES.CONFIG_INVALID, `${where}.entries must list at least one loader entry id`);
  }
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !ENTRY_ID_PATTERN.test(entry)) {
      return refuse(POLICY_CODES.CONFIG_INVALID, `${where}.entries contains an id that is not a loader entry id`);
    }
    if (seen.has(entry)) return refuse(POLICY_CODES.CONFIG_INVALID, `${where}.entries lists "${entry}" twice`);
    seen.add(entry);
  }
  return { ok: true, target: { directory, entries: [...entries] } };
}

/**
 * Normalize one allowlisted test tool from admin configuration.
 *
 * @param {unknown} raw
 * @param {number} index
 * @returns {{ ok: true, tool: { name: string, module: string, expect: string | null } } | Refusal}
 */
export function normalizeTestTool(raw, index) {
  const where = `testTools[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return refuse(POLICY_CODES.CONFIG_INVALID, `${where} must be an object`);
  }
  const name = raw.name;
  if (typeof name !== 'string' || !HOST_TOOL_NAME_PATTERN.test(name)) {
    return refuse(POLICY_CODES.CONFIG_INVALID, `${where}.name must match the host tool-name rule`);
  }
  if (RESERVED_TOOL_NAMES.includes(name)) {
    return refuse(POLICY_CODES.CONFIG_INVALID, `${where}.name "${name}" is reserved by the host`);
  }
  const module = raw.module;
  if (typeof module !== 'string' || !isSafePackageSubpath(module)) {
    return refuse(
      POLICY_CODES.PATH_ESCAPE,
      `${where}.module must be a package name with an optional relative subpath (no absolute paths, no "..")`,
    );
  }
  const expect = raw.expect ?? null;
  if (expect !== null && (typeof expect !== 'string' || !HOST_TOOL_NAME_PATTERN.test(expect))) {
    return refuse(POLICY_CODES.CONFIG_INVALID, `${where}.expect must be a tool name when present`);
  }
  if (expect !== null && expect !== name) {
    return refuse(
      POLICY_CODES.CONFIG_INVALID,
      `${where}.expect must equal name: a tool is invoked under the name it was registered with`,
    );
  }
  return { ok: true, tool: { name, module, expect } };
}

/**
 * Whether a configured module specifier looks like a package (`pkg` or
 * `pkg/sub/path`), never a filesystem location.
 * @param {string} specifier
 * @returns {boolean}
 */
export function isSafePackageSubpath(specifier) {
  if (specifier === '' || specifier.length > 214) return false;
  if (specifier.includes('\0') || specifier.includes('\\')) return false;
  if (specifier.startsWith('/') || specifier.startsWith('.') || specifier.startsWith('~')) return false;
  if (/^[a-zA-Z]:/.test(specifier) || specifier.includes('://')) return false;
  const segments = specifier.split('/');
  const scoped = segments[0].startsWith('@');
  if (scoped && segments.length < 2) return false;
  const packageSegments = scoped ? segments.slice(0, 2) : segments.slice(0, 1);
  const subSegments = scoped ? segments.slice(2) : segments.slice(1);
  for (const [position, segment] of packageSegments.entries()) {
    const pattern = position === 0 && scoped ? SCOPE_SEGMENT_PATTERN : SUBPATH_SEGMENT_PATTERN;
    if (!pattern.test(segment)) return false;
  }
  for (const segment of subSegments) {
    // A segment starting with "." is the traversal/relative form; later dots
    // are an extension or a version suffix, which package names allow.
    if (!SUBPATH_SEGMENT_PATTERN.test(segment)) return false;
  }
  return subSegments.length === 0 || subSegments.every((segment) => !segment.endsWith('.'));
}

/**
 * Normalize the whole configuration. Any invalid entry invalidates the whole
 * list: a partially-applied allowlist would be a surprising privilege
 * boundary.
 *
 * @param {object} raw
 * @returns {{ ok: true, config: {
 *   pluginTargets: Array<{ directory: string, entries: string[] }>,
 *   testTools: Array<{ name: string, module: string, expect: string | null }>,
 *   maxStatusBytes: number,
 *   invocationTimeoutMs: number,
 * } } | Refusal}
 */
export function normalizeConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return refuse(POLICY_CODES.CONFIG_INVALID, 'config must be an object');
  }
  const targets = [];
  const rawTargets = raw.pluginTargets ?? [];
  if (!Array.isArray(rawTargets)) return refuse(POLICY_CODES.CONFIG_INVALID, 'pluginTargets must be an array');
  const seenDirectories = new Set();
  const seenEntryIds = new Set();
  for (const [index, candidate] of rawTargets.entries()) {
    const normalized = normalizeTarget(candidate, index);
    if (normalized.ok !== true) return normalized;
    const { directory, entries } = normalized.target;
    if (seenDirectories.has(directory)) {
      return refuse(POLICY_CODES.CONFIG_INVALID, `pluginTargets names directory "${directory}" twice`);
    }
    seenDirectories.add(directory);
    for (const entry of entries) {
      if (seenEntryIds.has(entry)) {
        // Two directories claiming one entry id would make "who owns this
        // entry?" ambiguous, and ambiguity here is exactly what an allowlist
        // must not have.
        return refuse(POLICY_CODES.CONFIG_INVALID, `loader entry id "${entry}" is claimed by more than one plugin target`);
      }
      seenEntryIds.add(entry);
    }
    targets.push({ directory, entries });
  }

  const tools = [];
  const rawTools = raw.testTools ?? [];
  if (!Array.isArray(rawTools)) return refuse(POLICY_CODES.CONFIG_INVALID, 'testTools must be an array');
  for (const [index, candidate] of rawTools.entries()) {
    const normalized = normalizeTestTool(candidate, index);
    if (normalized.ok !== true) return normalized;
    if (tools.some((tool) => tool.name === normalized.tool.name)) {
      return refuse(POLICY_CODES.CONFIG_INVALID, `testTools lists "${normalized.tool.name}" twice`);
    }
    tools.push(normalized.tool);
  }

  const maxStatusBytes = raw.maxStatusBytes ?? 8192;
  if (!Number.isSafeInteger(maxStatusBytes) || maxStatusBytes < 512 || maxStatusBytes > 65536) {
    return refuse(POLICY_CODES.CONFIG_INVALID, 'maxStatusBytes must be an integer between 512 and 65536');
  }
  const invocationTimeoutMs = raw.invocationTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(invocationTimeoutMs) || invocationTimeoutMs < 1 || invocationTimeoutMs > 60000) {
    return refuse(POLICY_CODES.CONFIG_INVALID, 'invocationTimeoutMs must be an integer between 1 and 60000');
  }

  return {
    ok: true,
    config: { pluginTargets: targets, testTools: tools, maxStatusBytes, invocationTimeoutMs },
  };
}

/**
 * Gate every state-changing operation.
 *
 * Order is intentional and each step is independently sufficient to refuse:
 * provenance, then configuration, then the answered request. Provenance runs
 * first so that a non-test host never receives a message that depends on its
 * configuration (which a caller could use to probe an unrelated host).
 *
 * @param {object} input
 * @param {Awaited<ReturnType<import('./provenance.js').probeProvenance>>} input.provenance
 * @param {unknown} input.rawConfig Admin configuration as supplied to `apply`.
 * @returns {{ ok: true, config: ReturnType<typeof normalizeConfig> extends { ok: true, config: infer C } ? C : never } | Refusal}
 */
export function gate({ provenance, rawConfig }) {
  if (provenance?.armed !== true) {
    return refuse(POLICY_CODES.PROVENANCE, `isolation provenance is absent (${provenance?.issues?.[0]?.detail ?? 'unknown'})`);
  }
  const normalized = normalizeConfig(rawConfig);
  if (normalized.ok !== true) return normalized;
  return normalized;
}

/**
 * Look up a plugin target the admin allowlisted, by directory name.
 * @param {Array<{ directory: string, entries: string[] }>} targets
 * @param {unknown} requested
 * @returns {{ ok: true, target: { directory: string, entries: string[] } } | Refusal}
 */
export function findAllowedTarget(targets, requested) {
  if (typeof requested !== 'string' || requested === '') {
    return refuse(POLICY_CODES.ARGUMENT_INVALID, 'plugin must be the configured target directory name');
  }
  if (requested.includes('/') || requested.includes('\\') || requested.includes('\0')) {
    return refuse(POLICY_CODES.PATH_ESCAPE, 'plugin must be a bare directory name, not a path');
  }
  const target = targets.find((candidate) => candidate.directory === requested);
  if (target === undefined) {
    return refuse(POLICY_CODES.TARGET_NOT_ALLOWED, `"${boundedText(requested, 64)}" is not an allowlisted plugin target`);
  }
  return { ok: true, target };
}

/**
 * Look up a test tool the admin allowlisted, by registered name.
 * @param {Array<{ name: string, module: string, expect: string | null }>} tools
 * @param {unknown} requested
 * @returns {{ ok: true, tool: { name: string, module: string, expect: string | null } } | Refusal}
 */
export function findAllowedTool(tools, requested) {
  if (typeof requested !== 'string' || requested === '') {
    return refuse(POLICY_CODES.ARGUMENT_INVALID, 'tool must be the registered name of an allowlisted test tool');
  }
  const tool = tools.find((candidate) => candidate.name === requested);
  if (tool === undefined) {
    return refuse(POLICY_CODES.TOOL_NOT_ALLOWED, `"${boundedText(requested, 64)}" is not an allowlisted test tool`);
  }
  return { ok: true, tool };
}

/**
 * Refuse to *drive* one of this plugin's own tools through the driver.
 *
 * Without this, an agent could ask the driver to invoke the driver, turning one
 * call into a chain of calls whose provenance and allowlist were checked once
 * but whose effects multiply.
 *
 * @param {string} toolName
 * @param {readonly string[]} ownToolNames
 * @returns {Refusal | undefined}
 */
export function rejectSelfTarget(toolName, ownToolNames) {
  if (ownToolNames.includes(toolName)) {
    return refuse(POLICY_CODES.KNOWN_TOOL_TARGET, `"${toolName}" is one of this plugin's own tools and cannot be driven`);
  }
  return undefined;
}

/**
 * Validate the free-form argument object for an allowlisted test tool.
 *
 * The shape is fixed: a flat object of string→(string|number|boolean) with
 * bounded counts and lengths. This limits input shape, not sensitivity: even a
 * flat string can contain secrets. Callers must avoid returning raw arguments
 * or tool output, and must select the tool through a separate trusted allowlist.
 *
 * @param {unknown} args
 * @returns {{ ok: true, args: Record<string, string | number | boolean> } | Refusal}
 */
export function validateTestArguments(args) {
  const value = args ?? {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return refuse(POLICY_CODES.ARGUMENT_INVALID, 'args must be a flat object of primitives');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ARGS) {
    return refuse(POLICY_CODES.ARGUMENT_INVALID, `args may have at most ${MAX_ARGS} keys`);
  }
  const out = {};
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      return refuse(POLICY_CODES.ARGUMENT_INVALID, 'argument names must be simple identifiers');
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return refuse(POLICY_CODES.ARGUMENT_INVALID, `argument name "${key}" is not allowed`);
    }
    if (typeof entry === 'string') {
      if (entry.length > MAX_ARG_STRING) {
        return refuse(POLICY_CODES.ARGUMENT_INVALID, `argument "${key}" exceeds ${MAX_ARG_STRING} characters`);
      }
      out[key] = entry;
    } else if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return refuse(POLICY_CODES.ARGUMENT_INVALID, `argument "${key}" must be finite`);
      out[key] = entry;
    } else if (typeof entry === 'boolean') {
      out[key] = entry;
    } else {
      return refuse(POLICY_CODES.ARGUMENT_INVALID, `argument "${key}" must be a string, finite number or boolean`);
    }
  }
  return { ok: true, args: out };
}

/** Maximum flat argument keys accepted for one test-tool invocation. */
export const MAX_ARGS = 16;
/** Maximum length of one string argument. */
export const MAX_ARG_STRING = 1024;

/**
 * Production-profile guard for a resolved target directory.
 *
 * The configured root is already checked at startup, but a directory name
 * inside the root could still be `profiles/web` territory if an admin points
 * the root at a checkout — so the resolved directory is checked again, plus a
 * concrete refusal for a target that contains the live profile or home.
 *
 * @param {string} canonicalDirectory Resolved directory for a configured target.
 * @param {{ home: string, profileDir?: string } | undefined} live
 * @returns {Refusal | undefined}
 */
export function rejectProductionDirectory(canonicalDirectory, live) {
  if (live === undefined) return undefined;
  if (canonicalDirectory === live.home || canonicalDirectory.startsWith(`${live.home}/`)) {
    return refuse(POLICY_PROFILE_ESCAPE, 'the plugin target resolves inside the live harness home');
  }
  if (live.profileDir !== undefined) {
    const profile = live.profileDir;
    if (canonicalDirectory === profile || canonicalDirectory.startsWith(`${profile}/`) || profile.startsWith(`${canonicalDirectory}/`)) {
      return refuse(POLICY_PROFILE_ESCAPE, 'the plugin target overlaps this process\u2019s own live profile');
    }
  }
  return undefined;
}

/** Code used for a target directory that resolves into production state. */
export const POLICY_PROFILE_ESCAPE = PROVENANCE_CODES.PRODUCTION_PROFILE;
