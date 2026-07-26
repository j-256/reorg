import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, buildNodes, pathOf, childrenOf, OP } from '../src/plan.js';
import { emptyPlan } from '../src/state.js';

// Minimal scan fixture builder: paths in, scan-shaped object out.
function fixture(paths) {
  const nodes = [];
  const seen = new Set();
  for (const p of paths) {
    const isDir = p.endsWith('/');
    const clean = isDir ? p.slice(0, -1) : p;
    const parts = clean.split('/');
    for (let i = 0; i < parts.length; i++) {
      const id = parts.slice(0, i + 1).join('/');
      if (seen.has(id)) continue;
      seen.add(id);
      const last = i === parts.length - 1;
      nodes.push({
        id,
        name: parts[i],
        kind: last && !isDir ? 'file' : 'dir',
        parentId: i === 0 ? '.' : parts.slice(0, i).join('/'),
        git: null,
        meta: null,
        bytes: last && !isDir ? 10 : null,
        files: null,
        mtime: null,
        nestedRepo: false,
        collapsedSubtree: false,
      });
    }
  }
  return { root: '/fake', generated: 'now', git: false, counts: {}, nodes };
}

function plan(over) {
  return { ...emptyPlan(), ...over };
}

test('no edits resolves to no operations', () => {
  const s = fixture(['a/b.txt', 'c/d.txt']);
  const { ops, problems, stats } = resolve(s, plan());
  assert.equal(ops.length, 0);
  assert.equal(problems.length, 0);
  assert.equal(stats.touched, 0);
});

test('moving a file emits one move with the new path', () => {
  const s = fixture(['a/b.txt', 'c/']);
  const { ops, problems } = resolve(
    s,
    plan({ overrides: [{ id: 'a/b.txt', cur: { name: 'b.txt', parentId: 'c' } }] })
  );
  assert.equal(problems.length, 0);
  assert.deepEqual(
    ops.map((o) => [o.op, o.from, o.to]),
    [[OP.MOVE, 'a/b.txt', 'c/b.txt']]
  );
});

test('renaming emits a move to the new name in place', () => {
  const s = fixture(['a/b.txt']);
  const { ops } = resolve(s, plan({ overrides: [{ id: 'a/b.txt', cur: { name: 'z.txt', parentId: 'a' } }] }));
  assert.deepEqual(
    ops.map((o) => [o.op, o.from, o.to]),
    [[OP.MOVE, 'a/b.txt', 'a/z.txt']]
  );
});

test('moving a directory does NOT emit separate moves for its children', () => {
  // The whole point: `mv a b/a` relocates a/x implicitly. A second op for a/x
  // would fail, since its source no longer exists by then.
  const s = fixture(['a/x.txt', 'a/deep/y.txt', 'b/']);
  const { ops } = resolve(s, plan({ overrides: [{ id: 'a', cur: { name: 'a', parentId: 'b' } }] }));
  assert.deepEqual(
    ops.map((o) => [o.op, o.from, o.to]),
    [[OP.MOVE, 'a', 'b/a']]
  );
});

test('a child moved out of a moving directory gets its own op', () => {
  // a -> b/a, but a/x.txt is pulled to the root: the ancestor move does not cover it.
  const s = fixture(['a/x.txt', 'b/']);
  const { ops } = resolve(
    s,
    plan({
      overrides: [
        { id: 'a', cur: { name: 'a', parentId: 'b' } },
        { id: 'a/x.txt', cur: { name: 'x.txt', parentId: '.' } },
      ],
    })
  );
  const moves = ops.filter((o) => o.op === OP.MOVE).map((o) => [o.from, o.to]);
  // a/x.txt must be rescued before `a` moves away, or its source is gone.
  assert.deepEqual(moves, [
    ['a/x.txt', 'x.txt'],
    ['a', 'b/a'],
  ]);
});

