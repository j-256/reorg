// Integration tests: these run real moves against real temp directories, and
// verify the undo script by actually executing it. A resolver that is correct on
// paper but wrong on disk is worthless, so nothing here is mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from '../src/scan.js';
import { resolve, OP } from '../src/plan.js';
import { apply, checkDrift, buildUndoScript } from '../src/apply.js';
import { emptyPlan, loadPlan, savePlan, planPath, clearAppliedPlan } from '../src/state.js';

function sandbox(layout, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reorg-test-'));
  for (const [p, content] of Object.entries(layout)) {
    const abs = join(root, p);
    if (p.endsWith('/')) {
      mkdirSync(abs, { recursive: true });
    } else {
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content ?? p);
    }
  }
  if (opts.git) {
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'config', 'user.name', 'test'], { stdio: 'ignore' });
    if (opts.commit !== false) {
      execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'commit', '-qm', 'init'], { stdio: 'ignore' });
    }
  }
  return root;
}

const cleanup = [];
const box = (...a) => {
  const r = sandbox(...a);
  cleanup.push(r);
  return r;
};
test.after(() => {
  for (const r of cleanup) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function planWith(over) {
  return { ...emptyPlan(), ...over };
}

test('dry run is the default and touches nothing', () => {
  const root = box({ 'a/x.txt': 'hello', 'b/': null });
  const s = scan(root);
  const { ops } = resolve(s, planWith({ overrides: [{ id: 'a/x.txt', cur: { name: 'x.txt', parentId: 'b' } }] }));
  const lines = [];
  const res = apply(root, ops, { onLog: (l) => lines.push(l) });

  assert.equal(res.dryRun, true);
  assert.equal(res.applied, 0);
  assert.ok(existsSync(join(root, 'a/x.txt')), 'source must be untouched');
  assert.ok(!existsSync(join(root, 'b/x.txt')), 'destination must not be created');
  assert.match(lines.join('\n'), /a\/x\.txt.*->.*b\/x\.txt/);
  // No .reorg/ is created by a dry run either.
  assert.ok(!existsSync(join(root, '.reorg', 'undo-1.sh')));
});

test('apply moves files and preserves their contents', () => {
  const root = box({ 'a/x.txt': 'payload', 'b/': null });
  const s = scan(root);
  const { ops } = resolve(s, planWith({ overrides: [{ id: 'a/x.txt', cur: { name: 'x.txt', parentId: 'b' } }] }));
  const res = apply(root, ops, { dryRun: false, stamp: 'T1' });

  assert.equal(res.applied, 1);
  assert.ok(!existsSync(join(root, 'a/x.txt')));
  assert.equal(readFileSync(join(root, 'b/x.txt'), 'utf8'), 'payload');
});

test('undo script restores the original layout byte for byte', () => {
  const root = box({
    'docs/readme.md': '# readme',
    'docs/deep/note.txt': 'note',
    'img/logo.png': 'PNG',
  });
  const s = scan(root);
  const { ops } = resolve(
    s,
    planWith({
      created: [{ id: 'new:1', cur: { name: 'assets', parentId: '.' } }],
      overrides: [
        { id: 'img', cur: { name: 'images', parentId: 'new:1' } },
        { id: 'docs/deep/note.txt', cur: { name: 'note.txt', parentId: 'docs' } },
      ],
    })
  );
  const res = apply(root, ops, { dryRun: false, stamp: 'T2' });
  assert.ok(res.applied >= 3);
  assert.equal(readFileSync(join(root, 'assets/images/logo.png'), 'utf8'), 'PNG');
  assert.equal(readFileSync(join(root, 'docs/note.txt'), 'utf8'), 'note');

  execFileSync('bash', [res.undoPath], { stdio: 'ignore' });

  assert.equal(readFileSync(join(root, 'img/logo.png'), 'utf8'), 'PNG');
  assert.equal(readFileSync(join(root, 'docs/deep/note.txt'), 'utf8'), 'note');
  assert.equal(readFileSync(join(root, 'docs/readme.md'), 'utf8'), '# readme');
  assert.ok(!existsSync(join(root, 'assets/images')), 'created dir should be gone');
});

test('trash moves into .reorg/trash and undo brings it back', () => {
  const root = box({ 'junk/old.log': 'noise', 'keep.txt': 'keep' });
  const s = scan(root);
  const { ops } = resolve(
    s,
    planWith({
      overrides: [
        { id: 'junk', cur: { name: 'junk', parentId: '.' }, evicted: true },
        { id: 'junk/old.log', cur: { name: 'old.log', parentId: 'junk' }, evicted: true },
      ],
    })
  );
  const res = apply(root, ops, { dryRun: false, stamp: 'T3' });

  assert.ok(!existsSync(join(root, 'junk')), 'trashed dir leaves the tree');
  assert.equal(
    readFileSync(join(root, '.reorg/trash/T3/junk/old.log'), 'utf8'),
    'noise',
    'nothing is deleted -- it is recoverable from .reorg/trash'
  );

  execFileSync('bash', [res.undoPath], { stdio: 'ignore' });
  assert.equal(readFileSync(join(root, 'junk/old.log'), 'utf8'), 'noise');
});

test('a rename swap round-trips on disk via staging', () => {
  const root = box({ 'a/mark': 'A', 'b/mark': 'B' });
  const s = scan(root);
  const { ops } = resolve(
    s,
    planWith({
      overrides: [
        { id: 'a', cur: { name: 'b', parentId: '.' } },
        { id: 'b', cur: { name: 'a', parentId: '.' } },
      ],
    })
  );
  const res = apply(root, ops, { dryRun: false, stamp: 'T4' });

  assert.equal(readFileSync(join(root, 'b/mark'), 'utf8'), 'A', 'a became b');
  assert.equal(readFileSync(join(root, 'a/mark'), 'utf8'), 'B', 'b became a');

  execFileSync('bash', [res.undoPath], { stdio: 'ignore' });
  assert.equal(readFileSync(join(root, 'a/mark'), 'utf8'), 'A');
  assert.equal(readFileSync(join(root, 'b/mark'), 'utf8'), 'B');
});

test('drift aborts the whole run rather than applying it partially', () => {
  const root = box({ 'a/x.txt': 'x', 'a/y.txt': 'y', 'b/': null });
  const s = scan(root);
  const { ops } = resolve(
    s,
    planWith({
      overrides: [
        { id: 'a/x.txt', cur: { name: 'x.txt', parentId: 'b' } },
        { id: 'a/y.txt', cur: { name: 'y.txt', parentId: 'b' } },
      ],
    })
  );
  // Someone deletes a/x.txt after the scan.
  rmSync(join(root, 'a/x.txt'));

  const res = apply(root, ops, { dryRun: false, stamp: 'T5' });
  assert.equal(res.applied, 0);
  assert.equal(res.problems.length, 1);
  assert.match(res.problems[0], /a\/x\.txt no longer exists/);
  assert.ok(existsSync(join(root, 'a/y.txt')), 'the other move must not have run');
});

test('drift refuses to overwrite a destination that appeared since the scan', () => {
  const root = box({ 'a/x.txt': 'x', 'b/': null });
  const s = scan(root);
  const { ops } = resolve(s, planWith({ overrides: [{ id: 'a/x.txt', cur: { name: 'x.txt', parentId: 'b' } }] }));
  writeFileSync(join(root, 'b/x.txt'), 'PRECIOUS');

  const res = apply(root, ops, { dryRun: false, stamp: 'T6' });
  assert.equal(res.applied, 0);
  assert.match(res.problems[0], /already exists/);
  assert.equal(readFileSync(join(root, 'b/x.txt'), 'utf8'), 'PRECIOUS', 'must not be clobbered');
});

test('undo is safe to run twice: the second pass skips instead of failing', () => {
  const root = box({ 'a/x.txt': 'x', 'b/': null });
  const s = scan(root);
  const { ops } = resolve(s, planWith({ overrides: [{ id: 'a/x.txt', cur: { name: 'x.txt', parentId: 'b' } }] }));
  const res = apply(root, ops, { dryRun: false, stamp: 'T7' });

  execFileSync('bash', [res.undoPath], { stdio: 'ignore' });
  const out = execFileSync('bash', [res.undoPath], { encoding: 'utf8' });
  assert.match(out, /skip \(missing\)/);
  assert.equal(readFileSync(join(root, 'a/x.txt'), 'utf8'), 'x', 'still in the restored spot');
});

test('tracked files move with git mv so history follows', () => {
  const root = box({ 'src/app.js': 'code', 'lib/': null }, { git: true });
  const s = scan(root);
  assert.equal(s.git, true, 'scan should detect the repo');
  assert.equal(s.nodes.find((n) => n.id === 'src/app.js').git, 'tracked');

  const { ops } = resolve(s, planWith({ overrides: [{ id: 'src/app.js', cur: { name: 'app.js', parentId: 'lib' } }] }));
  apply(root, ops, { dryRun: false, stamp: 'T8' });

  const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.match(status, /^R/m, 'git should see a staged rename, not an add+delete');
});

test('an untracked-only directory still moves (git mv would refuse it)', () => {
  // git mv fails on a fully-untracked dir ("source directory is empty"); the
  // fallback to a plain rename is what makes mixed trees work at all.
  const root = box({ 'tracked.txt': 't' }, { git: true });
  mkdirSync(join(root, 'scratch'), { recursive: true });
  writeFileSync(join(root, 'scratch/note.txt'), 'n');
  mkdirSync(join(root, 'dest'), { recursive: true });

  const s = scan(root);
  assert.equal(s.nodes.find((n) => n.id === 'scratch').git, 'untracked');
  const { ops } = resolve(s, planWith({ overrides: [{ id: 'scratch', cur: { name: 'scratch', parentId: 'dest' } }] }));
  const res = apply(root, ops, { dryRun: false, stamp: 'T9' });

  assert.equal(res.applied, 1);
  assert.equal(readFileSync(join(root, 'dest/scratch/note.txt'), 'utf8'), 'n');
});

test('.reorg is excluded from the scan and self-ignored in git', () => {
  const root = box({ 'a.txt': 'a' }, { git: true });
  savePlan(root, planWith({ notes: [{ id: 'n1', target: '.', body: 'hi' }] }));

  const s = scan(root);
  assert.ok(!s.nodes.some((n) => n.id.startsWith('.reorg')), 'planner state is not part of the tree');

  const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.ok(!status.includes('.reorg'), 'planning a repo must not dirty it');
});

test('a saved plan round-trips through load', () => {
  const root = box({ 'a/x.txt': 'x' });
  const p = planWith({ overrides: [{ id: 'a/x.txt', cur: { name: 'y.txt', parentId: 'a' } }] });
  savePlan(root, p);
  assert.ok(existsSync(planPath(root)));
  const back = loadPlan(root);
  assert.deepEqual(back.overrides, p.overrides);
  assert.ok(back.savedAt, 'save stamps a timestamp');
});

test('an empty op list is a clean no-op, not an error', () => {
  const root = box({ 'a.txt': 'a' });
  assert.deepEqual(checkDrift(root, []), []);
  const res = apply(root, [], { dryRun: false, stamp: 'T10' });
  assert.equal(res.applied, 0);
  assert.equal(res.problems.length, 0);
});

test('a broken symlink moves and round-trips instead of aborting the batch', () => {
  // Found while test-driving a real scratch directory. existsSync() and shell -e
  // both follow symlinks, so a dangling link reads as absent -- which made the
  // drift check call it "gone since the scan" and refuse the whole plan, over an
  // entry sitting right there. Scratch directories are full of these.
  const root = box({ 'keep.txt': 'keep', 'real.txt': 'real' });
  symlinkSync('/nonexistent/nowhere', join(root, 'dangling'));
  symlinkSync('real.txt', join(root, 'alias'));

  const s = scan(root);
  assert.equal(s.nodes.find((n) => n.name === 'dangling').kind, 'link');
  assert.match(s.nodes.find((n) => n.name === 'dangling').meta, /nowhere/);

  const { ops, problems } = resolve(
    s,
    planWith({
      created: [{ id: 'new:1', cur: { name: 'links', parentId: '.' } }],
      overrides: [
        { id: 'dangling', cur: { name: 'dangling', parentId: 'new:1' } },
        { id: 'alias', cur: { name: 'alias', parentId: 'new:1' } },
      ],
    })
  );
  assert.deepEqual(problems, []);

  const res = apply(root, ops, { dryRun: false, stamp: 'T14' });
  assert.deepEqual(res.problems, [], 'a dangling link must not abort the batch');
  assert.equal(res.applied, 3);
  assert.ok(lstatSync(join(root, 'links/dangling')).isSymbolicLink(), 'still a link, not dereferenced');
  assert.ok(lstatSync(join(root, 'links/alias')).isSymbolicLink());

  execFileSync('bash', [res.undoPath], { stdio: 'ignore' });
  assert.ok(lstatSync(join(root, 'dangling')).isSymbolicLink(), 'undo restores the broken link too');
  assert.equal(readFileSync(join(root, 'real.txt'), 'utf8'), 'real', 'the target was never touched');
});

test('a symlink to a directory is never descended into', () => {
  // Following it would double-count the tree, or loop forever on a self-reference.
  const root = box({ 'real/a.txt': 'a', 'real/b.txt': 'b' });
  symlinkSync(join(root, 'real'), join(root, 'mirror'));
  symlinkSync(join(root, '.'), join(root, 'selfref'));

  const s = scan(root);
  assert.equal(s.nodes.find((n) => n.name === 'mirror').kind, 'link');
  assert.equal(s.nodes.filter((n) => n.parentId === 'mirror').length, 0);
  assert.equal(s.nodes.filter((n) => n.parentId === 'selfref').length, 0, 'no infinite recursion');
  assert.equal(s.nodes.filter((n) => n.kind === 'file').length, 2, 'each real file counted once');
});

test('a big directory collapses on its own weight, whatever it is called', () => {
  // The real-world case this exists for: an unpacked release archive with an
  // unguessable name. A name-based list will never catch those, and without a
  // size rule one such directory floods the tree with thousands of rows that
  // bury everything you actually wanted to triage.
  const files = { 'keep.txt': 'keep' };
  for (let i = 0; i < 60; i++) files[`20260630_ci_release_candidate/f${i}.txt`] = 'x';
  const root = box(files);

  const s = scan(root, { collapseOver: 20 });
  const big = s.nodes.find((n) => n.id === '20260630_ci_release_candidate');
  assert.ok(big.collapsedSubtree, 'collapsed despite an unrecognized name');
  assert.equal(big.files, 60, 'reports a full, honest tally -- not the probe budget');
  assert.ok(!s.nodes.some((n) => n.id.startsWith('20260630_ci_release_candidate/')), 'children not emitted');
  assert.ok(
    s.collapsed.some((c) => c.id === '20260630_ci_release_candidate'),
    'and says what it declined to expand, so the omission is visible'
  );
  assert.ok(s.nodes.some((n) => n.id === 'keep.txt'), 'small entries still listed');
});

test('--all descends into a directory the size rule would collapse', () => {
  const files = {};
  for (let i = 0; i < 30; i++) files[`bulk/f${i}.txt`] = 'x';
  const root = box(files);

  const collapsed = scan(root, { collapseOver: 10 });
  assert.ok(collapsed.nodes.find((n) => n.id === 'bulk').collapsedSubtree);

  const expanded = scan(root, { collapseOver: 10, all: true });
  assert.ok(!expanded.nodes.find((n) => n.id === 'bulk').collapsedSubtree, 'all: descends anyway');
  assert.equal(expanded.nodes.filter((n) => n.id.startsWith('bulk/')).length, 30);
});

test('retiring an applied plan stops it colliding with what it just created', () => {
  // The trap: a plan that creates `assets/` is applied, so `assets/` now exists on
  // disk. Rescan with the plan still in place and the resolver sees two entries
  // heading for one path -- the real folder and the pending creation. Retiring the
  // applied plan is what keeps `reorg status` honest after an apply.
  const root = box({ 'img/logo.png': 'PNG' });
  const s1 = scan(root);
  const p = planWith({
    created: [{ id: 'new:1', cur: { name: 'assets', parentId: '.' } }],
    overrides: [{ id: 'img', cur: { name: 'images', parentId: 'new:1' } }],
  });
  savePlan(root, p);

  const { ops } = resolve(s1, p);
  apply(root, ops, { dryRun: false, stamp: 'T13' });
  assert.ok(existsSync(join(root, 'assets/images/logo.png')));

  // Before retiring: a phantom collision on the folder we just made.
  const stale = resolve(scan(root), loadPlan(root));
  assert.ok(
    stale.problems.some((x) => /would land on "assets"/.test(x.message)),
    'this is the bug the retire step exists to prevent'
  );

  clearAppliedPlan(root);
  const fresh = resolve(scan(root), loadPlan(root));
  assert.deepEqual(fresh.problems, [], 'no problems once the applied plan is retired');
  assert.equal(fresh.ops.length, 0, 'and nothing left to do');
});

test('retiring a plan keeps notes and summaries', () => {
  // Notes and summaries describe content, not pending moves, so an apply must not
  // discard the labeling work that made the plan possible.
  const root = box({ 'a.txt': 'a' });
  savePlan(
    root,
    planWith({
      overrides: [{ id: 'a.txt', cur: { name: 'b.txt', parentId: '.' } }],
      notes: [{ id: 'note:1', target: 'a.txt', body: 'why this moved' }],
      summaries: { 'a.txt': 'a one-line description' },
    })
  );
  clearAppliedPlan(root);
  const after = loadPlan(root);
  assert.deepEqual(after.overrides, []);
  assert.equal(after.notes.length, 1);
  assert.equal(after.summaries['a.txt'], 'a one-line description');
});

test('undo script quotes paths with spaces and quotes safely', () => {
  const nasty = "we ird/it's here.txt";
  const script = buildUndoScript([{ op: OP.MOVE, from: nasty, to: 'dest/file.txt' }], 'T11');
  assert.match(script, /'we ird\/it'\\''s here\.txt'/);
});

test('paths with spaces and quotes survive a real apply and undo', () => {
  const root = box({ "we ird/it's here.txt": 'tricky', 'dest/': null });
  const s = scan(root);
  const id = "we ird/it's here.txt";
  const { ops } = resolve(s, planWith({ overrides: [{ id, cur: { name: "it's here.txt", parentId: 'dest' } }] }));
  const res = apply(root, ops, { dryRun: false, stamp: 'T12' });

  assert.equal(readFileSync(join(root, "dest/it's here.txt"), 'utf8'), 'tricky');
  execFileSync('bash', [res.undoPath], { stdio: 'ignore' });
  assert.equal(readFileSync(join(root, id), 'utf8'), 'tricky');
});
