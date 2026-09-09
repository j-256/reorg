import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply } from '../src/apply.js';
import { resolve } from '../src/plan.js';
import { scan } from '../src/scan.js';
import { sandbox, cleanup } from './helpers.js';

function contents(root, parent = '') {
  const entries = {};
  for (const name of readdirSync(join(root, parent)).filter(name => name !== '.reorg').sort()) {
    const relative = join(parent, name);
    if (lstatSync(join(root, relative)).isDirectory()) {
      entries[relative + '/'] = null;
      Object.assign(entries, contents(root, relative));
    } else {
      entries[relative] = readFileSync(join(root, relative), 'utf8');
    }
  }
  return entries;
}

const CASES = [
  {
    name: 'a parent and child renamed together',
    before: { 'old/': null, 'old/item': 'data' },
    after: { 'new/': null, 'new/renamed': 'data' },
    plan: { overrides: [
      { id: 'old', cur: { name: 'new', parentId: '.' } },
      { id: 'old/item', cur: { name: 'renamed', parentId: 'old' } },
    ] },
  },
  {
    name: 'a created folder inside a moving parent',
    before: { 'old/': null, 'old/item': 'data' },
    after: { 'new/': null, 'new/inner/': null, 'new/inner/item': 'data' },
    plan: { created: [{ id: 'new:dir', cur: { name: 'inner', parentId: 'old' } }], overrides: [
      { id: 'old', cur: { name: 'new', parentId: '.' } },
      { id: 'old/item', cur: { name: 'item', parentId: 'new:dir' } },
    ] },
  },
  {
    name: 'trash below a relocated parent',
    before: { 'old/': null, 'old/item': 'data' },
    after: { 'new/': null },
    plan: { overrides: [
      { id: 'old', cur: { name: 'new', parentId: '.' } },
      { id: 'old/item', cur: { name: 'item', parentId: 'old' }, evicted: true },
    ] },
  },
  {
    name: 'a nested rename and an incoming file within a directory swap',
    before: { 'a/': null, 'a/item': 'A', 'b/': null, 'b/item': 'B', loose: 'incoming' },
    after: { 'b/': null, 'b/renamed': 'A', 'b/loose': 'incoming', 'a/': null, 'a/item': 'B' },
    plan: { overrides: [
      { id: 'a', cur: { name: 'b', parentId: '.' } },
      { id: 'b', cur: { name: 'a', parentId: '.' } },
      { id: 'a/item', cur: { name: 'renamed', parentId: 'a' } },
      { id: 'loose', cur: { name: 'loose', parentId: 'a' } },
    ] },
  },
];

for (const scenario of CASES) {
  test(`${scenario.name} applies to the intended tree and undoes every prefix`, () => {
    let length = Infinity;
    for (let cutoff = 1; cutoff <= length; cutoff++) {
      const root = sandbox(scenario.before);
      try {
        const { ops, problems } = resolve(scan(root), scenario.plan);
        assert.deepEqual(problems, []);
        length = ops.length;
        let completed = 0;
        const result = apply(root, ops, { dryRun: false, useGit: false, stamp: 'nested-test', onLog() {
          if (++completed === cutoff && cutoff < length) throw new Error('Interrupted nested plan');
        } });
        assert.equal(completed, cutoff, result.problems.join('\n'));
        if (cutoff === length) {
          assert.deepEqual(result.problems, []);
          assert.deepEqual(contents(root), scenario.after);
        }
        for (let repeat = 0; repeat < 2; repeat++) {
          execFileSync('/bin/bash', [result.undoPath], { stdio: 'pipe' });
          assert.deepEqual(contents(root), scenario.before);
        }
      } finally {
        cleanup(root);
      }
    }
  });
}

