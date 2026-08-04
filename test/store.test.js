// The browser-side model, tested without a browser.
//
// store.js and plan-edit.js are the part of web/ where a bug is expensive: they
// produce the plan that /api/apply resolves into real filesystem operations. A
// mistake here is not a rendering glitch, it is a wrong-but-internally-valid plan
// that passes every check in src/apply.js and gets faithfully carried out. Neither
// module touches the DOM, so both run under plain `node --test`.
//
// The load-bearing assertion in several of these is a round trip: mutate the
// client model, serialize() it, hand that to the real server-side resolver, and
// check the operations it produces. That is what actually proves the two
// implementations of the same rules agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store, ROOT_ID, childrenOf, changesOf, pathOf, isDescendant, isDir } from '../web/lib/store.js';
import * as edit from '../web/lib/plan-edit.js';
import { resolve, OP } from '../src/plan.js';
import { scan } from '../src/scan.js';
import { sandbox, cleanup } from './helpers.js';

// A scan payload of the shape the server sends, without needing a real directory.
function fakeScan(nodes, opts = {}) {
  return {
    root: opts.root || '/tmp/fake',
    generated: '2026-07-27T00:00:00.000Z',
    git: opts.git || false,
    truncated: false,
    collapsed: [],
    counts: { nodes: nodes.length, dirs: 0, files: 0, tracked: 0, ignored: 0, untracked: 0, nested: 0, bytes: 0 },
    nodes: nodes.map((n) => ({
      git: null, meta: null, bytes: null, files: null, mtime: null,
      nestedRepo: false, collapsedSubtree: false, ...n,
    })),
  };
}

const dir = (id, parentId = ROOT_ID, name = id.split('/').pop()) => ({ id, name, parentId, kind: 'dir' });
const file = (id, parentId = ROOT_ID, name = id.split('/').pop()) => ({ id, name, parentId, kind: 'file' });

// docs/, docs/note.md, keep.txt, old/, old/junk.log
const TREE = [dir('docs'), file('docs/note.md', 'docs'), file('keep.txt'), dir('old'), file('old/junk.log', 'old')];

function load(nodes = TREE, plan = {}, view = null) {
  store.init({ scan: fakeScan(nodes), plan, view, undoScripts: [] });
  return store;
}

test('a fresh scan produces no plan edits at all', () => {
  load();
  const s = store.serialize();
  assert.deepEqual(s.overrides, []);
  assert.deepEqual(s.created, []);
  assert.equal(store.countTouched(), 0);
});

test('every node starts with cur equal to orig', () => {
  load();
  for (const n of store.nodes.values()) {
    assert.deepEqual(n.cur, n.orig, `${n.id} should start unmodified`);
    assert.equal(n.evicted, false);
    assert.deepEqual(changesOf(n), []);
  }
});

test('moving a node records exactly one override', () => {
  load();
  assert.equal(edit.moveNode('keep.txt', 'docs').changed, true);

  const s = store.serialize();
  assert.equal(s.overrides.length, 1);
  assert.deepEqual(s.overrides[0], { id: 'keep.txt', cur: { name: 'keep.txt', parentId: 'docs' }, evicted: false });
  assert.deepEqual(changesOf(store.nodes.get('keep.txt')), ['moved']);
  assert.equal(store.countTouched(), 1);
});

test('a folder cannot be moved inside itself, and nothing changes when refused', () => {
  load();
  const res = edit.moveNode('docs', 'docs/note.md');
  assert.equal(res.ok, false);
  assert.match(res.message, /inside itself/);
  assert.deepEqual(store.serialize().overrides, [], 'a refused move leaves no trace');
});

test('moving a node onto itself is a no-op, not an override', () => {
  load();
  const res = edit.moveNode('keep.txt', 'keep.txt');
  assert.equal(res.changed, false);
  assert.deepEqual(store.serialize().overrides, []);
});

