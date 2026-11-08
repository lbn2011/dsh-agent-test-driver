/**
 * Isolation provenance: proving that this process is a test DSH *before* any
 * tool argument is believed.
 *
 * The threat this file addresses: the requester is the model, and the model can
 * write arguments. If "is this an isolated test host?" were an argument, the
 * answer would always be "yes". So provenance is read from startup-owned facts
 * only — the launcher's `profileContext`, the process environment, the
 * already-mounted loader tree — and the tool layer has no input through which a
 * caller could assert it.
 *
 * What this file does NOT claim: a security sandbox. The launcher is trusted
 * and everything runs in one process, so code running beside this module can
 * tamper with these checks. Provenance stops a *model* from asserting identity;
 * it does not stop the process from lying to itself.
 *
 * Two things must hold before the changing tools are exposed (`armed`):
 *
 * 1. An explicit switch — admin-set `DSH_AGENT_TEST_DRIVER=1`.
 * 2. The startup `ctx.profileContext` names an isolated home/profile that is
 *    canonically contained in the admin-configured test root, and a root marker
 *    that records that same canonical root. This binds *this* profile to the
 *    test root: an unrelated root with a plausible marker is not a grant.
 *
 * A separate notion, `protectedHome`, names the *production* home this host must
 * never be confused with. It comes from one place only: the trusted launcher
 * variable `PROTECTED_HOME_ENV` (`DSH_AGENT_TEST_PROTECTED_HOME`). It is
 * deliberately NOT `DSH_HOME`: an isolated host legitimately points `DSH_HOME`
 * at its own home *inside* the test tree, so reading that variable would make
 * the test root overlap itself. "The current home is inside the test root" is
 * the expected, required state; "the protected home is inside the test root" is
 * a refusal. Because the protected home is a launcher fact, not a tool
 * argument, a model cannot set it, and it is required: an absent, relative,
 * empty or unresolvable value refuses rather than falling back to `~/.dsh`
 * (which would require reading a live home this module must never touch).
 *
 * Fail closed: anything unresolvable is a refusal with a code, never a pass.
 *
 * @module dsh-agent-test-driver/provenance
 */

import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { ContainmentError, isWithin, realpathDirectory } from './internal/fs-safe.js';

/**
 * Environment variable an admin (not a model) may set to declare the process a
 * test host. `1`/`true` accepts. Any other non-empty value is a refusal rather
 * than "unset", because a malformed switch is more likely to be a typo than an
 * intention and the safe reading of a typo is "not a test host".
 */
export const ISOLATION_ENV = 'DSH_AGENT_TEST_DRIVER';

/**
 * Environment variable the trusted launcher sets to the *production* harness
 * home this test host must never overlap. It is trusted launcher configuration,
 * not tool input, and it is deliberately not `DSH_HOME`: an isolated host sets
 * `DSH_HOME` to its own home inside the test tree.
 */
export const PROTECTED_HOME_ENV = 'DSH_AGENT_TEST_PROTECTED_HOME';

/** Directory name of the marker file inside the configured test root. */
export const MARKER_FILE_NAME = 'dsh-agent-test-driver.json';

/** Marker `kind` value this plugin accepts. Anything else is a foreign marker. */
export const MARKER_KIND = 'dsh-agent-test-driver/test-root';

/** Largest marker we will read; a larger file is malformed, not truncated. */
export const MARKER_MAX_BYTES = 16 * 1024;

/**
 * Shipped launcher profile names. Diagnostic only: a shipped name appearing in
 * the path is reported, but isolation is decided by containment against the
 * startup facts, never by a directory being called `web` or not.
 */
export const PRODUCTION_PROFILE_NAMES = Object.freeze([
  'web',
  'headless',
  'acp',
  'sdk',
  'sdk-minimal',
  'desktop',
]);

/** Marker field that records the canonical test root the marker was written for. */
export const MARKER_CANONICAL_ROOT = 'canonicalRoot';

/**
 * Marker fields that must equal the canonical startup facts. All are required;
 * a marker missing any of them cannot bind this process to the root.
 */
