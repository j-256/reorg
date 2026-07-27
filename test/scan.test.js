// Scanner tests: the limits, and the shape of what the planner receives.
//
// The scan is the ceiling on everything downstream -- a node the scan never
// emitted cannot be planned, moved, or trashed -- so the guards that stop a
// pathological tree from hanging the process are load-bearing, not tuning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { scan, readGitignore, formatBytes, ROOT_ID } from '../src/scan.js';
import { sandbox, cleanup, manyFiles } from './helpers.js';

const byId = (s) => new Map(s.nodes.map((n) => [n.id, n]));

test('ids are root-relative paths, so a plan can reattach after a rescan', () => {
  const root = sandbox({ 'a.txt': 'a', 'dir/b.txt': 'b', 'dir/deep/c.txt': 'c' });
  try {
    const ids = scan(root).nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, ['a.txt', 'dir', 'dir/b.txt', 'dir/deep', 'dir/deep/c.txt']);
  } finally {
    cleanup(root);
  }
});

test('parent links form a tree rooted at the scan root', () => {
  const root = sandbox({ 'dir/deep/c.txt': 'c' });
  try {
    const nodes = byId(scan(root));
    assert.equal(nodes.get('dir').parentId, ROOT_ID);
    assert.equal(nodes.get('dir/deep').parentId, 'dir');
    assert.equal(nodes.get('dir/deep/c.txt').parentId, 'dir/deep');
  } finally {
    cleanup(root);
  }
});

test('.git, .DS_Store, and .reorg are never emitted at all', () => {
  const root = sandbox({
    '.git/config': 'x',
    '.DS_Store': 'x',
    '.reorg/plan.json': '{}',
    'real.txt': 'keep',
  });
  try {
    const names = scan(root).nodes.map((n) => n.name);
    assert.deepEqual(names, ['real.txt']);
  } finally {
    cleanup(root);
  }
});

test('--no-hidden skips dotfiles, and the default keeps them', () => {
  const root = sandbox({ '.bashrc': 'x', 'visible.txt': 'y' });
  try {
    assert.ok(scan(root).nodes.some((n) => n.name === '.bashrc'));
    const hidden = scan(root, { hidden: false }).nodes.map((n) => n.name);
    assert.deepEqual(hidden, ['visible.txt']);
  } finally {
    cleanup(root);
  }
});

test('maxNodes truncates the scan and says so rather than running away', () => {
  const root = sandbox(manyFiles('flat', 40));
  try {
    const s = scan(root, { maxNodes: 10 });
    assert.equal(s.truncated, true);
    assert.ok(s.nodes.length <= 10, `expected <= 10 nodes, got ${s.nodes.length}`);

    const full = scan(root, { maxNodes: 1000 });
    assert.ok(!full.truncated);
  } finally {
    cleanup(root);
  }
});

test('maxDepth stops descending and labels the boundary directory', () => {
  const root = sandbox({ 'l1/l2/l3/l4/deep.txt': 'x' });
  try {
    // The boundary directory itself is emitted and labelled; its contents are not.
    const nodes = byId(scan(root, { maxDepth: 2 }));
    assert.ok(nodes.has('l1/l2/l3'), 'the depth-limit boundary is still emitted');
    assert.ok(!nodes.has('l1/l2/l3/l4'), 'nothing past the limit is emitted');
    assert.match(nodes.get('l1/l2/l3').meta || '', /too deep/);
    assert.equal(nodes.get('l1/l2/l3').collapsedSubtree, true);
  } finally {
    cleanup(root);
  }
});

test('a directory over the collapse threshold becomes one row with a real tally', () => {
  const root = sandbox(manyFiles('bulk', 12));
  try {
    const nodes = byId(scan(root, { collapseOver: 5 }));
    const bulk = nodes.get('bulk');
    assert.equal(bulk.collapsedSubtree, true);
    assert.equal(bulk.files, 12, 'a collapsed dir reports its full count, not the probe budget');
    assert.match(bulk.meta, /12 files/);
    assert.ok(!nodes.has('bulk/f0.txt'), 'a collapsed dir is not descended into');
  } finally {
    cleanup(root);
  }
});

test('a directory under the threshold is descended into normally', () => {
  const root = sandbox(manyFiles('small', 3));
  try {
    const nodes = byId(scan(root, { collapseOver: 100 }));
    assert.ok(!nodes.get('small').collapsedSubtree);
    assert.ok(nodes.has('small/f0.txt'));
  } finally {
    cleanup(root);
  }
});

test('conventional build directories collapse by name, and --all descends anyway', () => {
  const root = sandbox({ 'node_modules/pkg/index.js': 'x', 'src/main.js': 'y' });
  try {
    const collapsed = byId(scan(root));
    assert.equal(collapsed.get('node_modules').collapsedSubtree, true);
    assert.ok(!collapsed.has('node_modules/pkg'));

    const all = byId(scan(root, { all: true }));
    assert.ok(all.has('node_modules/pkg/index.js'), '--all ignores the collapse rules');
  } finally {
    cleanup(root);
  }
});

