import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { apply } from '../src/apply.js';
import { resolve } from '../src/plan.js';
import { scan } from '../src/scan.js';
import { sandbox, cleanup } from './helpers.js';

const STAMP = 'recovery-test';
const INTERRUPTED = 'simulated interruption';

function fixture(t, layout = {}) {
  const root = sandbox(layout);
  t.after(() => cleanup(root));
  return root;
}

function undo(root) {
  return execFileSync('/bin/bash', [join(root, `.reorg/undo-${STAMP}.sh`)], { encoding: 'utf8' });
}

for (const names of [['a', 'b'], ['a', 'b', 'c']]) {
  for (let cutoff = 1; cutoff <= names.length * 2; cutoff++) {
    test(`interrupted ${names.length}-entry cycle recovers after operation ${cutoff} and stays restored`, (t) => {
      const root = fixture(t, Object.fromEntries(names.map(name => [name, name.toUpperCase()])));
      const { ops, problems } = resolve(scan(root), { overrides: names.map((name, index) => ({
        id: name, cur: { name: names[(index + 1) % names.length], parentId: '.' },
      })) });
      assert.deepEqual(problems, []);
      let progress = 0;
      try {
        apply(root, ops, { dryRun: false, useGit: false, stamp: STAMP, onLog() {
          if (++progress === cutoff) throw new Error(INTERRUPTED);
        } });
      } catch (error) {
        assert.equal(error.message, INTERRUPTED);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        undo(root);
        for (const name of names) assert.equal(readFileSync(join(root, name), 'utf8'), name.toUpperCase());
      }
    });
  }
}

test('rename chains with hardlinked entries stay restored on repeated undo', (t) => {
  const root = fixture(t, { a: 'shared contents' });
  linkSync(join(root, 'a'), join(root, 'b'));
  const { ops } = resolve(scan(root), { overrides: [
    { id: 'a', cur: { name: 'b', parentId: '.' } },
    { id: 'b', cur: { name: 'c', parentId: '.' } },
  ] });
  apply(root, ops, { dryRun: false, useGit: false, stamp: STAMP });
  for (let attempt = 0; attempt < 2; attempt++) {
    undo(root);
    assert.equal(lstatSync(join(root, 'a')).ino, lstatSync(join(root, 'b')).ino);
    assert.equal(existsSync(join(root, 'c')), false);
  }
});

test('undo retains a directory that existed before an idempotent mkdir', (t) => {
  const root = fixture(t, { item: 'value' });
  const { ops } = resolve(scan(root), {
    created: [{ id: 'new:dir', cur: { name: 'destination', parentId: '.' } }],
    overrides: [{ id: 'item', cur: { name: 'item', parentId: 'new:dir' } }],
  });
  mkdirSync(join(root, 'destination'));
  const identity = lstatSync(join(root, 'destination')).ino;
  apply(root, ops, { dryRun: false, useGit: false, stamp: STAMP });
  undo(root);
  assert.equal(lstatSync(join(root, 'destination')).ino, identity);
  assert.equal(readFileSync(join(root, 'item'), 'utf8'), 'value');
});

test('undo stops at an occupied original path and resumes after the conflict is moved aside', (t) => {
  const root = fixture(t, { a: 'A', b: 'B' });
  const { ops } = resolve(scan(root), { overrides: [
    { id: 'a', cur: { name: 'b', parentId: '.' } },
    { id: 'b', cur: { name: 'c', parentId: '.' } },
  ] });
  apply(root, ops, { dryRun: false, useGit: false, stamp: STAMP });
  writeFileSync(join(root, 'a'), 'unrelated');
  const refused = spawnSync('/bin/bash', [join(root, `.reorg/undo-${STAMP}.sh`)], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /occupied/);
  assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'unrelated');
  assert.equal(readFileSync(join(root, 'b'), 'utf8'), 'A');
  assert.equal(readFileSync(join(root, 'c'), 'utf8'), 'B');
  renameSync(join(root, 'a'), join(root, 'unrelated-saved'));
  undo(root);
  assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'A');
  assert.equal(readFileSync(join(root, 'b'), 'utf8'), 'B');
});