test('dragging out and back leaves no pending change', () => {
  // Sibling order is derived rather than stored, so a round trip must be a true
  // no-op instead of a phantom "reordered" edit.
  load();
  edit.moveNode('keep.txt', 'docs');
  edit.moveNode('keep.txt', ROOT_ID);
  assert.deepEqual(store.serialize().overrides, []);
  assert.equal(store.countTouched(), 0);
});

test('a rename records an override and rejects path-breaking names', () => {
  load();
  assert.equal(edit.renameNode('keep.txt', 'kept.txt').changed, true);
  assert.deepEqual(changesOf(store.nodes.get('keep.txt')), ['renamed']);

  for (const bad of ['a/b', '..', '.', 'x\0y']) {
    const res = edit.renameNode('keep.txt', bad);
    assert.equal(res.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(store.nodes.get('keep.txt').cur.name, 'kept.txt', 'a refused rename changes nothing');
  }
});

test('a rename to the same name, or to blank, is a no-op', () => {
  load();
  assert.equal(edit.renameNode('keep.txt', 'keep.txt').changed, false);
  assert.equal(edit.renameNode('keep.txt', '   ').changed, false);
  assert.equal(edit.renameNode('keep.txt', '  keep.txt  ').changed, false, 'trimmed to the same name');
  assert.deepEqual(store.serialize().overrides, []);
});

test('spaces and unicode are legitimate filenames', () => {
  load();
  assert.equal(edit.renameNode('keep.txt', 'my notes é中.txt').changed, true);
  assert.equal(store.nodes.get('keep.txt').cur.name, 'my notes é中.txt');
});

test('trashing a folder cascades to everything inside it', () => {
  // The server refuses a plan that trashes a directory still holding kept
  // children, so a toggle that did not descend would build an unappliable plan.
  load();
  edit.toggleEvict('old');
  assert.equal(store.nodes.get('old').evicted, true);
  assert.equal(store.nodes.get('old/junk.log').evicted, true, 'children come with it');

  edit.toggleEvict('old');
  assert.equal(store.nodes.get('old').evicted, false);
  assert.equal(store.nodes.get('old/junk.log').evicted, false, 'un-trashing releases them too');
  assert.deepEqual(store.serialize().overrides, []);
});

test('a created folder serializes under created, never overrides', () => {
  load();
  const { id } = edit.addDir(ROOT_ID);
  assert.match(id, /^new:[0-9a-f-]{36}$/);

  const s = store.serialize();
  assert.deepEqual(s.overrides, []);
  assert.equal(s.created.length, 1);
  assert.equal(s.created[0].id, id);
  assert.deepEqual(changesOf(store.nodes.get(id)), ['new']);
});

test('created-folder ids remain unique across a save and reload', () => {
  // Reusing an id after reload would collide with the folder already in the plan.
  load();
  const first = edit.addDir(ROOT_ID).id;
  const saved = store.serialize();

  load(TREE, saved);
  const second = edit.addDir(ROOT_ID).id;
  assert.notEqual(second, first, 'a reloaded plan must not reissue an id it already used');
});

test('deleting a created folder reparents its children rather than dropping them', () => {
  // Its children are real entries on disk; discarding them from the plan would
  // silently leave them where they started while the user believes they moved.
  load();
  const { id } = edit.addDir(ROOT_ID);
  edit.moveNode('keep.txt', id);
  assert.equal(store.nodes.get('keep.txt').cur.parentId, id);

  edit.deleteCreated(id);
  assert.equal(store.nodes.has(id), false);
  assert.equal(store.nodes.get('keep.txt').cur.parentId, ROOT_ID, 'child came back to where the folder sat');
  assert.deepEqual(store.serialize().created, []);
});

test('deleteCreated refuses to touch something that exists on disk', () => {
  load();
  const res = edit.deleteCreated('docs');
  assert.equal(res.changed, false);
  assert.equal(store.nodes.has('docs'), true);
});

test('deleting a created folder also drops notes attached to it', () => {
  load();
  const { id } = edit.addDir(ROOT_ID);
  store.notes = [{ id: 'n:1', target: id, text: 'why' }, { id: 'n:2', target: 'keep.txt', text: 'keep' }];
  edit.deleteCreated(id);
  assert.deepEqual(store.notes.map((n) => n.target), ['keep.txt']);
});

test('a saved plan reattaches to the same nodes after a rescan', () => {
  load();
  edit.moveNode('keep.txt', 'docs');
  edit.toggleEvict('old');
  const saved = store.serialize();

  load(TREE, saved);
  assert.equal(store.nodes.get('keep.txt').cur.parentId, 'docs');
  assert.equal(store.nodes.get('old').evicted, true);
  assert.equal(store.countTouched(), 3, 'the move plus the trashed folder and its child');
});

test('a plan entry for a path that vanished is dropped, not resurrected', () => {
  load();
  edit.moveNode('keep.txt', 'docs');
  const saved = store.serialize();

  // keep.txt is gone from disk on the next scan.
  load(TREE.filter((n) => n.id !== 'keep.txt'), saved);
  assert.equal(store.nodes.has('keep.txt'), false);
  assert.deepEqual(store.serialize().overrides, [], 'no override for a node that no longer exists');
});

test('loading a plan reveals what it touches instead of hiding it', () => {
  const deep = [dir('a'), dir('a/b', 'a'), dir('a/b/c', 'a/b'), file('a/b/c/f.txt', 'a/b/c')];
  load(deep);
  edit.renameNode('a/b/c/f.txt', 'renamed.txt');
  const saved = store.serialize();

  load(deep, saved);
  for (const id of ['a', 'a/b', 'a/b/c']) {
    assert.equal(store.nodes.get(id).collapsed, false, `${id} should be expanded to show the edit`);
  }
});

test('clearPlanEdits resets the diff but keeps created folders present', () => {
  // Called after a successful apply, when the tree IS the plan.
  load();
  edit.moveNode('keep.txt', 'docs');
  const { id } = edit.addDir(ROOT_ID);

  store.clearPlanEdits();
  assert.deepEqual(store.serialize().overrides, []);
  assert.equal(store.countTouched(), 1, 'the created folder is still new until a rescan sees it');
  assert.equal(store.nodes.has(id), true);
});

test('reset discards created folders as well as edits', () => {
  load();
  edit.moveNode('keep.txt', 'docs');
  const { id } = edit.addDir(ROOT_ID);
  store.notes = [{ id: 'n:1', target: 'keep.txt', text: 'x' }];

  store.reset();
  assert.equal(store.nodes.has(id), false);
  assert.deepEqual(store.serialize().overrides, []);
  assert.deepEqual(store.serialize().created, []);
  assert.deepEqual(store.notes, []);
  assert.equal(store.countTouched(), 0);
});

test('childrenOf derives order: folders first, then natural sort', () => {
  load([dir('zeta'), file('alpha.txt'), dir('beta'), file('b10.txt'), file('b9.txt')]);
  assert.deepEqual(
    childrenOf(ROOT_ID).map((n) => n.cur.name),
    ['beta', 'zeta', 'alpha.txt', 'b9.txt', 'b10.txt'],
    'b9 before b10 is natural sort, not lexicographic'
  );
});

test('childrenOf can exclude trashed entries', () => {
  load();
  edit.toggleEvict('keep.txt');
  assert.ok(childrenOf(ROOT_ID).some((n) => n.id === 'keep.txt'));
  assert.ok(!childrenOf(ROOT_ID, { includeEvicted: false }).some((n) => n.id === 'keep.txt'));
});

test('pathOf follows the current tree, not the original one', () => {
  load();
  assert.equal(pathOf('docs/note.md'), 'docs/note.md');
  edit.moveNode('docs/note.md', 'old');
  assert.equal(pathOf('docs/note.md'), 'old/note.md', 'the id is stable; the path is not');
  edit.renameNode('old', 'archive');
  assert.equal(pathOf('docs/note.md'), 'archive/note.md');
});

test('isDescendant tracks the current tree and is not fooled by a cycle', () => {
  load();
  assert.equal(isDescendant('docs/note.md', 'docs'), true);
  assert.equal(isDescendant('keep.txt', 'docs'), false);

  // Force a cycle directly in the model: the guard must stop rather than hang.
  store.nodes.get('docs').cur.parentId = 'old';
  store.nodes.get('old').cur.parentId = 'docs';
  assert.doesNotThrow(() => isDescendant('docs', 'keep.txt'));
});

test('isDir reflects kind', () => {
  load();
  assert.equal(isDir(store.nodes.get('docs')), true);
  assert.equal(isDir(store.nodes.get('keep.txt')), false);
});

test('collapse helpers are shallow or deep as asked', () => {
  const deep = [dir('a'), dir('a/b', 'a'), dir('a/b/c', 'a/b')];
  load(deep);
  edit.setAllCollapsed(false);

  edit.toggleCollapse('a');
  assert.equal(store.nodes.get('a').collapsed, true);
  assert.equal(store.nodes.get('a/b').collapsed, false, 'shallow leaves descendants alone');

  edit.setAllCollapsed(false);
  edit.toggleCollapse('a', true);
  for (const id of ['a', 'a/b', 'a/b/c']) {
    assert.equal(store.nodes.get(id).collapsed, true, `${id} collapsed deeply`);
  }
});

test('git tinting defaults on inside a repo and off outside one', () => {
  store.init({ scan: fakeScan(TREE, { git: true }), plan: {}, undoScripts: [] });
  assert.equal(store.ui.git, true);

  store.init({ scan: fakeScan(TREE, { git: false }), plan: {}, undoScripts: [] });
  assert.equal(store.ui.git, false);

  // An explicit saved preference wins over the default.
  store.init({ scan: fakeScan(TREE, { git: true }), plan: { ui: { git: false } }, undoScripts: [] });
  assert.equal(store.ui.git, false);
});

test('theme cycles auto -> dark -> light and back', () => {
  load();
  assert.equal(edit.currentTheme(), 'auto', 'a plan with no theme follows the system');

  assert.equal(edit.cycleTheme().theme, 'dark');
  assert.equal(edit.currentTheme(), 'dark');
  assert.equal(edit.cycleTheme().theme, 'light');
  assert.equal(edit.cycleTheme().theme, 'auto', 'the cycle returns to following the system');
});

test('auto is stored as absent from shared view state', () => {
  // The CSS distinguishes "no override" from an explicit choice with
  // :not([data-theme]), so auto must not serialize as the string 'auto'.
  load();
  edit.cycleTheme(); // dark
  assert.equal(store.serializeView().ui.theme, 'dark');

  edit.cycleTheme(); // light
  edit.cycleTheme(); // auto
  assert.equal('theme' in store.serializeView().ui, false, 'auto leaves no key behind');
});

test('an explicit theme survives a save and reload', () => {
  load();
  edit.cycleTheme(); // dark
  const savedPlan = store.serialize();
  const savedView = store.serializeView();

  load(TREE, savedPlan, savedView);
  assert.equal(edit.currentTheme(), 'dark');
});

test('an unrecognized stored theme falls back to auto rather than breaking', () => {
  load(TREE, { ui: { theme: 'solarized' } });
  assert.equal(edit.currentTheme(), 'auto');
});

/* ---- round trips against the real server-side resolver -------------------- */
// These are the tests that actually matter: they prove the plan the browser
// builds means what the browser thinks it means once src/plan.js reads it.

function realScan(layout) {
  const root = sandbox(layout);
  return { root, scan: scan(root, {}) };
}

test('a browser-built move resolves to the move the user drew', () => {
  const { root, scan: s } = realScan({ 'keep.txt': 'x', 'docs/note.md': 'y' });
  try {
    store.init({ scan: s, plan: {}, undoScripts: [] });
    edit.moveNode('keep.txt', 'docs');

    const { ops, problems } = resolve(s, store.serialize());
    assert.deepEqual(problems, []);
    const moves = ops.filter((o) => o.op === OP.MOVE);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].from, 'keep.txt');
    assert.equal(moves[0].to, 'docs/keep.txt');
  } finally {
    cleanup(root);
  }
});

