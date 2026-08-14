import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { scan } from '../src/scan.js';
import {
  COMMAND,
  CommandError,
  RevisionConflictError,
  applyCommands,
  transactPlan,
} from '../src/commands.js';
import {
  ensureWorkspace,
  loadPlan,
  loadScan,
  loadView,
  planPath,
  savePlan,
  saveScan,
  saveView,
} from '../src/state.js';
import { materializeView, transactView } from '../src/view.js';
import { sandbox, cleanup } from './helpers.js';

const TREE = {
  'docs/note.md': 'note',
  'keep.txt': 'keep',
  'old/junk.log': 'junk',
};

function workspace() {
  const root = sandbox(TREE);
  const dataRoot = sandbox({});
  const dataDir = join(dataRoot, 'portable-state');
  const frozen = scan(root);
  ensureWorkspace(root, dataDir);
  saveScan(root, frozen, dataDir);
  return {
    root,
    dataRoot,
    dataDir,
    scan: frozen,
    cleanup() {
      cleanup(root);
      cleanup(dataRoot);
    },
  };
}

test('semantic commands build a valid plan without touching the source tree', () => {
  const w = workspace();
  try {
    const result = applyCommands(w.scan, loadPlan(w.root, w.dataDir), [
      { type: COMMAND.CREATE_FOLDER, id: 'new:8', parentId: '.', name: 'Writing' },
      { type: COMMAND.MOVE, id: 'docs/note.md', parentId: 'new:8' },
      { type: COMMAND.RENAME, id: 'docs/note.md', name: 'draft.md' },
    ]);

    assert.equal(result.changed, true);
    assert.deepEqual(result.resolved.problems, []);
    assert.deepEqual(
      result.resolved.ops.map((op) => [op.op, op.from || null, op.to]),
      [
        ['mkdir', null, 'Writing'],
        ['move', 'docs/note.md', 'Writing/draft.md'],
      ]
    );
    assert.ok(existsSync(join(w.root, 'docs/note.md')));
    assert.ok(!existsSync(join(w.root, 'Writing')));
  } finally {
    w.cleanup();
  }
});

