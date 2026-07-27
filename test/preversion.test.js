// Tests for the release guard.
//
// The guard is the only thing standing between a stray `npm version` and a tag
// that points at an unpushed or off-main commit, so it gets real repos with real
// remotes rather than a mocked git.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'preversion.sh');

/** Run git in `cwd`, quietly, failing loudly if git itself fails */
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * A clone with a real origin, one commit on main, pushed.
 * Returns the working clone's path.
 */
function repoWithRemote() {
  const root = mkdtempSync(join(tmpdir(), 'reorg-guard-'));
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
  assert.match(stderr, /main/);
  assert.match(stderr, /feature/);
});

test('fails when local main is ahead of origin', () => {
  const repo = repoWithRemote();
  writeFileSync(join(repo, 'b.txt'), 'b');
  git(repo, 'add', 'b.txt');
  git(repo, 'commit', '-qm', 'second', '--', 'b.txt');
  const { code, stderr } = runGuard(repo);
  assert.equal(code, 1);
  assert.match(stderr, /origin\/main/);
});

test('fails when local main is behind origin', () => {
  const repo = repoWithRemote();
  // Advance origin behind our back: clone a second worktree, commit, push
  const other = mkdtempSync(join(tmpdir(), 'reorg-guard-other-'));
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
  assert.match(stderr, /origin\/main/);
});

test('fails clearly when origin/main does not exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'reorg-guard-solo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' });
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  writeFileSync(join(root, 'a.txt'), 'a');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-qm', 'init', '--', 'a.txt');
  const { code, stderr } = runGuard(root);
  assert.equal(code, 1);
  assert.match(stderr, /origin\/main/);
  // The point of this case: a missing ref must not surface as git's raw
  // "ambiguous argument" noise
  assert.doesNotMatch(stderr, /ambiguous argument/);
});
