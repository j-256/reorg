// Cleanup signals.
//
// The cases here are drawn from a real scratch directory, because that is what
// falsified the obvious design. The load-bearing assertion in this file is the
// negative one: age must not rank anything, and a word like "trash" or
// "duplicate" appearing DESCRIPTIVELY must not flag a file. Those were the two
// ways an age-or-keyword ranker got real files wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalsFor, analyze, ranked, archiveBase, SIGNAL } from '../src/signals.js';

const node = (name, over = {}) => ({ name, kind: 'file', parentId: '.', bytes: 100, mtime: null, ...over });
const dir = (name, over = {}) => node(name, { kind: 'dir', files: 1, ...over });
const sig = (n, siblings = []) => signalsFor(n, new Set(siblings));
const ids = (n, siblings = []) => sig(n, siblings).map((s) => s.id);

/* ---------------------------------------------------------------- name signals */

test('a name stating temporary intent is flagged', () => {
  for (const name of [
    'work-backup-20260317',
    'ccam-v1-root-dryrun-20260425',
    'cc-skills-mirror-backup-prerewrite.git',
    'x-backup-prepurge.gitcrypt-key',
    'amapi-samples.tmp.md',
    'notes.bak',
    'thing-deleteme.json',
  ]) {
    assert.ok(ids(node(name)).includes(SIGNAL.DISPOSABLE_NAME), `${name} should be flagged`);
  }
});

test('a name merely CONTAINING a disposable word is not flagged', () => {
  // The real false positives. "all-mail-including-spam-and-trash.mbox" is three
  // gigabytes of actual mail; "mobile-07-duplicate-batteries.png" is a screenshot
  // documenting a duplicate-rendering bug. Both describe their subject, not their
  // status, and flagging either is how a suggestion list loses a user's trust.
  for (const name of [
    'all-mail-including-spam-and-trash.mbox',
    'mobile-07-duplicate-batteries.png',
    'mobile-29-duplicate-labels-fixed.png',
    'backup-strategy-notes.md',
    'how-to-restore-from-a-copy.md',
    'trash-can-icon.svg',
  ]) {
    assert.deepEqual(ids(node(name)), [], `${name} must not be flagged`);
  }
});

test('a trailing version suffix on a short name still counts', () => {
  assert.ok(ids(node('notes-old.md')).includes(SIGNAL.DISPOSABLE_NAME));
  assert.ok(ids(node('config copy.json')).includes(SIGNAL.DISPOSABLE_NAME));
  assert.ok(ids(node('report-duplicate.pdf')).includes(SIGNAL.DISPOSABLE_NAME));
});

test('installers and scratch extensions are flagged', () => {
  assert.ok(ids(node('googlechromecanary.dmg')).includes(SIGNAL.INSTALLER));
  assert.ok(ids(node('PhraseExpressSetup.dmg')).includes(SIGNAL.INSTALLER));
  assert.ok(ids(node('server.log')).includes(SIGNAL.SCRATCH_EXT));
  assert.ok(ids(node('half.crdownload')).includes(SIGNAL.SCRATCH_EXT));
});

test('ordinary working files are left alone', () => {
  for (const name of [
    'README.md',
    'index.js',
    'volleyball-uniform-example.jpg',
    'delete-zones.sh', // a real script whose name starts with a verb, not a status
    '2026-07-03-certainty-layer-design.md',
  ]) {
    assert.deepEqual(ids(node(name)), [], `${name} must not be flagged`);
  }
});

/* ---------------------------------------------------------------- structural */

test('an archive beside its unpacked copy is the strongest signal', () => {
  const withTwin = sig(node('release_26_5.zip'), ['release_26_5.zip', 'release_26_5']);
  assert.equal(withTwin[0].id, SIGNAL.UNPACKED_TWIN);
  assert.ok(withTwin[0].weight >= 0.9, 'pure duplication should outrank everything else');
  assert.match(withTwin[0].why, /release_26_5/, 'names the twin so the claim is checkable');

  // The same file with no twin is only weakly interesting.
  const alone = sig(node('release_26_5.zip'), ['release_26_5.zip']);
  assert.equal(alone[0].id, SIGNAL.ARCHIVE);
  assert.ok(alone[0].weight < 0.5);
});

test('the unpacked directory is flagged from its own side too', () => {
  const d = sig(dir('ci_build'), ['ci_build', 'ci_build.zip']);
  assert.equal(d[0].id, SIGNAL.UNPACKED_TWIN);
  assert.match(d[0].label, /ci_build\.zip/);
});

test('archiveBase strips one archive extension, including double ones', () => {
  assert.equal(archiveBase('a.tar.gz'), 'a');
  assert.equal(archiveBase('a.zip'), 'a');
  assert.equal(archiveBase('a.tgz'), 'a');
  assert.equal(archiveBase('plain.md'), 'plain.md');
});

test('an empty directory is deliberately NOT a signal', () => {
  // Empty dirs are frequently intentional -- mount points, firmlink targets,
  // placeholders. On the directory that motivated this, the empty ones were
  // firmlink targets declared in synthetic.conf: deleting them breaks paths and
  // saves nothing.
  assert.deepEqual(ids(dir('0', { files: 0 })), []);
  assert.deepEqual(ids(dir('placeholder', { files: 0 })), []);
});