test('preflight detects a collision carried to its destination by a directory move', () => {
  const root = sandbox({ 'old/kept': 'keep', incoming: 'incoming' });
  try {
    const { ops } = resolve(scan(root), { overrides: [
      { id: 'old', cur: { name: 'new', parentId: '.' } },
      { id: 'incoming', cur: { name: 'collision', parentId: 'old' } },
    ] });
    writeFileSync(join(root, 'old/collision'), 'appeared after scan');
    const result = apply(root, ops, { dryRun: false, useGit: false });
    assert.equal(result.applied, 0);
    assert.match(result.problems.join('\n'), /already exists/);
    assert.equal(readFileSync(join(root, 'old/collision'), 'utf8'), 'appeared after scan');
    assert.equal(readFileSync(join(root, 'incoming'), 'utf8'), 'incoming');
    assert.equal(existsSync(join(root, 'new')), false);
  } finally {
    cleanup(root);
  }
});

test('preflight rejects an impossible source order before moving the parent', () => {
  const root = sandbox({ 'a/item': 'data' });
  try {
    const result = apply(root, [
      { op: 'move', from: 'a', to: 'b' },
      { op: 'move', from: 'a/item', to: 'item' },
    ], { dryRun: false, useGit: false });
    assert.equal(result.applied, 0);
    assert.match(result.problems.join('\n'), /no longer exists/);
    assert.equal(readFileSync(join(root, 'a/item'), 'utf8'), 'data');
  } finally {
    cleanup(root);
  }
});

function permutations(values) {
  if (!values.length) return [[]];
  return values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index))
    .map(tail => [value, ...tail]));
}

test('directory permutations preserve nested edits, dry-run inertia, and reversible contents', () => {
  const names = ['alpha', 'beta', 'gamma', 'delta'];
  for (const destinations of permutations(names)) {
    const layout = Object.fromEntries(names.map(name => [name + '/item', name]));
    const root = sandbox(layout);
    try {
      const original = contents(root);
      const plan = {
        created: [{ id: 'new:inner', cur: { name: 'inner', parentId: 'alpha' } }],
        overrides: names.flatMap((name, index) => [
          { id: name, cur: { name: destinations[index], parentId: '.' } },
          { id: name + '/item', cur: { name: 'renamed-' + name, parentId: name === 'alpha' ? 'new:inner' : name } },
        ]),
      };
      const expected = {};
      for (const [index, name] of names.entries()) {
        const destination = destinations[index];
        expected[destination + '/'] = null;
        if (name === 'alpha') expected[destination + '/inner/'] = null;
        expected[destination + (name === 'alpha' ? '/inner/' : '/') + 'renamed-' + name] = name;
      }
      const { ops, problems } = resolve(scan(root), plan);
      assert.deepEqual(problems, []);
      assert.deepEqual(apply(root, ops, { useGit: false }).problems, []);
      assert.deepEqual(contents(root), original);
      assert.equal(existsSync(join(root, '.reorg')), false);
      const result = apply(root, ops, { dryRun: false, useGit: false });
      assert.deepEqual(result.problems, [], destinations.join(','));
      assert.deepEqual(contents(root), expected);
      execFileSync('/bin/bash', [result.undoPath], { stdio: 'pipe' });
      assert.deepEqual(contents(root), original);
    } finally {
      cleanup(root);
    }
  }
});

test('deep source paths do not exceed filesystem component limits when staged', () => {
  const nested = Array.from({ length: 10 }, (_, index) => 'directory-component-number-' + index).join('/');
  const id = 'old/' + nested + '/item';
  const root = sandbox({ [id]: 'deep contents' });
  try {
    const original = contents(root);
    const { ops, problems } = resolve(scan(root), { overrides: [
      { id: 'old', cur: { name: 'new', parentId: '.' } },
      { id, cur: { name: 'renamed', parentId: 'old/' + nested } },
    ] });
    assert.deepEqual(problems, []);
    const result = apply(root, ops, { dryRun: false, useGit: false });
    assert.deepEqual(result.problems, []);
    assert.equal(readFileSync(join(root, 'new', nested, 'renamed'), 'utf8'), 'deep contents');
    execFileSync('/bin/bash', [result.undoPath], { stdio: 'pipe' });
    assert.deepEqual(contents(root), original);
  } finally {
    cleanup(root);
  }
});
