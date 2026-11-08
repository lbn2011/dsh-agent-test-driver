/**
 * Focused tests for isolation provenance.
 *
 * Everything here uses a throwaway temp tree. Nothing is executed against a
 * real DSH host: no launcher, no loader, no `~/.dsh` inspection, no live
 * profiles. The temp tree is shaped like an isolated test host:
 *
 *   <tmp>/root/
 *     dsh-agent-test-driver.json   marker naming <tmp>/root, its home and profile
 *     home/                        isolated DSH home (this is DSH_HOME)
 *     profiles/isolated-test/      isolated profile directory
 *
 * The *production* anchor is never `DSH_HOME`: it is the trusted launcher
 * variable `DSH_AGENT_TEST_PROTECTED_HOME`, and tests point it at an existing
 * temp directory distinct from the isolated home.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  ISOLATION_ENV,
  MARKER_FILE_NAME,
  MARKER_KIND,
  PROTECTED_HOME_ENV,
  PROVENANCE_CODES,
  probeProvenance,
  provenanceRefusal,
  readIsolationSwitch,
  readProtectedHome,
  readStartupFacts,
  staticProvenanceIssues,
  validateMarker,
} from '../src/provenance.js';

/** @type {string} */
let base;
/** @type {string} */
let root;
/** @type {string} */
let home;
/** @type {string} */
let profileDir;
/** @type {string} */
let protectedAnchor;

const SWITCH = { [ISOLATION_ENV]: '1' };

/** A context shaped like the launcher's startup facts. */
function ctxFor(facts) {
  return { profileContext: { name: 'isolated-test', ...facts } };
}

/**
 * Write the marker file for `targetRoot`. `home`/`dir`/`name` are required
 * marker fields; callers pass them explicitly so the marker binds this profile.
 */
async function writeMarker(
  targetRoot,
  { home: markerHome, dir: markerDir, name = 'isolated-test', ...rest } = {},
) {
  await writeFile(
    join(targetRoot, MARKER_FILE_NAME),
    JSON.stringify({
      kind: MARKER_KIND,
      canonicalRoot: targetRoot,
      root: targetRoot,
      home: markerHome,
      dir: markerDir,
      name,
      ...rest,
    }),
  );
}

/** Fresh temp tree, one per test. */
async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-provenance-'));
  const treeRoot = join(dir, 'root');
  const treeHome = join(treeRoot, 'home');
  const treeProfile = join(treeRoot, 'profiles', 'isolated-test');
  const treeAnchor = join(dir, 'prod-home');
  await mkdir(treeProfile, { recursive: true });
  await mkdir(treeHome, { recursive: true });
  await mkdir(treeAnchor, { recursive: true });
  return {
    dir,
    root: treeRoot,
    home: treeHome,
    profileDir: treeProfile,
    protectedAnchor: treeAnchor,
  };
}

/** Write a marker that names the tree's own canonical home and profile. */
async function markTree(tree) {
  await writeMarker(tree.root, { home: tree.home, dir: tree.profileDir });
}

before(async () => {
  ({ dir: base, root, home, profileDir, protectedAnchor } = await makeTree());
  await markTree({ root, home, profileDir });
});

after(async () => {
  if (base !== undefined) await rm(base, { recursive: true, force: true });
});

/**
 * The well-formed environment for the valid layout: the isolated host points
 * `DSH_HOME` at its own home inside the root, and the launcher separately names
 * the production anchor.
 */
function goodEnv() {
  return { ...SWITCH, DSH_HOME: home, [PROTECTED_HOME_ENV]: protectedAnchor };
}

describe('isolation switch', () => {
  it('accepts only 1/true and refuses malformed values', () => {
    assert.equal(readIsolationSwitch({ [ISOLATION_ENV]: '1' }).isTestHost, true);
    assert.equal(readIsolationSwitch({ [ISOLATION_ENV]: 'TRUE' }).isTestHost, true);
    assert.equal(readIsolationSwitch({}).isTestHost, false);
    const bad = readIsolationSwitch({ [ISOLATION_ENV]: 'yes' });
    assert.equal(bad.isTestHost, false);
    assert.equal(bad.code, PROVENANCE_CODES.ENV_MALFORMED);
  });
});