export const MARKER_PROFILE_FIELDS = Object.freeze(['home', 'dir', 'name']);

/** Closed vocabulary of provenance refusal codes, for stable assertions. */
export const PROVENANCE_CODES = Object.freeze({
  NOT_TEST_HOST: 'PROVENANCE_NOT_TEST_HOST',
  ENV_MALFORMED: 'PROVENANCE_ENV_MALFORMED',
  NOT_CONFIGURED: 'PROVENANCE_NOT_CONFIGURED',
  CONFIG_INSIDE_LIVE_HOME: 'PROVENANCE_CONFIG_INSIDE_LIVE_HOME',
  STARTUP_CONTEXT_MISSING: 'PROVENANCE_STARTUP_CONTEXT_MISSING',
  STARTUP_CONTEXT_MALFORMED: 'PROVENANCE_STARTUP_CONTEXT_MALFORMED',
  STARTUP_HOME_UNRESOLVED: 'PROVENANCE_STARTUP_HOME_UNRESOLVED',
  PROFILE_UNRESOLVED: 'PROVENANCE_PROFILE_UNRESOLVED',
  PROFILE_OUTSIDE_TEST_ROOT: 'PROVENANCE_PROFILE_OUTSIDE_TEST_ROOT',
  PATH_ALIAS: 'PROVENANCE_PATH_ALIAS',
  TEST_ROOT_MISSING: 'PROVENANCE_TEST_ROOT_MISSING',
  TEST_ROOT_NOT_ABSOLUTE: 'PROVENANCE_TEST_ROOT_NOT_ABSOLUTE',
  TEST_ROOT_FILESYSTEM_ROOT: 'PROVENANCE_TEST_ROOT_FILESYSTEM_ROOT',
  PROTECTED_HOME_OVERLAP: 'PROVENANCE_PROTECTED_HOME_OVERLAP',
  PROTECTED_HOME_MISSING: 'PROVENANCE_PROTECTED_HOME_MISSING',
  PROTECTED_HOME_MALFORMED: 'PROVENANCE_PROTECTED_HOME_MALFORMED',
  PROTECTED_HOME_UNRESOLVED: 'PROVENANCE_PROTECTED_HOME_UNRESOLVED',
  MARKER_MISSING: 'PROVENANCE_MARKER_MISSING',
  MARKER_INVALID: 'PROVENANCE_MARKER_INVALID',
  MARKER_SYMLINK: 'PROVENANCE_MARKER_SYMLINK',
  MARKER_TOO_LARGE: 'PROVENANCE_MARKER_TOO_LARGE',
  MARKER_ROOT_MISMATCH: 'PROVENANCE_MARKER_ROOT_MISMATCH',
  TEST_ROOT_SYMLINK: 'PROVENANCE_TEST_ROOT_SYMLINK',
  MARKER_PROFILE_MISMATCH: 'PROVENANCE_MARKER_PROFILE_MISMATCH',
  PRODUCTION_PROFILE: 'PROVENANCE_PRODUCTION_PROFILE',
  ALREADY_ANCHORED: 'PROVENANCE_ALREADY_ANCHORED',
});

/**
 * Read the test-host environment switch.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ isTestHost: boolean, code?: string, detail?: string }}
 */
export function readIsolationSwitch(env) {
  const raw = env?.[ISOLATION_ENV];
  if (raw === undefined || raw === '') return { isTestHost: false };
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return { isTestHost: true };
  return {
    isTestHost: false,
    code: PROVENANCE_CODES.ENV_MALFORMED,
    detail: `${ISOLATION_ENV} must be "1" or "true" or unset`,
  };
}

/**
 * Validate the launcher-supplied production anchor, lexically.
 *
 * Required and fail-closed: absent/empty is a refusal (no `~/.dsh` default —
 * deriving it would require reading a live home this module must not touch),
 * and a relative or NUL-bearing value is malformed. The returned path is
 * lexically resolved only; canonicalization happens against the real filesystem
 * in `resolveProtectedHome`. The value is never echoed in a `detail`.
 *
 * @param {Record<string, string | undefined>} env Launcher environment.
 * @returns {{ ok: true, path: string } | { ok: false, code: string, detail: string }}
 */