test('a move INTO a directory that is itself moving goes to the final path, after it lands', () => {
  // b -> archive/b, and x.txt -> inside b. Destinations are final-tree paths, so
  // x.txt goes straight to archive/b/x.txt in one hop -- once `b` has arrived.
  const s = fixture(['x.txt', 'b/', 'archive/']);
  const { ops } = resolve(
    s,
    plan({
      overrides: [
        { id: 'b', cur: { name: 'b', parentId: 'archive' } },
        { id: 'x.txt', cur: { name: 'x.txt', parentId: 'b' } },
      ],
    })
  );
  assert.deepEqual(
    ops.map((o) => [o.op, o.from, o.to]),
    [
      [OP.MOVE, 'b', 'archive/b'],
      [OP.MOVE, 'x.txt', 'archive/b/x.txt'],
    ]
  );
});

test('vacate-before-occupy: a move into a freed path is ordered after the mover', () => {
  // old/ moves to archive/old, then new/ takes the name `old`.
  const s = fixture(['old/', 'new/', 'archive/']);
  const { ops } = resolve(
    s,
    plan({
      overrides: [
        { id: 'old', cur: { name: 'old', parentId: 'archive' } },
        { id: 'new', cur: { name: 'old', parentId: '.' } },
      ],
    })
  );
  assert.deepEqual(
    ops.map((o) => [o.from, o.to]),
    [
      ['old', 'archive/old'],
      ['new', 'old'],
    ]
  );
});

test('a rename swap is broken with a staging hop rather than failing', () => {
  // a -> b and b -> a: no direct ordering works, so one side stages.
  const s = fixture(['a/', 'b/']);
  const { ops, problems } = resolve(
    s,
    plan({
      overrides: [
        { id: 'a', cur: { name: 'b', parentId: '.' } },
        { id: 'b', cur: { name: 'a', parentId: '.' } },
      ],
    })
  );
  assert.equal(problems.length, 0, 'a swap is legal, just awkward to execute');
  const kinds = ops.map((o) => o.op);
  assert.ok(kinds.includes(OP.STAGE), 'expected a staging hop');
  // Every destination must be free at the moment its op runs.
  const live = new Set(['a', 'b']);
  for (const op of ops) {
    assert.ok(!live.has(op.to), `${op.op} would clobber an occupied ${op.to}`);
    live.delete(op.from);
    live.add(op.to);
  }
  // And both end up where the plan said.
  assert.deepEqual(
    ops.filter((o) => o.op === OP.UNSTAGE || o.op === OP.MOVE).map((o) => o.to).sort(),
    ['a', 'b']
  );
});

test('out-and-back drag is a no-op (order is derived, not stored)', () => {
  const s = fixture(['a/b.txt', 'c/']);
  const { ops } = resolve(s, plan({ overrides: [{ id: 'a/b.txt', cur: { name: 'b.txt', parentId: 'a' } }] }));
  assert.equal(ops.length, 0);
});

test('created directories are made shallowest-first, before moves into them', () => {
  const s = fixture(['x.txt']);
  const { ops } = resolve(
    s,
    plan({
      created: [
        { id: 'new:2', cur: { name: 'inner', parentId: 'new:1' } },
        { id: 'new:1', cur: { name: 'outer', parentId: '.' } },
      ],
      overrides: [{ id: 'x.txt', cur: { name: 'x.txt', parentId: 'new:2' } }],
    })
  );
  assert.deepEqual(
    ops.map((o) => [o.op, o.to]),
    [
      [OP.MKDIR, 'outer'],
      [OP.MKDIR, 'outer/inner'],
      [OP.MOVE, 'outer/inner/x.txt'],
    ]
  );
});

test('trash runs last and targets the post-move location', () => {
  const s = fixture(['a/b.txt', 'c/']);
  const { ops } = resolve(
    s,
    plan({ overrides: [{ id: 'a/b.txt', cur: { name: 'b.txt', parentId: 'c' }, evicted: true }] })
  );
  assert.deepEqual(
    ops.map((o) => [o.op, o.to]),
    [
      [OP.MOVE, 'c/b.txt'],
      [OP.TRASH, 'c/b.txt'],
    ]
  );
});

