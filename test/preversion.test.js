// Tests for the release guard.
//
// The guard is the only thing standing between a stray `npm version` and a tag
// that points at an unpushed or off-main commit, so it gets real repos with real
// remotes rather than a mocked git.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'preversion.sh');

// Each failure must be identifiable on its own, not merely "mentions
// origin/main" -- three different failures once shared that substring, and a
// mutant that collapsed all three into one message passed every test
const BRANCH_FAIL = /releases come from main, but you are on/;
const FETCH_FAIL = /could not fetch origin\/main/;
const NO_REF_FAIL = /origin\/main not found/;
const DIVERGED_FAIL = /main and origin\/main differ/;

/** Temp trees to remove when the suite ends, so runs do not accumulate */
const temps = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Run git in `cwd`, quietly, failing loudly if git itself fails */
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * A clone with a real origin, one commit on main, pushed.
 * Returns the working clone's path.
 */
function repoWithRemote() {
  const root = tempDir('reorg-guard-');
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'test');
  writeFileSync(join(work, 'a.txt'), 'a');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-qm', 'init', '--', 'a.txt');
  git(work, 'push', '-q', 'origin', 'main');
  return work;
}

/** Run the guard in `cwd` and return { code, stderr } */
function runGuard(cwd) {
  const r = spawnSync('bash', [GUARD], { cwd, encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr };
}

test('passes on main, in sync with origin', () => {
  const repo = repoWithRemote();
  const { code } = runGuard(repo);
  assert.equal(code, 0);
});

test('fails off main, naming the branch check', () => {
  const repo = repoWithRemote();
  git(repo, 'checkout', '-q', '-b', 'feature');
  const { code, stderr } = runGuard(repo);
  assert.equal(code, 1);
  assert.match(stderr, BRANCH_FAIL);
  assert.match(stderr, /feature/);
});

// The branch comparison must be exact equality, not a prefix or substring
// match: "maintenance" starts with "main" and would otherwise be treated as the
// release branch. A prefix-match mutant passed every other test, since no other
// case uses a branch name that starts with main
test('fails on a branch whose name merely starts with main', () => {
  const repo = repoWithRemote();
  git(repo, 'checkout', '-q', '-b', 'maintenance');
  const { code, stderr } = runGuard(repo);
  assert.equal(code, 1);
  assert.match(stderr, BRANCH_FAIL);
  assert.match(stderr, /maintenance/);
});

test('fails when local main is ahead of origin', () => {
  const repo = repoWithRemote();
  writeFileSync(join(repo, 'b.txt'), 'b');
  git(repo, 'add', 'b.txt');
  git(repo, 'commit', '-qm', 'second', '--', 'b.txt');
  const { code, stderr } = runGuard(repo);
  assert.equal(code, 1);
  assert.match(stderr, DIVERGED_FAIL);
});

test('fails when local main is behind origin', () => {
  const repo = repoWithRemote();
  // Advance origin behind our back: clone a second worktree, commit, push
  const other = tempDir('reorg-guard-other-');
  const originUrl = git(repo, 'remote', 'get-url', 'origin').trim();
  execFileSync('git', ['clone', '-q', originUrl, other], { stdio: 'ignore' });
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'test');
  writeFileSync(join(other, 'c.txt'), 'c');
  git(other, 'add', 'c.txt');
  git(other, 'commit', '-qm', 'theirs', '--', 'c.txt');
  git(other, 'push', '-q', 'origin', 'main');

  const { code, stderr } = runGuard(repo);
  assert.equal(code, 1);
  assert.match(stderr, DIVERGED_FAIL);
});

// Distinct from the case below: here the remote is reachable and the fetch
// SUCCEEDS, so the guard runs on to the ref check. That is the only path to the
// rev-parse --verify branch -- `git fetch origin main` recreates a deleted
// origin/main, so deleting the ref cannot reach it. Without this test the whole
// branch was dead: removing it from the guard kept every test green.
test('fails when the fetch succeeds but origin/main is absent', () => {
  const root = tempDir('reorg-guard-noref-');
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const work = join(root, 'work');

  // An origin that really does have main, so fetching it succeeds
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' });
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'test');
  writeFileSync(join(seed, 'a.txt'), 'a');
  git(seed, 'add', 'a.txt');
  git(seed, 'commit', '-qm', 'init', '--', 'a.txt');
  git(seed, 'push', '-q', 'origin', 'main');

  // A repo pointed at that origin by URL alone: no fetch refspec, so no
  // remote-tracking ref is ever written
  execFileSync('git', ['init', '-q', '-b', 'main', work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'test');
  writeFileSync(join(work, 'a.txt'), 'a');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-qm', 'init', '--', 'a.txt');
  git(work, 'config', 'remote.origin.url', origin);

  const { code, stderr } = runGuard(work);
  assert.equal(code, 1);
  assert.match(stderr, NO_REF_FAIL);
  // A missing ref must not surface as git's raw "ambiguous argument" noise
  assert.doesNotMatch(stderr, /ambiguous argument/);
});

test('fails when there is no remote to fetch', () => {
  const root = tempDir('reorg-guard-solo-');
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' });
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  writeFileSync(join(root, 'a.txt'), 'a');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-qm', 'init', '--', 'a.txt');
  const { code, stderr } = runGuard(root);
  assert.equal(code, 1);
  assert.match(stderr, FETCH_FAIL);
});