/* ---------------------------------------------------------------- age */

test('age is never a signal, however old the file is', () => {
  const ancient = node('somefile.md', { mtime: Date.now() - 5 * 365 * 86400000 });
  assert.deepEqual(ids(ancient), [], 'five years old, still not a candidate');

  // And a brand-new file with a disposable name IS flagged, so recency never
  // rescues something the name condemns.
  const fresh = node('work-backup-20260317', { mtime: Date.now() });
  assert.ok(ids(fresh).includes(SIGNAL.DISPOSABLE_NAME), 'age must not suppress a name signal');
});

test('two files with identical names rank identically regardless of age', () => {
  const old = node('notes.bak', { mtime: 0 });
  const recent = node('notes.bak', { mtime: Date.now() });
  assert.deepEqual(
    sig(old).map((s) => [s.id, s.weight]),
    sig(recent).map((s) => [s.id, s.weight])
  );
});

/* ---------------------------------------------------------------- analyze */

// analyze() reads scan-shaped nodes, so fill in what scan() always provides --
// including `id`, which is the node's path and the key everything is stored under.
function scanOf(nodes) {
  return {
    root: '/fake',
    nodes: nodes.map((n) => {
      const parentId = n.parentId ?? '.';
      return {
        kind: 'file',
        bytes: 0,
        files: null,
        mtime: null,
        ...n,
        parentId,
        id: n.id ?? (parentId === '.' ? n.name : `${parentId}/${n.name}`),
      };
    }),
  };
}

test('corroborating signals rank above a single one', () => {
  // Same base signal (a disposable name), so the corroboration is what separates
  // them: a dated, bulky backup directory beats a bare name with nothing else
  // supporting it.
  const a = analyze(
    scanOf([
      dir('work-backup-20260317', { files: 600 }), // name + date + bulky
      dir('work-backup'), // name alone
    ])
  );
  assert.deepEqual(ranked(a).map((r) => r.id), ['work-backup-20260317', 'work-backup']);
  assert.ok(a.get('work-backup-20260317').score > a.get('work-backup').score);
});

test('two independent signal types outrank one padded with weak corroboration', () => {
  // `.bak` is both an intent word and a scratch extension -- two different reasons
  // to think it is a byproduct -- which is a stronger claim than one name signal
  // propped up by a date and a file count. Worth pinning: it is the case where the
  // intuitive ordering ("more signals wins") is the wrong one.
  const a = analyze(scanOf([node('plain.bak'), dir('work-backup-20260317', { files: 600 })]));
  assert.equal(ranked(a)[0].id, 'plain.bak');
});

test('a pile of weak hints cannot outrank one decisive signal', () => {
  const a = analyze(
    scanOf([
      node('build.zip', { parentId: '.' }),
      dir('build', { parentId: '.', files: 900 }),
    ])
  );
  // build.zip has a real twin; the directory is bulky. The duplication wins.
  assert.equal(ranked(a)[0].id, 'build.zip');
});

test('children of a flagged directory are suppressed', () => {
  // Suggesting a file inside `foo-backup.git` adds nothing: the decision is about
  // the clone. Listing its innards buries the findings that need judgement.
  const a = analyze(
    scanOf([
      dir('cc-backup-prerewrite.git', { files: 40 }),
      node('HEAD', { parentId: 'cc-backup-prerewrite.git' }),
      node('packed-refs.bak', { parentId: 'cc-backup-prerewrite.git' }),
      node('keep.md', { parentId: '.' }),
    ])
  );
  assert.ok(a.has('cc-backup-prerewrite.git'));
  assert.ok(!a.has('packed-refs.bak'), 'a flagged child inside a flagged parent is redundant');
  assert.equal(a.size, 1);
});

test('ranked() breaks score ties on size, biggest first', () => {
  const a = analyze(
    scanOf([
      node('small.dmg', { bytes: 1000 }),
      node('huge.dmg', { bytes: 999_000_000 }),
    ])
  );
  assert.deepEqual(
    ranked(a).map((r) => r.id),
    ['huge.dmg', 'small.dmg']
  );
});

test('nothing is ever scored as certain', () => {
  const a = analyze(
    scanOf([dir('tmp-backup-copy-20260101-scratch', { files: 5000 })])
  );
  const score = [...a.values()][0].score;
  assert.ok(score < 1, 'the tool does not get to be certain about someone else prime files');
  assert.ok(score <= 0.95);
});

test('every signal carries a label and a reason a person can check', () => {
  const a = analyze(
    scanOf([
      dir('work-backup-20260317', { files: 600 }),
      node('x.dmg'),
      node('y.log'),
      node('b.zip'),
      dir('b', { files: 3 }),
    ])
  );
  for (const { signals } of a.values()) {
    for (const s of signals) {
      assert.ok(s.label && s.label.length < 60, 'a short label for the row');
      assert.ok(s.why && /\s/.test(s.why), 'a sentence explaining the claim');
      assert.ok(s.weight > 0 && s.weight <= 0.9);
    }
  }
});
