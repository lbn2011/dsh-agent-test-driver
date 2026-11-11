/**
 * The package's own identity, pinned so it cannot drift silently.
 *
 * The four repositories in this workspace make different decisions about
 * `private` on purpose: the platform's five packages and dsh-compat-spec cleared
 * it after showing publishability evidence (a tarball audit, or an identity and
 * licence test), while this package and dsh-plugin-kit keep it because no audit,
 * tarball or publish path touches them. See
 * `dsh-compat-platform/docs/requirements-and-design/2026-11-11-package-flag-policy.md`.
 *
 * This test is the driver's side of that rule. If the flag is ever meant to be
 * cleared here, this assertion is where the decision has to be recorded, and the
 * audit that justifies it has to exist first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the package identity is the decided one', () => {
  assert.equal(manifest.name, 'dsh-agent-test-driver');
  assert.equal(manifest.version, '0.1.0-draft.1');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.engines.node, '>=24.9.0');
});

test('the package stays private, because nothing audits or packages it', () => {
  assert.equal(manifest.private, true, 'clearing `private` here needs a tarball audit first');
});

test('the licence is the decided MIT text, not an empty claim', () => {
  assert.equal(manifest.license, 'MIT');
  const licence = `${ROOT}LICENSE`;
  assert.equal(existsSync(licence), true, 'LICENSE must exist beside the manifest');
  const text = readFileSync(licence, 'utf8');
  assert.match(text, /^MIT License\n/);
  assert.match(text, /Copyright \(c\) 2026 lbn2011/);
});

test('the package declares no runtime dependency and no bin', () => {
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.bin, undefined, 'this plugin is not a CLI');
});
