import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply } from '../src/apply.js';
import { resolve } from '../src/plan.js';
import { scan } from '../src/scan.js';
import { ensureStateDir } from '../src/state.js';
import { sandbox, cleanup } from './helpers.js';

function fixture(t, layout = {}) {
  const root = sandbox(layout);
  t.after(() => cleanup(root));
  return root;
}

for (const side of ['source', 'destination']) {
  test(`apply refuses a ${side} parent replaced by a symlink before any move`, (t) => {
    const root = fixture(t, { 'source/item': 'original', 'destination/': null, independent: 'keep' });
    const outside = fixture(t, { item: 'outside' });
    const { ops, problems } = resolve(scan(root), { overrides: [
      { id: 'independent', cur: { name: 'renamed', parentId: '.' } },
      { id: 'source/item', cur: { name: 'item', parentId: 'destination' } },
    ] });
    assert.deepEqual(problems, []);
    renameSync(join(root, side), join(root, `${side}-saved`));
    symlinkSync(outside, join(root, side));
    if (side === 'destination') renameSync(join(outside, 'item'), join(outside, 'saved'));

    const result = apply(root, ops, { dryRun: false, useGit: false });
    assert.equal(result.applied, 0);
    assert.match(result.problems.join('\n'), /symbolic link/);
    assert.equal(readFileSync(join(root, 'independent'), 'utf8'), 'keep');
    assert.equal(readFileSync(join(outside, side === 'source' ? 'item' : 'saved'), 'utf8'), 'outside');
    if (side === 'destination') assert.equal(existsSync(join(outside, 'item')), false);
  });
}

test('apply refuses a symlink occupying a planned directory', (t) => {
  const root = fixture(t, { item: 'original' });
  const outside = fixture(t);
  const { ops } = resolve(scan(root), {
    created: [{ id: 'new:destination', cur: { name: 'destination', parentId: '.' } }],
    overrides: [{ id: 'item', cur: { name: 'item', parentId: 'new:destination' } }],
  });
  symlinkSync(outside, join(root, 'destination'));
  const result = apply(root, ops, { dryRun: false, useGit: false });
  assert.equal(result.applied, 0);
  assert.match(result.problems.join('\n'), /symbolic link/);
  assert.equal(readFileSync(join(root, 'item'), 'utf8'), 'original');
  assert.equal(existsSync(join(outside, 'item')), false);
});

for (const directory of ['.reorg', '.reorg/stage', '.reorg/trash']) {
  test(`apply refuses a symlink at ${directory}`, (t) => {
    const root = fixture(t, { a: 'A', b: 'B' });
    const outside = fixture(t, { marker: 'outside' });
    const { ops } = resolve(scan(root), { overrides: [
      { id: 'a', cur: { name: 'b', parentId: '.' } },
      { id: 'b', cur: { name: 'a', parentId: '.' } },
    ] });
    if (directory !== '.reorg') mkdirSync(join(root, '.reorg'));
    symlinkSync(outside, join(root, directory));
    const result = apply(root, ops, { dryRun: false, useGit: false });
    assert.equal(result.applied, 0);
    assert.match(result.problems.join('\n'), /symbolic link/);
    assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'A');
    assert.equal(readFileSync(join(outside, 'marker'), 'utf8'), 'outside');
  });
}

test('default workspace state refuses a symlink outside the source root', (t) => {
  const root = fixture(t);
  const outside = fixture(t);
  symlinkSync(outside, join(root, '.reorg'));
  assert.throws(() => ensureStateDir(root), /symbolic link/);
  assert.equal(existsSync(join(outside, '.gitignore')), false);
});

test('an occupied cycle staging path aborts without overwriting recovery', (t) => {
  const root = fixture(t, { a: 'A', b: 'B' });
  const { ops } = resolve(scan(root), { overrides: [
    { id: 'a', cur: { name: 'b', parentId: '.' } },
    { id: 'b', cur: { name: 'a', parentId: '.' } },
  ] });
  mkdirSync(join(root, '.reorg/stage'), { recursive: true });
  writeFileSync(join(root, '.reorg/stage/a'), 'previous recovery');
  const result = apply(root, ops, { dryRun: false, useGit: false });
  assert.equal(result.applied, 0);
  assert.match(result.problems.join('\n'), /already exists/);
  assert.equal(readFileSync(join(root, '.reorg/stage/a'), 'utf8'), 'previous recovery');
  assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'A');
});

test('a non-directory destination parent aborts the complete batch', (t) => {
  const root = fixture(t, { a: 'A', b: 'B', 'destination/': null });
  const { ops } = resolve(scan(root), { overrides: [
    { id: 'a', cur: { name: 'renamed', parentId: '.' } },
    { id: 'b', cur: { name: 'b', parentId: 'destination' } },
  ] });
  rmdirSync(join(root, 'destination'));
  writeFileSync(join(root, 'destination'), 'barrier');
  const result = apply(root, ops, { dryRun: false, useGit: false });
  assert.equal(result.applied, 0);
  assert.match(result.problems.join('\n'), /not a directory/);
  assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'A');
});