test('a browser-created folder resolves to a mkdir plus a move into it', () => {
  const { root, scan: s } = realScan({ 'keep.txt': 'x' });
  try {
    store.init({ scan: s, plan: {}, undoScripts: [] });
    const { id } = edit.addDir(ROOT_ID);
    edit.renameNode(id, 'sorted');
    edit.moveNode('keep.txt', id);

    const { ops, problems } = resolve(s, store.serialize());
    assert.deepEqual(problems, []);
    assert.deepEqual(
      ops.filter((o) => o.op === OP.MKDIR).map((o) => o.to),
      ['sorted']
    );
    const move = ops.find((o) => o.op === OP.MOVE);
    assert.equal(move.to, 'sorted/keep.txt');
  } finally {
    cleanup(root);
  }
});

test('a cascaded trash resolves without the kept-children problem', () => {
  // The cascade in toggleEvict exists precisely so this resolves cleanly; if it
  // stopped at the folder, resolve() would report the directory as still holding
  // kept items.
  const { root, scan: s } = realScan({ 'old/junk.log': 'x', 'old/more.log': 'y', 'keep.txt': 'z' });
  try {
    store.init({ scan: s, plan: {}, undoScripts: [] });
    edit.toggleEvict('old');

    const { ops, problems } = resolve(s, store.serialize());
    assert.deepEqual(problems, [], 'a cascaded trash is resolvable');
    assert.deepEqual(ops.filter((o) => o.op === OP.TRASH).map((o) => o.to), ['old']);
  } finally {
    cleanup(root);
  }
});