export function readProtectedHome(env) {
  const raw = env?.[PROTECTED_HOME_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      code: PROVENANCE_CODES.PROTECTED_HOME_MISSING,
      detail: `${PROTECTED_HOME_ENV} must be set by the launcher to an absolute production home; it is never derived from DSH_HOME or a live home`,
    };
  }
  if (raw.includes('\0') || !isAbsolute(raw)) {
    return {
      ok: false,
      code: PROVENANCE_CODES.PROTECTED_HOME_MALFORMED,
      detail: `${PROTECTED_HOME_ENV} must be an absolute path`,
    };
  }
  return { ok: true, path: resolve(raw) };
}

/**
 * Canonicalize the protected home and check it against the canonical test root.
 *
 * Two overlaps are refused, both on the *canonical* forms so a symlink cannot
 * hide them: the root containing the protected home (the test tree would sit
 * above production) and the protected home containing the root (production
 * would sit above the test tree). A protected home reached through a symlink is
 * still compared by its real path; it is not rejected merely for being an alias.
 *
 * @param {string} root Canonical test root.
 * @param {string} declaredLexical Lexically resolved `PROTECTED_HOME_ENV` value.
 * @returns {Promise<{ ok: true, path: string } | { ok: false, code: string, detail: string }>}
 */
export async function resolveProtectedHome(root, declaredLexical) {
  let canonical;
  try {
    canonical = await realpathDirectory(declaredLexical, 'protected home');
  } catch {
    return {
      ok: false,
      code: PROVENANCE_CODES.PROTECTED_HOME_UNRESOLVED,
      detail: 'the launcher-supplied protected home is not a usable existing directory',
    };
  }
  if (isWithin(canonical, root) || isWithin(root, canonical)) {
    return {
      ok: false,
      code: PROVENANCE_CODES.PROTECTED_HOME_OVERLAP,
      detail: 'the configured test root overlaps the protected production home',
    };
  }
  return { ok: true, path: canonical };
}

/**
 * Read the startup-owned facts out of `ctx.profileContext`.
 *
 * These are supplied by the launcher, never by a tool call. Missing or
 * non-absolute values are reported as issues, not defaulted: guessing which
 * home an unidentifiable process lives in is how the production home ends up
 * accepted as a test root.
 *
 * @param {{ profileContext?: unknown }} ctx Cordis context.
 * @returns {{ ok: true, facts: { name: string, home: string, dir: string } } | { ok: false, issues: Array<{ code: string, detail: string }> }}
 */
export function readStartupFacts(ctx) {
  const profileContext = ctx?.profileContext;
  if (profileContext === null || typeof profileContext !== 'object') {
    return {
      ok: false,
      issues: [{
        code: PROVENANCE_CODES.STARTUP_CONTEXT_MISSING,
        detail: 'this process has no startup profileContext, so it cannot be bound to a test root',
      }],
    };
  }
  const fields = ['name', 'home', 'dir'];
  const malformed = fields.filter((field) => {
    const value = profileContext[field];
    if (typeof value !== 'string' || value === '' || value.includes('\0')) return true;
    return field !== 'name' && !isAbsolute(value);
  });
  if (malformed.length > 0) {
    return {
      ok: false,
      issues: [{
        code: PROVENANCE_CODES.STARTUP_CONTEXT_MALFORMED,
        detail: `startup profileContext is missing a valid value for: ${malformed.join(', ')}`,
      }],
    };
  }
  return {
    ok: true,
    facts: {
      name: profileContext.name,
      home: resolve(profileContext.home),
      dir: resolve(profileContext.dir),
    },
  };
}

/**
 * @deprecated Kept so existing imports keep loading. This function used to
 * return a "live home" that defaulted to `~/.dsh` for isolated hosts, which
 * conflated this host with production; it now returns only what the startup
 * context actually declared. Use `readStartupFacts()` plus
 * `readProtectedHome()` / `resolveProtectedHome()`.
 *
 * @param {{ dir?: unknown, home?: unknown, name?: unknown } | undefined} profileContext
 * @param {Record<string, string | undefined>} env Unused; kept for signature stability.
 * @returns {{ home: string, profileDir?: string, profileName?: string } | undefined}
 */