test('transactions are revision checked and idempotent by transaction id', () => {
  const w = workspace();
  try {
    const first = transactPlan({
      root: w.root,
      dataDir: w.dataDir,
      scan: w.scan,
      expectedRevision: 0,
      transactionId: 'tx-1',
      actor: 'test-agent',
      commands: [{ type: COMMAND.MOVE, id: 'keep.txt', parentId: 'docs' }],
    });
    assert.equal(first.plan.revision, 1);
    assert.equal(first.changed, true);

    const duplicate = transactPlan({
      root: w.root,
      dataDir: w.dataDir,
      scan: w.scan,
      expectedRevision: 0,
      transactionId: 'tx-1',
      actor: 'test-agent',
      commands: [{ type: COMMAND.MOVE, id: 'keep.txt', parentId: 'docs' }],
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.plan.revision, 1);

    assert.throws(
      () =>
        transactPlan({
          root: w.root,
          dataDir: w.dataDir,
          scan: w.scan,
          expectedRevision: 1,
          transactionId: 'tx-1',
          actor: 'test-agent',
          commands: [{ type: COMMAND.RENAME, id: 'keep.txt', name: 'different.txt' }],
        }),
      (error) => error instanceof CommandError && error.code === 'idempotency-conflict'
    );

    assert.throws(
      () =>
        transactPlan({
          root: w.root,
          dataDir: w.dataDir,
          scan: w.scan,
          expectedRevision: 0,
          transactionId: 'tx-2',
          commands: [{ type: COMMAND.RENAME, id: 'keep.txt', name: 'kept.txt' }],
        }),
      RevisionConflictError
    );
    assert.equal(loadPlan(w.root, w.dataDir).revision, 1);
  } finally {
    w.cleanup();
  }
});

test('no-op transaction ids stay idempotent after later plan changes', () => {
  const w = workspace();
  try {
    const noOp = transactPlan({
      root: w.root,
      dataDir: w.dataDir,
      scan: w.scan,
      expectedRevision: 0,
      transactionId: 'no-op',
      commands: [{ type: COMMAND.RENAME, id: 'keep.txt', name: 'keep.txt' }],
    });
    assert.equal(noOp.changed, false);
    assert.equal(noOp.plan.revision, 0);
    assert.ok(noOp.plan.recentTransactions.includes('no-op'));
    savePlan(
      w.root,
      { ...noOp.plan, recentTransactions: [], recentTransactionDigests: {} },
      w.dataDir
    );

    transactPlan({
      root: w.root,
      dataDir: w.dataDir,
      scan: w.scan,
      expectedRevision: 0,
      transactionId: 'later-change',
      commands: [{ type: COMMAND.MOVE, id: 'keep.txt', parentId: 'docs' }],
    });
    const replay = transactPlan({
      root: w.root,
      dataDir: w.dataDir,
      scan: w.scan,
      expectedRevision: 0,
      transactionId: 'no-op',
      commands: [{ type: COMMAND.RENAME, id: 'keep.txt', name: 'keep.txt' }],
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.plan.revision, 1);
    assert.equal(replay.plan.overrides[0].cur.parentId, 'docs');
  } finally {
    w.cleanup();
  }
});

test('a malformed transaction is rejected atomically', () => {
  const w = workspace();
  try {
    assert.throws(
      () =>
        transactPlan({
          root: w.root,
          dataDir: w.dataDir,
          scan: w.scan,
          expectedRevision: 0,
          transactionId: 'bad',
          commands: [{ type: COMMAND.RENAME, id: 'keep.txt', name: '../old' }],
        }),
      (error) => error instanceof CommandError && error.code === 'invalid-command'
    );
    assert.equal(loadPlan(w.root, w.dataDir).revision, 0);
    assert.ok(!existsSync(planPath(w.root, w.dataDir)));
  } finally {
    w.cleanup();
  }
});

test('summary ids cannot modify the summary record prototype', () => {
  const w = workspace();
  try {
    const summaries = JSON.parse('{"__proto__":"safe summary"}');
    const result = applyCommands(w.scan, loadPlan(w.root, w.dataDir), [
      { type: COMMAND.MERGE_SUMMARIES, summaries },
    ]);
    assert.equal(Object.getPrototypeOf(result.plan.summaries), Object.prototype);
    assert.equal(Object.hasOwn(result.plan.summaries, '__proto__'), true);
    assert.equal(result.plan.summaries.__proto__, 'safe summary');
  } finally {
    w.cleanup();
  }
});

test('a transaction may persist resolver problems for a later command to fix', () => {
  const w = workspace();
  try {
    const result = transactPlan({
      root: w.root,
      dataDir: w.dataDir,
      scan: w.scan,
      expectedRevision: 0,
      transactionId: 'temporary-collision',
      commands: [{ type: COMMAND.RENAME, id: 'keep.txt', name: 'old' }],
    });

    assert.equal(result.plan.revision, 1);
    assert.ok(result.problems.length > 0);
    assert.equal(loadPlan(w.root, w.dataDir).overrides[0].cur.name, 'old');
  } finally {
    w.cleanup();
  }
});

test('trash and keep are explicit idempotent commands that cascade', () => {
  const w = workspace();
  try {
    const trashed = applyCommands(w.scan, loadPlan(w.root, w.dataDir), [
      { type: COMMAND.TRASH, id: 'old' },
      { type: COMMAND.TRASH, id: 'old' },
    ]).plan;
    assert.deepEqual(
      trashed.overrides.filter((item) => item.evicted).map((item) => item.id).sort(),
      ['old', 'old/junk.log']
    );

    const kept = applyCommands(w.scan, trashed, [{ type: COMMAND.KEEP, id: 'old' }]).plan;
    assert.deepEqual(kept.overrides, []);
  } finally {
    w.cleanup();
  }
});

test('an external data directory holds the portable workspace state', () => {
  const w = workspace();
  try {
    saveView(w.root, { revision: 3, ui: { filterText: 'note' }, collapsed: ['docs'] }, w.dataDir);
    assert.ok(existsSync(join(w.dataDir, 'workspace.json')));
    assert.ok(existsSync(join(w.dataDir, 'scan.json')));
    assert.ok(existsSync(join(w.dataDir, 'view.json')));
    assert.equal(loadScan(w.root, w.dataDir).id, w.scan.id);
    assert.equal(loadView(w.root, w.dataDir).ui.filterText, 'note');
    assert.ok(!existsSync(join(w.root, '.reorg')));
    assert.match(readFileSync(join(w.dataDir, '.gitignore'), 'utf8'), /^\*$/m);
  } finally {
    w.cleanup();
  }
});

test('an explicit data directory inside the source is refused', () => {
  const root = sandbox(TREE);
  const outside = sandbox({});
  try {
    assert.throws(() => ensureWorkspace(root, root), /cannot be used/);
    assert.throws(() => ensureWorkspace(root, join(root, 'state')), /must be outside/);
    const alias = join(outside, 'inside-alias');
    symlinkSync(join(root, 'docs'), alias, 'dir');
    assert.throws(() => ensureWorkspace(root, join(alias, 'state')), /must be outside/);
    assert.doesNotThrow(() => ensureWorkspace(root, join(root, '.reorg')));
  } finally {
    cleanup(outside);
    cleanup(root);
  }
});

test('view projection explains filters, collapse, git tint, and change dimming', () => {
  const root = sandbox(TREE, { git: true });
  try {
    const frozen = scan(root);
    const plan = applyCommands(frozen, loadPlan(root), [
      { type: COMMAND.MOVE, id: 'keep.txt', parentId: 'docs' },
    ]).plan;
    const projection = materializeView(frozen, plan, {
      revision: 2,
      treeInitialized: true,
      collapsed: ['docs'],
      selectedId: 'docs',
      ui: { git: true, filterTag: 'moved', filterText: 'note' },
    });
    const docs = projection.nodes.find((node) => node.id === 'docs');
    const note = projection.nodes.find((node) => node.id === 'docs/note.md');
    const old = projection.nodes.find((node) => node.id === 'old');

    assert.equal(docs.visible, true);
    assert.equal(docs.presentation.selected, true);
    assert.equal(docs.presentation.dimmed, true);
    assert.equal(note.visible, false);
    assert.equal(note.hiddenBy, 'collapsed-ancestor');
    assert.equal(old.visible, false);
    assert.equal(old.hiddenBy, 'filter');
  } finally {
    cleanup(root);
  }
});

test('view updates use an independent revision', () => {
  const w = workspace();
  try {
    const first = transactView({
      root: w.root,
      dataDir: w.dataDir,
      expectedRevision: 0,
      patch: { treeInitialized: true, collapsed: ['docs'], selectedId: 'docs' },
    });
    assert.equal(first.view.revision, 1);
    assert.equal(loadPlan(w.root, w.dataDir).revision, 0);
    assert.throws(
      () =>
        transactView({
          root: w.root,
          dataDir: w.dataDir,
          expectedRevision: 0,
          patch: { selectedId: 'keep.txt' },
        }),
      RevisionConflictError
    );
  } finally {
    w.cleanup();
  }
});

test('the first view update retires legacy UI fields from the plan', () => {
  const w = workspace();
  try {
    savePlan(w.root, { ...loadPlan(w.root, w.dataDir), ui: { theme: 'dark' } }, w.dataDir);
    const result = transactView({
      root: w.root,
      dataDir: w.dataDir,
      expectedRevision: 0,
      patch: {},
    });
    assert.equal(result.view.ui.theme, 'dark');
    assert.deepEqual(loadPlan(w.root, w.dataDir).ui, {});
  } finally {
    w.cleanup();
  }
});

test('invalid view updates are rejected without advancing their revision', () => {
  const w = workspace();
  try {
    assert.throws(
      () =>
        transactView({
          root: w.root,
          dataDir: w.dataDir,
          expectedRevision: 0,
          patch: { ui: { theme: 'solarized' } },
        }),
      (error) => error instanceof CommandError && /theme/.test(error.message)
    );
    assert.equal(loadView(w.root, w.dataDir).revision, 0);
  } finally {
    w.cleanup();
  }
});

test('scans carry normalized options and a portable content id', () => {
  const a = sandbox(TREE);
  try {
    const first = scan(a, { hidden: false, collapseOver: 10 });
    const second = scan(a, { hidden: false, collapseOver: 10 });
    assert.equal(first.id, second.id);
    assert.deepEqual(first.options, {
      all: false,
      hidden: false,
      maxNodes: 20000,
      maxDepth: 24,
      collapseOver: 10,
      git: true,
    });
  } finally {
    cleanup(a);
  }
});