test('trashing only the folder, without the cascade, is what resolve rejects', () => {
  // Pins the reason the cascade is not optional, by building the plan the naive
  // implementation would produce.
  const { root, scan: s } = realScan({ 'old/junk.log': 'x', 'keep.txt': 'z' });
  try {
    store.init({ scan: s, plan: {}, undoScripts: [] });
    store.nodes.get('old').evicted = true; // deliberately no cascade

    const { problems } = resolve(s, store.serialize());
    assert.ok(problems.length > 0);
    assert.match(problems[0].message, /kept item/i);
  } finally {
    cleanup(root);
  }
});

test('two entries renamed onto one path is caught as a collision, not applied', () => {
  const { root, scan: s } = realScan({ 'a.txt': 'x', 'b.txt': 'y' });
  try {
    store.init({ scan: s, plan: {}, undoScripts: [] });
    edit.renameNode('a.txt', 'same.txt');
    edit.renameNode('b.txt', 'same.txt');

    const { problems } = resolve(s, store.serialize());
    assert.ok(problems.length > 0, 'the resolver refuses two entries landing on one path');
  } finally {
    cleanup(root);
  }
});

test('a swap the browser allows resolves through staging rather than failing', () => {
  const { root, scan: s } = realScan({ 'a.txt': 'A', 'b.txt': 'B' });
  try {
    store.init({ scan: s, plan: {}, undoScripts: [] });
    edit.renameNode('a.txt', 'tmp-name');
    edit.renameNode('b.txt', 'a.txt');
    edit.renameNode('a.txt', 'b.txt'); // id 'a.txt' now wants the name b.txt

    const { ops, problems } = resolve(s, store.serialize());
    assert.deepEqual(problems, []);
    assert.ok(
      ops.some((o) => o.op === OP.STAGE) || ops.filter((o) => o.op === OP.MOVE).length === 2,
      'a cycle is either staged or expressible as plain moves'
    );
  } finally {
    cleanup(root);
  }
});