describe('protected home anchor', () => {
  it('requires the explicit launcher variable and never falls back to DSH_HOME', () => {
    const absent = readProtectedHome({ DSH_HOME: home });
    assert.equal(absent.ok, false);
    assert.equal(absent.code, PROVENANCE_CODES.PROTECTED_HOME_MISSING);
    assert.equal(readProtectedHome({}).code, PROVENANCE_CODES.PROTECTED_HOME_MISSING);
    assert.equal(readProtectedHome({ [PROTECTED_HOME_ENV]: '' }).code, PROVENANCE_CODES.PROTECTED_HOME_MISSING);
  });

  it('refuses a relative or NUL-bearing anchor', () => {
    assert.equal(
      readProtectedHome({ [PROTECTED_HOME_ENV]: 'relative/home' }).code,
      PROVENANCE_CODES.PROTECTED_HOME_MALFORMED,
    );
    assert.equal(
      readProtectedHome({ [PROTECTED_HOME_ENV]: '/tmp/a\0b' }).code,
      PROVENANCE_CODES.PROTECTED_HOME_MALFORMED,
    );
  });
});

describe('startup facts', () => {
  it('refuses when there is no startup profileContext', () => {
    const parsed = readStartupFacts({});
    assert.equal(parsed.ok, false);
    assert.equal(parsed.issues[0].code, PROVENANCE_CODES.STARTUP_CONTEXT_MISSING);
  });

  it('refuses a relative or missing home/dir/name', () => {
    const parsed = readStartupFacts(ctxFor({ home: 'relative/home' }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.issues[0].code, PROVENANCE_CODES.STARTUP_CONTEXT_MALFORMED);
  });
});

describe('valid isolated layout', () => {
  it('arms when switch, startup facts, root, protected anchor and marker agree', async () => {
    const result = await probeProvenance({
      config: { testRoot: root, profileMarker: MARKER_FILE_NAME },
      ctx: ctxFor({ home, dir: profileDir }),
      env: goodEnv(),
    });
    assert.deepEqual(result.issues, []);
    assert.equal(result.armed, true);
    assert.equal(result.testRoot, await realpath(root));
    assert.equal(result.home, await realpath(home));
    assert.equal(result.protectedHome, await realpath(protectedAnchor));
  });

  it('arms when the isolated DSH_HOME is this host\'s own home inside the test root', async () => {
    // The bug this pins down: an isolated host legitimately sets DSH_HOME to a
    // home *inside* the test root. That must not be read as the protected home.
    const tree = await makeTree();
    try {
      await markTree(tree);
      const result = await probeProvenance({
        config: { testRoot: tree.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: tree.home, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: tree.protectedAnchor },
      });
      assert.deepEqual(result.issues, []);
      assert.equal(result.armed, true);
      assert.notEqual(result.protectedHome, result.home);
      assert.equal(result.protectedHome, await realpath(tree.protectedAnchor));
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });

  it('does not arm without the explicit switch', async () => {
    const result = await probeProvenance({
      config: { testRoot: root, profileMarker: MARKER_FILE_NAME },
      ctx: ctxFor({ home, dir: profileDir }),
      env: { DSH_HOME: home, [PROTECTED_HOME_ENV]: protectedAnchor },
    });
    assert.equal(result.armed, false);
    assert.equal(result.issues[0].code, PROVENANCE_CODES.NOT_TEST_HOST);
  });
});

describe('this host must be bound to the root', () => {
  it('refuses missing startup facts even with a valid marker', async () => {
    const result = await probeProvenance({
      config: { testRoot: root, profileMarker: MARKER_FILE_NAME },
      ctx: {},
      env: goodEnv(),
    });
    assert.equal(result.armed, false);
    assert.equal(result.issues[0].code, PROVENANCE_CODES.STARTUP_CONTEXT_MISSING);
  });

  it('refuses an unrelated root that merely carries a marker', async () => {
    const foreign = await makeTree();
    try {
      await markTree(foreign);
      const result = await probeProvenance({
        config: { testRoot: foreign.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home, dir: profileDir }),
        env: goodEnv(),
      });
      assert.equal(result.armed, false);
      assert.equal(result.issues[0].code, PROVENANCE_CODES.PROFILE_OUTSIDE_TEST_ROOT);
    } finally {
      await rm(foreign.dir, { recursive: true, force: true });
    }
  });

  it('refuses a foreign root even when a marker-shaped file names the valid root', async () => {
    const other = await makeTree();
    try {
      await writeFile(
        join(other.root, MARKER_FILE_NAME),
        JSON.stringify({ kind: MARKER_KIND, canonicalRoot: other.root, root: other.root }),
      );
      const result = await probeProvenance({
        config: { testRoot: other.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home, dir: profileDir }),
        env: goodEnv(),
      });
      assert.equal(result.armed, false);
      const codes = result.issues.map((issue) => issue.code);
      assert.ok(codes.includes(PROVENANCE_CODES.PROFILE_OUTSIDE_TEST_ROOT));
    } finally {
      await rm(other.dir, { recursive: true, force: true });
    }
  });

  it('refuses a marker that records another profile', async () => {
    const tree = await makeTree();
    try {
      await writeMarker(tree.root, { home: tree.home, dir: tree.profileDir, name: 'someone-else' });
      const result = await probeProvenance({
        config: { testRoot: tree.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: tree.home, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: tree.protectedAnchor },
      });
      assert.equal(result.armed, false);
      assert.equal(result.issues[0].code, PROVENANCE_CODES.MARKER_PROFILE_MISMATCH);
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });

  it('refuses a marker that omits the profile facts instead of treating them as optional', async () => {
    const tree = await makeTree();
    try {
      await writeFile(
        join(tree.root, MARKER_FILE_NAME),
        JSON.stringify({ kind: MARKER_KIND, canonicalRoot: tree.root, root: tree.root }),
      );
      const result = await probeProvenance({
        config: { testRoot: tree.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: tree.home, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: tree.protectedAnchor },
      });
      assert.equal(result.armed, false);
      assert.equal(result.issues[0].code, PROVENANCE_CODES.MARKER_PROFILE_MISMATCH);
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });

  it('refuses a marker whose two root aliases disagree', () => {
    const aliased = `${root}-other`;
    const issue = validateMarker(
      { kind: MARKER_KIND, canonicalRoot: root, root: aliased, home, dir: profileDir, name: 'isolated-test' },
      root,
      { name: 'isolated-test', home, dir: profileDir },
    );
    assert.equal(issue?.code, PROVENANCE_CODES.MARKER_ROOT_MISMATCH);
  });
});

describe('fail-closed configuration', () => {
  it('refuses the filesystem root', () => {
    const issues = staticProvenanceIssues(
      { testRoot: '/', profileMarker: MARKER_FILE_NAME },
      { name: 'isolated-test', home, dir: profileDir },
      { DSH_HOME: home, [PROTECTED_HOME_ENV]: protectedAnchor },
    );
    assert.ok(issues.some((issue) => issue.code === PROVENANCE_CODES.TEST_ROOT_FILESYSTEM_ROOT));
  });

  it('refuses a configuration with no protected anchor', () => {
    const issues = staticProvenanceIssues(
      { testRoot: root, profileMarker: MARKER_FILE_NAME },
      { name: 'isolated-test', home, dir: profileDir },
      { DSH_HOME: home },
    );
    assert.ok(issues.some((issue) => issue.code === PROVENANCE_CODES.PROTECTED_HOME_MISSING));
  });

  it('refuses a probe with no protected anchor even when everything else is valid', async () => {
    const result = await probeProvenance({
      config: { testRoot: root, profileMarker: MARKER_FILE_NAME },
      ctx: ctxFor({ home, dir: profileDir }),
      env: { ...SWITCH, DSH_HOME: home },
    });
    assert.equal(result.armed, false);
    assert.equal(result.issues[0].code, PROVENANCE_CODES.PROTECTED_HOME_MISSING);
    assert.equal(result.protectedHome, undefined);
  });

  it('refuses a protected anchor that is not an existing directory', async () => {
    const result = await probeProvenance({
      config: { testRoot: root, profileMarker: MARKER_FILE_NAME },
      ctx: ctxFor({ home, dir: profileDir }),
      env: { ...SWITCH, DSH_HOME: home, [PROTECTED_HOME_ENV]: join(base, 'absent-home') },
    });
    assert.equal(result.armed, false);
    assert.equal(result.issues[0].code, PROVENANCE_CODES.PROTECTED_HOME_UNRESOLVED);
  });

  it('refuses a test root that contains the protected anchor', async () => {
    const tree = await makeTree();
    try {
      await markTree(tree);
      const insideAnchor = join(tree.root, 'prod-home');
      await mkdir(insideAnchor, { recursive: true });
      const result = await probeProvenance({
        config: { testRoot: tree.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: tree.home, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: insideAnchor },
      });
      assert.equal(result.armed, false);
      assert.equal(result.issues[0].code, PROVENANCE_CODES.PROTECTED_HOME_OVERLAP);
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });

  it('refuses a protected anchor reached through a symlink that really overlaps the root', async () => {
    const tree = await makeTree();
    const anchorLink = join(tree.dir, 'anchor-link');
    try {
      await markTree(tree);
      // The link is lexically outside the root, but canonically it is the root.
      await symlink(tree.root, anchorLink);
      const result = await probeProvenance({
        config: { testRoot: tree.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: tree.home, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: anchorLink },
      });
      assert.equal(result.armed, false);
      assert.equal(result.issues[0].code, PROVENANCE_CODES.PROTECTED_HOME_OVERLAP);
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });

  it('refuses a marker that is not one of ours', () => {
    const issue = validateMarker({ kind: 'something/else', root }, root);
    assert.equal(issue?.code, PROVENANCE_CODES.MARKER_INVALID);
  });

  it('refuses a marker naming a production profile', () => {
    const issue = validateMarker({ kind: MARKER_KIND, root, production: true }, root);
    assert.equal(issue?.code, PROVENANCE_CODES.PRODUCTION_PROFILE);
  });
});

describe('the two configured fields are optional and defaultless', () => {
  // These cases call `staticProvenanceIssues` directly, so the host config
  // schema never runs. That matters for the non-string rows: since `Config`
  // declares `testRoot`/`profileMarker` as `z.string()`, a non-string now fails
  // host config parsing and never reaches the probe at all. What is asserted
  // here is the probe's *own* contract — the refusal it produces if such a value
  // ever arrived — not what the host accepts.
  const startup = () => ({ name: 'isolated-test', home, dir: profileDir });
  const env = () => ({ DSH_HOME: home, [PROTECTED_HOME_ENV]: protectedAnchor });
  const codesFor = (config) => staticProvenanceIssues(config, startup(), env())
    .map((issue) => issue.code);

  it('refuses when testRoot is absent', () => {
    const codes = codesFor({ profileMarker: MARKER_FILE_NAME });
    assert.ok(codes.includes(PROVENANCE_CODES.NOT_CONFIGURED));
  });

  it('refuses when testRoot is null', () => {
    const codes = codesFor({ testRoot: null, profileMarker: MARKER_FILE_NAME });
    assert.ok(codes.includes(PROVENANCE_CODES.NOT_CONFIGURED));
  });

  it('refuses when testRoot is an empty string', () => {
    const codes = codesFor({ testRoot: '', profileMarker: MARKER_FILE_NAME });
    assert.ok(codes.includes(PROVENANCE_CODES.NOT_CONFIGURED));
  });

  it('refuses when testRoot is not a string', () => {
    const codes = codesFor({ testRoot: 42, profileMarker: MARKER_FILE_NAME });
    assert.ok(codes.includes(PROVENANCE_CODES.NOT_CONFIGURED));
  });

  it('refuses when profileMarker is absent', () => {
    const codes = codesFor({ testRoot: root });
    assert.ok(codes.includes(PROVENANCE_CODES.NOT_CONFIGURED));
  });

  it('refuses when profileMarker is null', () => {
    const codes = codesFor({ testRoot: root, profileMarker: null });
    assert.ok(codes.includes(PROVENANCE_CODES.NOT_CONFIGURED));
  });

  it('refuses when profileMarker is an empty string', () => {
    const codes = codesFor({ testRoot: root, profileMarker: '' });
    assert.ok(codes.includes(PROVENANCE_CODES.NOT_CONFIGURED));
  });

  it('refuses when profileMarker is not a string', () => {
    const codes = codesFor({ testRoot: root, profileMarker: { name: MARKER_FILE_NAME } });
    assert.ok(codes.includes(PROVENANCE_CODES.NOT_CONFIGURED));
  });

  it('reports a valid pair as worth resolving rather than refusing it', () => {
    // A valid pair is not an arming decision: `staticProvenanceIssues` only says
    // "no static objection", and every filesystem check still follows.
    const codes = codesFor({ testRoot: root, profileMarker: MARKER_FILE_NAME });
    assert.deepEqual(codes, []);
  });
});

describe('filesystem escapes', () => {
  it('refuses a test root that is a symlink alias of the real directory', async () => {
    const tree = await makeTree();
    const alias = join(tree.dir, 'alias');
    try {
      await markTree(tree);
      await symlink(tree.root, alias);
      const result = await probeProvenance({
        config: { testRoot: alias, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: tree.home, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: tree.protectedAnchor },
      });
      // Two names for one directory; the marker can only pin one of them.
      assert.equal(result.armed, false);
      assert.equal(result.issues[0].code, PROVENANCE_CODES.TEST_ROOT_SYMLINK);
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });

  it('refuses a startup home reached through a symlink alias', async () => {
    const tree = await makeTree();
    const aliasHome = join(tree.dir, 'alias-home');
    try {
      await markTree(tree);
      await symlink(tree.home, aliasHome);
      const result = await probeProvenance({
        config: { testRoot: tree.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: aliasHome, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: tree.protectedAnchor },
      });
      // aliasHome is outside the root lexically, so it fails containment first.
      assert.equal(result.armed, false);
      assert.equal(result.issues[0].code, PROVENANCE_CODES.PROFILE_OUTSIDE_TEST_ROOT);
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });

  it('refuses a startup path that is a lexically-inside symlink leaving the root', async () => {
    const tree = await makeTree();
    const outside = join(tree.dir, 'outside-home');
    const linkHome = join(tree.root, 'home-link');
    try {
      await markTree(tree);
      await mkdir(outside, { recursive: true });
      await symlink(outside, linkHome);
      const result = await probeProvenance({
        config: { testRoot: tree.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: linkHome, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: tree.protectedAnchor },
      });
      assert.equal(result.armed, false);
      const codes = result.issues.map((issue) => issue.code);
      assert.ok(codes.includes(PROVENANCE_CODES.PROFILE_OUTSIDE_TEST_ROOT));
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });

  it('refuses a path alias even when it stays inside the root', async () => {
    const tree = await makeTree();
    const aliasHome = join(tree.root, 'aliased-home');
    try {
      await markTree(tree);
      await symlink(tree.home, aliasHome);
      const result = await probeProvenance({
        config: { testRoot: tree.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: aliasHome, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: tree.protectedAnchor },
      });
      assert.equal(result.armed, false);
      assert.equal(result.issues[0].code, PROVENANCE_CODES.PATH_ALIAS);
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });

  it('refuses a marker that is itself a symlink', async () => {
    const tree = await makeTree();
    const realMarker = join(tree.dir, 'real-marker.json');
    try {
      await writeFile(
        realMarker,
        JSON.stringify({
          kind: MARKER_KIND,
          canonicalRoot: tree.root,
          root: tree.root,
          home: tree.home,
          dir: tree.profileDir,
          name: 'isolated-test',
        }),
      );
      await symlink(realMarker, join(tree.root, MARKER_FILE_NAME));
      const result = await probeProvenance({
        config: { testRoot: tree.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: tree.home, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: tree.protectedAnchor },
      });
      assert.equal(result.armed, false);
      assert.equal(result.issues[0].code, PROVENANCE_CODES.MARKER_SYMLINK);
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });

  it('refuses an oversized marker instead of truncating it', async () => {
    const tree = await makeTree();
    try {
      await writeFile(join(tree.root, MARKER_FILE_NAME), 'x'.repeat(17 * 1024));
      const result = await probeProvenance({
        config: { testRoot: tree.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: tree.home, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: tree.protectedAnchor },
      });
      assert.equal(result.armed, false);
      assert.equal(result.issues[0].code, PROVENANCE_CODES.MARKER_TOO_LARGE);
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });

  it('reports a missing marker, never a generic failure', async () => {
    const tree = await makeTree();
    try {
      const result = await probeProvenance({
        config: { testRoot: tree.root, profileMarker: MARKER_FILE_NAME },
        ctx: ctxFor({ home: tree.home, dir: tree.profileDir }),
        env: { ...SWITCH, DSH_HOME: tree.home, [PROTECTED_HOME_ENV]: tree.protectedAnchor },
      });
      assert.equal(result.armed, false);
      assert.equal(result.issues[0].code, PROVENANCE_CODES.MARKER_MISSING);
    } finally {
      await rm(tree.dir, { recursive: true, force: true });
    }
  });
});

describe('error messages', () => {
  it('stay generic and never echo configured absolute paths', async () => {
    const result = await probeProvenance({
      config: { testRoot: '/nonexistent/dsh-test-root', profileMarker: MARKER_FILE_NAME },
      ctx: ctxFor({ home, dir: profileDir }),
      env: goodEnv(),
    });
    assert.equal(result.armed, false);
    const text = JSON.stringify(result.issues);
    assert.ok(!text.includes('/nonexistent'));
    assert.ok(!text.includes(root));
    assert.ok(!text.includes(protectedAnchor));
  });

  it('never echo the protected home in a protected-anchor refusal', async () => {
    const result = await probeProvenance({
      config: { testRoot: root, profileMarker: MARKER_FILE_NAME },
      ctx: ctxFor({ home, dir: profileDir }),
      env: { ...SWITCH, DSH_HOME: home, [PROTECTED_HOME_ENV]: join(base, 'absent-anchor') },
    });
    const text = JSON.stringify(result.issues);
    assert.ok(!text.includes(join(base, 'absent-anchor')));
  });

  it('omit the protected home from the outward refusal receipt', async () => {
    const result = await probeProvenance({
      config: { testRoot: root, profileMarker: MARKER_FILE_NAME },
      ctx: ctxFor({ home: join(base, 'missing-home'), dir: profileDir }),
      env: goodEnv(),
    });
    const refusal = provenanceRefusal(result);
    assert.equal(refusal.ok, false);
    assert.equal('protectedHome' in refusal.provenance, false);
    assert.ok(!JSON.stringify(refusal).includes(protectedAnchor));
  });
});

describe('marker file contract', () => {
  it('is the fixed file name', async () => {
    // Guard against the marker name drifting away from the documented constant.
    assert.equal(MARKER_FILE_NAME, 'dsh-agent-test-driver.json');
    const text = await readFile(join(root, MARKER_FILE_NAME), 'utf8');
    assert.equal(JSON.parse(text).kind, MARKER_KIND);
  });
});
