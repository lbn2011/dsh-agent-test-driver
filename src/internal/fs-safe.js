/**
 * Local filesystem helpers with the containment rules this plugin needs, and
 * nothing else.
 *
 * The one rule that matters: a *displayed* path can lie. `realpath` is what the
 * OS believes; a symlink anywhere in the chain resolves to its target, and the
 * resolved target is what gets compared against the allowed root. Comparisons
 * happen on the resolved form of both sides, so `root/../root/../etc` and
 * `root/link-to-etc` both fail the same way.
 *
 * This module performs no writes. Every function either reads metadata or throws.
 *
 * @module dsh-agent-test-driver/internal/fs-safe
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, basename, dirname, join, resolve, sep } from 'node:path';

/** A filesystem check that failed for a caller-actionable reason. */
export class ContainmentError extends Error {
  /**
   * @param {string} message Bounded, secret-free explanation.
   * @param {'not-absolute' | 'not-found' | 'not-a-directory' | 'not-a-file' | 'outside-root' | 'unresolvable'} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'ContainmentError';
    this.code = code;
  }
}

/**
 * Resolve the real path of an existing directory, or throw.
 *
 * @param {string} path Absolute path to test.
 * @param {string} label Short noun used in the error, e.g. `test root`.
 * @returns {Promise<string>} Canonical absolute path with symlinks resolved.
 */
export async function realpathDirectory(path, label = 'directory') {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new ContainmentError(`${label} must be an absolute path`, 'not-absolute');
  }
  let resolved;
  try {
    resolved = await realpath(path);
  } catch {
    throw new ContainmentError(`${label} does not exist`, 'not-found');
  }
  const info = await stat(resolved).catch(() => undefined);
  if (info === undefined) throw new ContainmentError(`${label} does not exist`, 'not-found');
  if (!info.isDirectory()) throw new ContainmentError(`${label} is not a directory`, 'not-a-directory');
  return resolved;
}

/**
 * Resolve the real path of an existing regular file, or throw.
 * @param {string} path Absolute path to test.
 * @param {string} label Short noun used in the error.
 * @returns {Promise<string>}
 */
export async function realpathFile(path, label = 'file') {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new ContainmentError(`${label} must be an absolute path`, 'not-absolute');
  }
  let resolved;
  try {
    resolved = await realpath(path);
  } catch {
    throw new ContainmentError(`${label} does not exist`, 'not-found');
  }
  const info = await stat(resolved).catch(() => undefined);
  if (info === undefined) throw new ContainmentError(`${label} does not exist`, 'not-found');
  if (!info.isFile()) throw new ContainmentError(`${label} is not a regular file`, 'not-a-file');
  return resolved;
}

/**
 * Whether `child` is `root` itself or lies beneath it.
 *
 * Both arguments must already be canonical. A string-prefix test would accept
 * `/srv/test-host-2` for root `/srv/test-host`, so the comparison is done on
 * path segments after appending a separator to the root.
 *
 * @param {string} root Canonical root.
 * @param {string} child Canonical candidate.
 * @returns {boolean}
 */
export function isWithin(root, child) {
  if (root === child) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(prefix);
}

/**
 * Resolve `candidate` (absolute, or relative to `root`) and require containment
 * in the real filesystem.
 *
 * Rejects before touching the filesystem when the *lexical* form already
 * escapes the root, so an attempted traversal is reported as such rather than
 * being laundered through `realpath` into whatever it pointed at.
 *
 * @param {string} root Canonical root the result must stay inside.
 * @param {string} candidate Path to resolve.
 * @returns {Promise<string>} Canonical path inside `root`.
 */
export async function resolveWithin(root, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
    throw new ContainmentError('path must be a non-empty string without NUL', 'not-absolute');
  }
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  if (!isWithin(root, absolute)) {
    throw new ContainmentError('path is outside the test root', 'outside-root');
  }
  let resolved;
  try {
    resolved = await realpath(absolute);
  } catch {
    throw new ContainmentError('path does not exist', 'not-found');
  }
  if (!isWithin(root, resolved)) {
    throw new ContainmentError('path resolves outside the test root', 'outside-root');
  }
  return resolved;
}

/**
 * Wrap a value in a direct child of `root` by basename, discarding any
 * directory component the value carries.
 *
 * Used for the allowlisted plugin target root: an admin names a directory
 * *under* the fixed root, never a place elsewhere.
 *
 * @param {string} root Canonical root.
 * @param {string} name Single path segment.
 * @returns {string} Lexical join; callers still resolve and re-check it.
 */
export function childOf(root, name) {
  if (typeof name !== 'string' || name.length === 0) throw new ContainmentError('name is required', 'not-found');
  if (name.includes('\0')) throw new ContainmentError('name must not contain NUL', 'not-absolute');
  if (basename(name) !== name) throw new ContainmentError('name must be a single path segment', 'outside-root');
  if (name === '.' || name === '..') throw new ContainmentError('name must be a real path segment', 'outside-root');
  return join(root, name);
}

export { dirname };