test('trashing a directory covers its children with one op', () => {
  const s = fixture(['junk/a.txt', 'junk/b.txt']);
  const { ops } = resolve(
    s,
    plan({
      overrides: [
        { id: 'junk', cur: { name: 'junk', parentId: '.' }, evicted: true },
        { id: 'junk/a.txt', cur: { name: 'a.txt', parentId: 'junk' }, evicted: true },
        { id: 'junk/b.txt', cur: { name: 'b.txt', parentId: 'junk' }, evicted: true },
      ],
    })
  );
  assert.deepEqual(
    ops.map((o) => [o.op, o.to]),
    [[OP.TRASH, 'junk']]
  );
});

test('collision between two nodes landing on one path is an error, not an op', () => {
  const s = fixture(['a/x.txt', 'b/x.txt', 'c/']);
  const { ops, problems } = resolve(
    s,
    plan({
      overrides: [
        { id: 'a/x.txt', cur: { name: 'x.txt', parentId: 'c' } },
        { id: 'b/x.txt', cur: { name: 'x.txt', parentId: 'c' } },
      ],
    })
  );
  assert.equal(ops.length, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /would land on "c\/x.txt"/);
});

test('a rename that collides with an existing sibling is caught', () => {
  const s = fixture(['a/x.txt', 'a/y.txt']);
  const { ops, problems } = resolve(
    s,
    plan({ overrides: [{ id: 'a/y.txt', cur: { name: 'x.txt', parentId: 'a' } }] })
  );
  assert.equal(ops.length, 0);
  assert.match(problems[0].message, /a\/x\.txt/);
});

test('trashing a directory that still holds kept children is an error', () => {
  const s = fixture(['junk/keep.txt']);
  const { ops, problems } = resolve(
    s,
    plan({ overrides: [{ id: 'junk', cur: { name: 'junk', parentId: '.' }, evicted: true }] })
  );
  assert.equal(ops.length, 0);
  assert.match(problems[0].message, /still holds 1 kept item/);
});

test('a parent cycle is reported rather than resolved', () => {
  const s = fixture(['a/', 'b/']);
  const { ops, problems } = resolve(
    s,
    plan({
      overrides: [
        { id: 'a', cur: { name: 'a', parentId: 'b' } },
        { id: 'b', cur: { name: 'b', parentId: 'a' } },
      ],
    })
  );
  assert.equal(ops.length, 0);
  assert.ok(problems.length >= 1);
  assert.match(problems[0].message, /broken or circular/);
});

test('an override for a node that vanished since the scan is ignored', () => {
  const s = fixture(['a/b.txt']);
  const { ops, problems } = resolve(
    s,
    plan({ overrides: [{ id: 'gone/away.txt', cur: { name: 'away.txt', parentId: '.' } }] })
  );
  assert.equal(problems.length, 0);
  assert.equal(ops.length, 0);
});

test('derived order is dirs first, then natural-sorted names', () => {
  const s = fixture(['file10.txt', 'file2.txt', 'zdir/', 'adir/']);
  const nodes = buildNodes(s, plan());
  assert.deepEqual(
    childrenOf(nodes, '.').map((n) => n.cur.name),
    ['adir', 'zdir', 'file2.txt', 'file10.txt']
  );
});

test('pathOf follows the live chain through a moved ancestor', () => {
  const s = fixture(['a/deep/x.txt', 'b/']);
  const nodes = buildNodes(s, plan({ overrides: [{ id: 'a', cur: { name: 'renamed', parentId: 'b' } }] }));
  assert.equal(pathOf(nodes, 'a/deep/x.txt'), 'b/renamed/deep/x.txt');
});

test('stats count distinct touched nodes, not the sum of tags', () => {
  const s = fixture(['a/x.txt', 'b/']);
  const { stats } = resolve(
    s,
    plan({ overrides: [{ id: 'a/x.txt', cur: { name: 'renamed.txt', parentId: 'b' } }] })
  );
  assert.equal(stats.touched, 1); // moved AND renamed, but one node
  assert.equal(stats.move, 1);
});