test('a nested repo is collapsed and labelled instead of being walked into', () => {
  const root = sandbox({ 'outer.txt': 'x' });
  try {
    mkdirSync(join(root, 'vendored'), { recursive: true });
    writeFileSync(join(root, 'vendored', 'file.txt'), 'y');
    mkdirSync(join(root, 'vendored', '.git'), { recursive: true });
    writeFileSync(join(root, 'vendored', '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const nodes = byId(scan(root));
    const v = nodes.get('vendored');
    assert.equal(v.nestedRepo, true);
    assert.equal(v.collapsedSubtree, true);
    assert.match(v.meta, /nested repo/);
    assert.ok(!nodes.has('vendored/file.txt'));
  } finally {
    cleanup(root);
  }
});

test('symlinks are reported as links with their target, never followed', () => {
  const root = sandbox({ 'real/file.txt': 'x' });
  try {
    symlinkSync(join(root, 'real'), join(root, 'link-to-dir'));
    symlinkSync(join(root, 'nowhere'), join(root, 'broken'));

    const nodes = byId(scan(root));
    assert.equal(nodes.get('link-to-dir').kind, 'link');
    assert.ok(!nodes.has('link-to-dir/file.txt'), 'a symlinked dir is not descended into');

    const broken = nodes.get('broken');
    assert.equal(broken.kind, 'link');
    assert.match(broken.meta, /broken link|->/);
  } finally {
    cleanup(root);
  }
});

test('directory sizes roll up from their children', () => {
  const root = sandbox({ 'dir/a.txt': 'x'.repeat(100), 'dir/b.txt': 'y'.repeat(50) });
  try {
    const dir = byId(scan(root)).get('dir');
    assert.equal(dir.bytes, 150);
  } finally {
    cleanup(root);
  }
});

test('git status is attached inside a repo and absent outside one', () => {
  const tracked = sandbox({ 'committed.txt': 'x' }, { git: true });
  const plain = sandbox({ 'committed.txt': 'x' });
  try {
    const inRepo = byId(scan(tracked)).get('committed.txt');
    assert.ok(inRepo.git, 'a tracked file carries git state');

    const outside = byId(scan(plain)).get('committed.txt');
    assert.ok(!outside.git, 'outside a repo there is no git layer');
  } finally {
    cleanup(tracked);
    cleanup(plain);
  }
});

test('an untracked file in a repo is distinguished from a tracked one', () => {
  const root = sandbox({ 'committed.txt': 'x' }, { git: true });
  try {
    writeFileSync(join(root, 'untracked.txt'), 'y');
    const nodes = byId(scan(root));
    assert.notEqual(nodes.get('committed.txt').git, nodes.get('untracked.txt').git);
  } finally {
    cleanup(root);
  }
});

test('an unreadable directory is skipped rather than aborting the scan', (t) => {
  // Running as root defeats the permission bits, so this cannot be asserted there.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('cannot revoke read access from root');
    return;
  }
  const root = sandbox({ 'readable.txt': 'x', 'locked/inner.txt': 'y' });
  const locked = join(root, 'locked');
  try {
    chmodSync(locked, 0o000);
    const s = scan(root);
    assert.ok(
      s.nodes.some((n) => n.name === 'readable.txt'),
      'the rest of the tree still comes back'
    );
    assert.ok(!s.nodes.some((n) => n.name === 'inner.txt'), 'the unreadable subtree is simply absent');
  } finally {
    chmodSync(locked, 0o755); // restore so cleanup can remove it
    cleanup(root);
  }
});

test('readGitignore reads the committed file, and is empty outside a repo', () => {
  // It reads `HEAD:.gitignore` rather than the working copy, so an uncommitted
  // file is deliberately not reported -- the planner is showing what the repo
  // ignores, not what someone is mid-edit on.
  const committed = sandbox({ '.gitignore': 'node_modules/\n*.log\n' }, { git: true });
  const uncommitted = sandbox({ '.gitignore': 'node_modules/\n' }, { git: true, commit: false });
  const noRepo = sandbox({ '.gitignore': 'node_modules/\n' });
  try {
    assert.match(readGitignore(committed), /node_modules/);
    assert.equal(readGitignore(uncommitted), '');
    assert.equal(readGitignore(noRepo), '');
  } finally {
    cleanup(committed);
    cleanup(uncommitted);
    cleanup(noRepo);
  }
});

test('formatBytes is human-readable across magnitudes', () => {
  assert.match(formatBytes(0), /0/);
  assert.match(formatBytes(999), /B/);
  assert.match(formatBytes(1024 * 1024), /MB|KB/);
  assert.match(formatBytes(5 * 1024 * 1024 * 1024), /GB/);
});