test('undo refuses a replaced destination entry', (t) => {
  const root = fixture(t, { a: 'A' });
  const { ops } = resolve(scan(root), { overrides: [{ id: 'a', cur: { name: 'b', parentId: '.' } }] });
  apply(root, ops, { dryRun: false, useGit: false, stamp: STAMP });
  renameSync(join(root, 'b'), join(root, 'original-saved'));
  writeFileSync(join(root, 'b'), 'replacement');
  const refused = spawnSync('/bin/bash', [join(root, `.reorg/undo-${STAMP}.sh`)], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /identity|replaced/);
  assert.equal(readFileSync(join(root, 'b'), 'utf8'), 'replacement');
  assert.equal(existsSync(join(root, 'a')), false);
});

test('undo refuses a replaced parent directory without moving an outside entry', (t) => {
  const root = fixture(t, { 'source/a': 'A', 'destination/': null });
  const outside = fixture(t, { a: 'outside' });
  const { ops } = resolve(scan(root), { overrides: [{ id: 'source/a', cur: { name: 'a', parentId: 'destination' } }] });
  apply(root, ops, { dryRun: false, useGit: false, stamp: STAMP });
  renameSync(join(root, 'destination'), join(root, 'saved'));
  symlinkSync(outside, join(root, 'destination'));
  const refused = spawnSync('/bin/bash', [join(root, `.reorg/undo-${STAMP}.sh`)], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /symbolic link/);
  assert.equal(readFileSync(join(outside, 'a'), 'utf8'), 'outside');
  assert.equal(existsSync(join(root, 'source/a')), false);
});

test('a partial apply reports its run and recovery path', (t) => {
  const root = fixture(t, { a: 'A', b: 'B' });
  const { ops } = resolve(scan(root), { overrides: [
    { id: 'a', cur: { name: 'renamed-a', parentId: '.' } },
    { id: 'b', cur: { name: 'renamed-b', parentId: '.' } },
  ] });
  const result = apply(root, ops, { dryRun: false, useGit: false, stamp: STAMP, onLog() {
    throw new Error(INTERRUPTED);
  } });
  assert.equal(result.partial, true);
  assert.equal(result.code, 'apply-interrupted');
  assert.equal(result.applied, 1);
  assert.equal(result.stamp, STAMP);
  assert.ok(existsSync(result.undoPath));
  assert.match(result.problems.join('\n'), /simulated interruption/);
  undo(root);
  assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'A');
  assert.equal(readFileSync(join(root, 'b'), 'utf8'), 'B');
});

test('apply and standalone undo share the source recovery lock', (t) => {
  const root = fixture(t, { a: 'A', independent: 'keep' });
  const { ops } = resolve(scan(root), { overrides: [{ id: 'a', cur: { name: 'b', parentId: '.' } }] });
  const { ops: independent } = resolve(scan(root), {
    overrides: [{ id: 'independent', cur: { name: 'other', parentId: '.' } }],
  });
  const result = apply(root, ops, { dryRun: false, useGit: false, stamp: STAMP, onLog() {
    const competing = apply(root, independent, { dryRun: false, useGit: false, stamp: 'competing' });
    assert.equal(competing.applied, 0);
    assert.match(competing.problems.join('\n'), /busy/);
    const restore = spawnSync('/bin/bash', [join(root, `.reorg/undo-${STAMP}.sh`)], { encoding: 'utf8' });
    assert.equal(restore.status, 1);
    assert.match(restore.stderr, /busy/);
  } });
  assert.deepEqual(result.problems, []);
  undo(root);
  assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'A');
  assert.equal(readFileSync(join(root, 'independent'), 'utf8'), 'keep');
});

test('a replaced recovery directory stops further moves and cannot redirect journal writes', (t) => {
  const root = fixture(t, { a: 'A', b: 'B' });
  const outside = fixture(t, { [STAMP + '/marker']: 'outside' });
  const { ops } = resolve(scan(root), { overrides: [
    { id: 'a', cur: { name: 'renamed-a', parentId: '.' } },
    { id: 'b', cur: { name: 'renamed-b', parentId: '.' } },
  ] });
  const result = apply(root, ops, { dryRun: false, useGit: false, stamp: STAMP, onLog() {
    renameSync(join(root, '.reorg/runs'), join(root, '.reorg/saved-runs'));
    symlinkSync(outside, join(root, '.reorg/runs'));
  } });
  assert.equal(result.partial, true);
  assert.equal(result.applied, 1);
  assert.match(result.problems.join('\n'), /symbolic link/);
  assert.equal(readFileSync(join(root, 'b'), 'utf8'), 'B');
  assert.equal(existsSync(join(outside, STAMP, 'journal.json')), false);
});