export function liveHarnessHome(profileContext, env) {
  void env;
  const parsed = readStartupFacts({ profileContext });
  if (!parsed.ok) return undefined;
  return { home: parsed.facts.home, profileDir: parsed.facts.dir, profileName: parsed.facts.name };
}

/**
 * Whether `path` is the filesystem root (`/`, `C:\`), which can never be a test
 * root worth arming.
 * @param {string} path Absolute lexical path.
 * @returns {boolean}
 */
function isFilesystemRoot(path) {
  const trimmed = path.endsWith(sep) ? path.slice(0, -sep.length) : path;
  return trimmed === '';
}

/**
 * Static configuration checks that need no filesystem access.
 *
 * Two inputs are accepted so old and new callers both work:
 * - a startup fact record (`{ name, home, dir }`, as returned by
 *   `readStartupFacts().facts`) or the equivalent `{ profileName, home,
 *   profileDir }`, and
 * - the legacy `{ home, profileDir }` "live" record.
 * If neither is given the check refuses, because nothing then binds this
 * process to the configured root.
 *
 * @param {{ testRoot?: unknown, profileMarker?: unknown, homeMarker?: unknown }} config
 * @param {{ name?: string, home?: string, dir?: string, profileName?: string, profileDir?: string } | undefined} startup
 * @param {Record<string, string | undefined>} [env]
 * @returns {Array<{ code: string, detail: string }>} Refusals; empty means "worth resolving".
 */
export function staticProvenanceIssues(config, startup, env = {}) {
  const issues = [];
  const testRoot = config?.testRoot;
  const marker = config?.profileMarker;

  if (typeof testRoot !== 'string' || testRoot === '') {
    issues.push({ code: PROVENANCE_CODES.NOT_CONFIGURED, detail: 'no test root is configured' });
  } else if (!isAbsolute(testRoot) || testRoot.includes('\0')) {
    issues.push({ code: PROVENANCE_CODES.TEST_ROOT_NOT_ABSOLUTE, detail: 'the configured test root must be absolute' });
  } else if (isFilesystemRoot(resolve(testRoot))) {
    issues.push({
      code: PROVENANCE_CODES.TEST_ROOT_FILESYSTEM_ROOT,
      detail: 'the filesystem root can never be a test root',
    });
  }

  if (typeof marker !== 'string' || marker === '') {
    issues.push({ code: PROVENANCE_CODES.NOT_CONFIGURED, detail: 'no profile marker is configured' });
  } else if (marker !== MARKER_FILE_NAME) {
    issues.push({
      code: PROVENANCE_CODES.MARKER_INVALID,
      detail: `the profile marker must be named ${MARKER_FILE_NAME} so a stray config value cannot point at an unrelated file`,
    });
  }

  const name = typeof startup?.name === 'string' ? startup.name : startup?.profileName;
  const home = typeof startup?.home === 'string' ? startup.home : undefined;
  const dir = typeof startup?.dir === 'string' ? startup.dir : startup?.profileDir;

  // The production anchor is required launcher configuration, separate from
  // the isolated `DSH_HOME`. Only lexical validity is checked here; the
  // canonical overlap test needs the root to be canonicalized first.
  const protectedRead = readProtectedHome(env);
  if (!protectedRead.ok) issues.push({ code: protectedRead.code, detail: protectedRead.detail });

  if (home === undefined || dir === undefined || typeof name !== 'string' || name === '') {
    issues.push({
      code: PROVENANCE_CODES.STARTUP_CONTEXT_MISSING,
      detail: 'startup home, profile directory and profile name are all required to bind this host',
    });
  } else if (!isAbsolute(home) || !isAbsolute(dir)) {
    issues.push({
      code: PROVENANCE_CODES.STARTUP_CONTEXT_MALFORMED,
      detail: 'startup home and profile directory must be absolute',
    });
  }

  if (issues.length > 0) return issues;

  const root = resolve(testRoot);
  // The profile lives *inside* the root, never at the root: a root that is its
  // own profile makes "inside the test root" mean nothing.
  if (resolve(home) === root || resolve(dir) === root) {
    issues.push({
      code: PROVENANCE_CODES.CONFIG_INSIDE_LIVE_HOME,
      detail: 'the startup home or profile directory is the test root itself',
    });
  }
  // `name` is validated above for presence; whether it is a shipped profile is
  // reported elsewhere and never used to grant or deny isolation on its own.
  void name;
  return issues;
}

/**
 * Whether a path looks like `.../profiles/<shipped-name>`.
 *
 * Diagnostic only. A shipped name is a weak hint about what a directory is for;
 * it is never used to accept or reject isolation on its own.
 *
 * @param {string} path Canonical or lexical absolute path.
 * @returns {boolean}
 */
export function isProductionProfileRoot(path) {
  const segments = resolve(path).split(/[\\/]+/).filter(Boolean);
  const directory = segments.at(-2)?.toLowerCase();
  const name = segments.at(-1)?.toLowerCase();
  if (directory !== 'profiles' || name === undefined) return false;
  return PRODUCTION_PROFILE_NAMES.includes(name);
}

/**
 * Resolve the startup home and profile directory against the real filesystem
 * and require both to be canonically contained in `root`.
 *
 * The lexical form is checked first so an escaping configuration is reported as
 * an escape rather than laundered through `realpath`. Then each path is
 * canonicalized; a symlink that leaves the root fails. Finally the *declared*
 * spelling is compared with the *canonical* one: a path that only reaches the
 * root through a symlink is an alias and is refused, because the same directory
 * then has two identities and the marker cannot pin either.
 *
 * @param {string} root Canonical test root.
 * @param {{ name: string, home: string, dir: string }} declared Lexically resolved startup facts.
 * @returns {Promise<{ ok: true, home: string, dir: string } | { ok: false, issues: Array<{ code: string, detail: string }> }>}
 */
async function bindProfileToRoot(root, declared) {
  const issues = [];
  for (const candidate of [declared.home, declared.dir]) {
    if (!isWithin(root, candidate)) {
      issues.push({
        code: PROVENANCE_CODES.PROFILE_OUTSIDE_TEST_ROOT,
        detail: 'the startup home and profile directory must lie inside the configured test root',
      });
      break;
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const canonical = async (path, code, detail) => {
    try {
      return await realpathDirectory(path, 'startup path');
    } catch (error) {
      const missing = error instanceof ContainmentError && error.code !== 'not-a-directory';
      return {
        code: missing ? code : PROVENANCE_CODES.STARTUP_CONTEXT_MALFORMED,
        detail,
      };
    }
  };

  const home = await canonical(declared.home, PROVENANCE_CODES.STARTUP_HOME_UNRESOLVED, 'the startup home is not a usable directory');
  if (typeof home !== 'string') return { ok: false, issues: [home] };
  const dir = await canonical(declared.dir, PROVENANCE_CODES.PROFILE_UNRESOLVED, 'the startup profile directory is not a usable directory');
  if (typeof dir !== 'string') return { ok: false, issues: [dir] };

  for (const resolvedPath of [home, dir]) {
    if (!isWithin(root, resolvedPath)) {
      return {
        ok: false,
        issues: [{ code: PROVENANCE_CODES.PROFILE_OUTSIDE_TEST_ROOT, detail: 'a startup path resolves outside the test root' }],
      };
    }
  }
  if (home !== declared.home || dir !== declared.dir) {
    return {
      ok: false,
      issues: [{
        code: PROVENANCE_CODES.PATH_ALIAS,
        detail: 'a startup path is a symlink alias rather than the real directory; configure the canonical path',
      }],
    };
  }
  // The profile name must agree with the canonical directory it claims to be.
  if (declared.name !== basename(dir)) {
    return {
      ok: false,
      issues: [{ code: PROVENANCE_CODES.PROFILE_UNRESOLVED, detail: 'the startup profile name does not match its profile directory' }],
    };
  }
  return { ok: true, home, dir };
}

/**
 * Check a parsed marker against the canonical root and startup facts.
 *
 * The marker must claim `kind`, be found *at* the root it describes (its
 * `canonicalRoot` and `root` must resolve to that directory, and when both are
 * present they must not name conflicts), not be a production marker, and — when
 * canonical startup facts are supplied — it must carry `home`, `dir` and `name`
 * equal to them. Those three are REQUIRED, not optional: a marker that omits
 * them cannot bind this process to the root, and a copied marker that carries
 * another profile's facts fails just as a foreign marker would.
 *
 * @param {unknown} marker
 * @param {string} root Canonical root the marker was read from.
 * @param {{ name: string, home: string, dir: string } | undefined} [startup] Canonical startup facts.
 * @returns {{ code: string, detail: string } | undefined}
 */
export function validateMarker(marker, root, startup) {
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) {
    return { code: PROVENANCE_CODES.MARKER_INVALID, detail: 'the marker is not a JSON object' };
  }
  if (marker.kind !== MARKER_KIND) {
    return { code: PROVENANCE_CODES.MARKER_INVALID, detail: `the marker kind must be ${MARKER_KIND}` };
  }
  if (marker.production === true) {
    return { code: PROVENANCE_CODES.PRODUCTION_PROFILE, detail: 'the marker declares a production profile' };
  }

  const declaredRoots = [];
  for (const key of [MARKER_CANONICAL_ROOT, 'root']) {
    const value = marker[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
      return { code: PROVENANCE_CODES.MARKER_INVALID, detail: 'the marker must record absolute canonical paths' };
    }
    declaredRoots.push({ key, value });
  }
  if (declaredRoots.length === 0) {
    return { code: PROVENANCE_CODES.MARKER_INVALID, detail: 'the marker must record an absolute root' };
  }
  for (const { value } of declaredRoots) {
    if (resolve(value) !== root) {
      return { code: PROVENANCE_CODES.MARKER_ROOT_MISMATCH, detail: 'the marker describes a different directory than the one it was found in' };
    }
  }
  // Two aliases for "the root" that disagree cannot both pin it.
  if (declaredRoots.length === 2 && declaredRoots[0].value !== declaredRoots[1].value) {
    return {
      code: PROVENANCE_CODES.MARKER_ROOT_MISMATCH,
      detail: 'the marker records conflicting spellings of the root; neither can be trusted',
    };
  }

  const facts = [
    ['home', 'canonical startup home'],
    ['dir', 'canonical startup profile directory'],
    ['name', 'startup profile name'],
  ].filter(([key]) => MARKER_PROFILE_FIELDS.includes(key));
  if (startup === undefined) {
    return {
      code: PROVENANCE_CODES.STARTUP_CONTEXT_MISSING,
      detail: 'marker profile facts can only be checked against canonical startup facts',
    };
  }
  for (const [key, label] of facts) {
    if (typeof startup[key] !== 'string' || startup[key] === '') {
      return { code: PROVENANCE_CODES.STARTUP_CONTEXT_MISSING, detail: `the ${label} is required to bind the marker` };
    }
  }
  for (const [key, label] of facts) {
    const value = marker[key];
    if (typeof value !== 'string' || value === '') {
      return {
        code: PROVENANCE_CODES.MARKER_PROFILE_MISMATCH,
        detail: `the marker must record the ${label}`,
      };
    }
    if (value !== startup[key]) {
      return {
        code: PROVENANCE_CODES.MARKER_PROFILE_MISMATCH,
        detail: `the marker profile "${key}" does not match this process's ${label}`,
      };
    }
  }
  return undefined;
}

/**
 * Read a bounded, regular, non-symlink file.
 *
 * The open uses `O_NOFOLLOW` (falling back to `O_RDONLY` where unsupported, so
 * the case is exercised rather than skipped) and the handle's own `stat` must
 * report a regular file: a symlink planted at the marker name is refused even
 * when it points at a perfectly valid JSON file inside the root. Reading is
 * capped at `MARKER_MAX_BYTES`; anything longer is rejected, never truncated.
 *
 * @param {string} path Absolute path.
 * @param {number} maxBytes Upper bound.
 * @returns {Promise<{ ok: true, text: string } | { ok: false, code: string, detail: string }>}
 */
async function readBoundedRegularFile(path, maxBytes) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
      ? PROVENANCE_CODES.MARKER_MISSING
      : error?.code === 'ELOOP'
        ? PROVENANCE_CODES.MARKER_SYMLINK
        : PROVENANCE_CODES.MARKER_INVALID;
    const detail = code === PROVENANCE_CODES.MARKER_MISSING
      ? 'the test root has no marker file'
      : code === PROVENANCE_CODES.MARKER_SYMLINK
        ? 'the marker is a symlink, not a regular file'
        : 'the marker could not be opened';
    return { ok: false, code, detail };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return { ok: false, code: PROVENANCE_CODES.MARKER_SYMLINK, detail: 'the marker is not a regular file' };
    }
    if (info.size > maxBytes) {
      return { ok: false, code: PROVENANCE_CODES.MARKER_TOO_LARGE, detail: `the marker exceeds ${maxBytes} bytes` };
    }
    // Read at most maxBytes regardless of what stat claimed: size can change
    // between stat and read.
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    if (bytesRead >= maxBytes) {
      return { ok: false, code: PROVENANCE_CODES.MARKER_TOO_LARGE, detail: `the marker exceeds ${maxBytes} bytes` };
    }
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { ok: false, code: PROVENANCE_CODES.MARKER_INVALID, detail: 'the marker could not be read' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Full provenance probe, filesystem included.
 *
 * Order is explicit and each step fails closed:
 * switch, startup facts, static checks (root, marker name, required protected
 * anchor), canonical root, canonical protected-home overlap, canonical startup
 * paths bound to root, marker read, marker validation. The marker is read only
 * after the root is canonicalized, the protected home is known not to overlap
 * it, and the startup paths are known to be the real directories inside it.
 *
 * `protectedHome` is the canonicalized launcher anchor; it is never `DSH_HOME`
 * (that is the isolated current home) and it is reported inward for integration
 * but stripped from `provenanceRefusal`.
 *
 * @param {object} input
 * @param {{ testRoot?: unknown, profileMarker?: unknown, homeMarker?: unknown }} input.config
 * @param {{ profileContext?: object }} [input.ctx] Cordis context (startup-owned facts live here).
 * @param {Record<string, string | undefined>} input.env
 * @returns {Promise<{
 *   isTestHost: boolean,
 *   armed: boolean,
 *   testRoot?: string,
 *   home?: string,
 *   profileDir?: string,
 *   profileName?: string,
 *   protectedHome?: string,
 *   detail: string,
 *   issues: Array<{ code: string, detail: string }>,
 * }>}
 */
export async function probeProvenance({ config, ctx, env }) {
  const issues = [];
  const protectedRead = readProtectedHome(env);
  const switchResult = readIsolationSwitch(env);
  if (switchResult.code !== undefined) {
    issues.push({ code: switchResult.code, detail: switchResult.detail });
  }
  const isTestHost = switchResult.isTestHost;
  const refuseWith = (list, detail, extra = {}) => ({
    isTestHost,
    armed: false,
    ...(protectedRead.ok && protectedRead.path !== '' ? { protectedHome: protectedRead.path } : {}),
    issues: list,
    detail,
    ...extra,
  });

  if (issues.length > 0) return refuseWith(issues, 'environment declares a malformed isolation switch');

  if (!isTestHost) {
    return refuseWith(
      [{ code: PROVENANCE_CODES.NOT_TEST_HOST, detail: `this process is not marked as a test host (${ISOLATION_ENV})` }],
      'not a test host',
    );
  }

  const startup = readStartupFacts(ctx);
  if (!startup.ok) return refuseWith(startup.issues, startup.issues[0].detail);

  const staticIssues = staticProvenanceIssues(config, startup.facts, env);
  if (staticIssues.length > 0) {
    return refuseWith(staticIssues, staticIssues.map((issue) => issue.detail).join('; '));
  }

  let root;
  let declaredRoot;
  try {
    declaredRoot = await realpath(config.testRoot);
    root = await realpathDirectory(config.testRoot, 'test root');
  } catch {
    return refuseWith(
      [{ code: PROVENANCE_CODES.TEST_ROOT_MISSING, detail: 'the configured test root is not a usable directory' }],
      'test root unusable',
    );
  }
  // A configured root that is not already its own real path reaches the
  // directory through a symlink: two names for one directory, and the marker
  // can only pin one of them. Refuse rather than silently canonicalize.
  if (declaredRoot !== resolve(config.testRoot)) {
    return refuseWith(
      [{
        code: PROVENANCE_CODES.TEST_ROOT_SYMLINK,
        detail: 'the configured test root reaches its directory through a symlink; configure the real directory',
      }],
      'test root is an alias',
    );
  }

  // Re-run against the canonical root: a symlink can change which directory the
  // configuration actually names.
  const canonicalIssues = staticProvenanceIssues(
    { testRoot: root, profileMarker: config.profileMarker },
    startup.facts,
    env,
  );
  if (canonicalIssues.length > 0) {
    return refuseWith(canonicalIssues, canonicalIssues.map((issue) => issue.detail).join('; '), { testRoot: root });
  }
  if (root === sep || (root.length > 1 && root.endsWith(sep))) {
    return refuseWith(
      [{ code: PROVENANCE_CODES.TEST_ROOT_FILESYSTEM_ROOT, detail: 'the test root resolved to the filesystem root' }],
      'test root unusable',
    );
  }

  const bound = await bindProfileToRoot(root, startup.facts);
  if (!bound.ok) return refuseWith(bound.issues, bound.issues[0].detail, { testRoot: root });

  // The protected anchor is canonicalized against the real filesystem and
  // compared with the canonical root: a symlinked anchor that really contains
  // (or sits inside) the root is an overlap even when the spellings disagree.
  const protectedResolved = await resolveProtectedHome(root, protectedRead.path);
  if (!protectedResolved.ok) {
    return refuseWith(
      [{ code: protectedResolved.code, detail: protectedResolved.detail }],
      protectedResolved.detail,
      { testRoot: root },
    );
  }

  const markerPath = join(root, MARKER_FILE_NAME);
  const read = await readBoundedRegularFile(markerPath, MARKER_MAX_BYTES);
  if (!read.ok) {
    return refuseWith([{ code: read.code, detail: read.detail }], 'marker unavailable', { testRoot: root });
  }

  let marker;
  try {
    marker = JSON.parse(read.text);
  } catch {
    return refuseWith(
      [{ code: PROVENANCE_CODES.MARKER_INVALID, detail: 'the marker is not valid JSON' }],
      'marker unreadable',
      { testRoot: root },
    );
  }

  const markerIssue = validateMarker(marker, root, {
    name: startup.facts.name,
    home: bound.home,
    dir: bound.dir,
  });
  if (markerIssue !== undefined) {
    return refuseWith([markerIssue], markerIssue.detail, { testRoot: root });
  }

  return {
    isTestHost,
    armed: true,
    testRoot: root,
    home: bound.home,
    profileDir: bound.dir,
    profileName: startup.facts.name,
    protectedHome: protectedResolved.path,
    issues: [],
    detail: 'armed',
  };
}

/**
 * Refusal object for a provenance result, in the plugin's closed receipt shape.
 *
 * The protected home is deliberately absent here: it is the one path that, if
 * echoed, would name the production home to whoever asked. Callers that need the
 * canonical paths for integration read the probe result itself, never this
 * outward receipt.
 *
 * @param {Awaited<ReturnType<typeof probeProvenance>>} provenance
 * @returns {{ ok: false, code: string, message: string, provenance: object }}
 */
export function provenanceRefusal(provenance) {
  const first = provenance.issues[0] ?? { code: PROVENANCE_CODES.NOT_TEST_HOST, detail: 'isolation provenance is absent' };
  return {
    ok: false,
    code: first.code,
    message: `refused: ${first.detail}`,
    provenance: {
      isTestHost: provenance.isTestHost,
      armed: false,
      ...(provenance.testRoot === undefined ? {} : { testRoot: provenance.testRoot }),
      codes: provenance.issues.map((issue) => issue.code),
    },
  };
}
