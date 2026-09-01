import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanup, sandbox } from './helpers.js';

const CLI = new URL('../bin/reorg', import.meta.url);

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function runJson(args, options = {}) {
  const result = runCli([...args, '--json'], options);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const TREE = {
  'docs/note.md': 'note',
  'docs/nested/deep.txt': 'deep',
  'keep.txt': 'keep',
};

test('schema exposes semantic agent mutations and the opt-in browser apply boundary', () => {
  const schema = runJson(['schema']);
  const types = schema.planTransaction.commands.map((entry) => entry.type);
  assert.equal(schema.version, 2);
  assert.equal(schema.jsonSchemaDialect, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.planTransaction.inputSchema.$schema, schema.jsonSchemaDialect);
  assert.equal(schema.viewUpdate.inputSchema.$schema, schema.jsonSchemaDialect);
  assert.ok(types.includes('move'));
  assert.ok(types.includes('create-folder'));
  assert.ok(types.includes('set-note'));
  assert.ok(types.includes('reset-plan'));
  assert.match(schema.inspect.rescanCommand, /reorg rescan/);
  assert.equal(schema.safety.directStateFileMutationSupported, false);
  assert.equal(schema.safety.stateCommandsModifySourceFilesystem, false);
  assert.equal(schema.safety.browserApplyEnabledByDefault, false);
  assert.equal(schema.safety.browserApplyEnableFlag, '--allow-apply');
  assert.match(schema.safety.filesystemApplyCommand, /reorg apply.*--yes/);
});

test('inspect, mutate, and view share one revisioned workspace without touching source files', () => {
  const root = sandbox(TREE);
  const stateRoot = sandbox({});
  const dataDir = join(stateRoot, 'portable');
  try {
    const initial = runJson(['inspect', root, '--data-dir', dataDir]);
    assert.equal(initial.workspace.root, root);
    assert.equal(initial.plan.revision, 0);
    assert.equal(initial.view.revision, 0);
    assert.ok(initial.scan.nodes.some((node) => node.id === 'keep.txt'));

    const transaction = {
      transactionId: 'agent-move',
      actor: 'test-agent',
      commands: [{ type: 'move', id: 'keep.txt', parentId: 'docs' }],
    };
    const moved = runJson(['mutate', root, '--data-dir', dataDir, '--input', '-'], {
      input: JSON.stringify(transaction),
    });
    assert.equal(moved.plan.revision, 1);
    assert.ok(moved.ops.some((op) => op.from === 'keep.txt' && op.to === 'docs/keep.txt'));
    assert.ok(existsSync(join(root, 'keep.txt')));
    assert.ok(!existsSync(join(root, 'docs/keep.txt')));

    const stale = runCli([
      'mutate',
      root,
      '--data-dir',
      dataDir,
      '--expected-revision',
      '0',
      '--input',
      '-',
      '--json',
    ], {
      input: JSON.stringify([{ type: 'rename', id: 'keep.txt', name: 'kept.txt' }]),
    });
    assert.equal(stale.status, 1);
    const staleError = JSON.parse(stale.stderr);
    assert.equal(staleError.code, 'revision-conflict');
    assert.equal(staleError.subject, 'plan');

    const duplicate = runJson(['mutate', root, '--data-dir', dataDir, '--input', '-'], {
      input: JSON.stringify(transaction),
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.plan.revision, 1);

    const focused = runJson([
      'view',
      root,
      '--data-dir',
      dataDir,
      '--focus',
      'docs/nested/deep.txt',
    ]);
    assert.equal(focused.view.revision, 1);
    assert.equal(focused.view.selectedId, 'docs/nested/deep.txt');
    assert.ok(!focused.view.collapsed.includes('docs/nested'));

    const inspected = runJson(['inspect', '--data-dir', dataDir]);
    const selected = inspected.projection.nodes.find((node) => node.id === focused.view.selectedId);
    assert.equal(inspected.plan.revision, 1);
    assert.equal(inspected.view.revision, 1);
    assert.equal(inspected.transactions[0].actor, 'test-agent');
    assert.equal(selected.visible, true);
    assert.equal(selected.presentation.selected, true);
    assert.equal(inspected.resolved.ops[0].to, 'docs/keep.txt');
  } finally {
    cleanup(stateRoot);
    cleanup(root);
  }
});

test('rescan explicitly refreshes the frozen state shared with inspect', () => {
  const root = sandbox(TREE);
  try {
    const initial = runJson(['inspect', root, '--depth', '1']);
    assert.equal(initial.scan.options.maxDepth, 1);
    writeFileSync(join(root, 'arrived.txt'), 'new');

    const stillFrozen = runJson(['inspect', root]);
    assert.equal(stillFrozen.scan.id, initial.scan.id);
    assert.ok(!stillFrozen.scan.nodes.some((node) => node.id === 'arrived.txt'));

    const refreshed = runJson(['rescan', root]);
    assert.notEqual(refreshed.scan.id, initial.scan.id);
    assert.equal(refreshed.scan.options.maxDepth, 1);
    assert.ok(refreshed.scan.nodes.some((node) => node.id === 'arrived.txt'));
    assert.equal(runJson(['inspect', root]).scan.id, refreshed.scan.id);
  } finally {
    cleanup(root);
  }
});

test('portable data can move independently and still infer its bound root', () => {
  const root = sandbox(TREE);
  const stateRoot = sandbox({});
  const source = join(stateRoot, 'source-state');
  const destination = join(stateRoot, 'moved-state');
  try {
    const uninferred = runCli(['inspect', '--data-dir', source, '--json']);
    assert.equal(uninferred.status, 1);
    assert.match(JSON.parse(uninferred.stderr).error, /explicit source directory/);
    assert.equal(existsSync(source), false);

    runJson(['inspect', root, '--data-dir', source]);
    runJson(['mutate', root, '--data-dir', source, '--input', '-'], {
      input: JSON.stringify([{ type: 'rename', id: 'keep.txt', name: 'kept.txt' }]),
    });
    runJson(['view', root, '--data-dir', source, '--focus', 'keep.txt']);
    const beforeLog = readFileSync(join(source, 'transactions.jsonl'), 'utf8');

    const moved = runJson(['state', 'move', destination, '--data-dir', source]);
    assert.equal(moved.source, source);
    assert.equal(moved.destination, destination);
    assert.equal(moved.method, 'rename');
    assert.equal(existsSync(source), false);
    assert.equal(readFileSync(join(destination, 'transactions.jsonl'), 'utf8'), beforeLog);

    const inspected = runJson(['inspect', '--data-dir', destination]);
    assert.equal(inspected.workspace.root, root);
    assert.equal(inspected.plan.revision, 1);
    assert.equal(inspected.view.revision, 1);
    assert.equal(inspected.view.selectedId, 'keep.txt');
    assert.equal(inspected.resolved.ops[0].to, 'kept.txt');
  } finally {
    cleanup(stateRoot);
    cleanup(root);
  }
});

test('moving default workspace data leaves apply recovery beside the source tree', () => {
  const root = sandbox(TREE);
  const stateRoot = sandbox({});
  const external = join(stateRoot, 'portable');
  const defaultData = join(root, '.reorg');
  try {
    runJson(['mutate', root, '--input', '-'], {
      input: JSON.stringify([{ type: 'rename', id: 'keep.txt', name: 'kept.txt' }]),
    });
    const applied = runCli(['apply', root, '--yes']);
    assert.equal(applied.status, 0, applied.stderr);
    const recoveryBefore = readdirSync(defaultData).filter((name) =>
      /^undo-\d+\.sh$/.test(name) || name === 'history.jsonl' || name === 'trash'
    );
    assert.ok(recoveryBefore.length > 0);

    const moved = runJson(['state', 'move', external, '--data-dir', defaultData]);
    assert.equal(moved.method, 'split-copy');
    assert.ok(existsSync(join(external, 'workspace.json')));
    assert.equal(existsSync(join(defaultData, 'workspace.json')), false);
    for (const name of recoveryBefore) assert.ok(existsSync(join(defaultData, name)));

    const movedBack = runJson(['state', 'move', defaultData, '--data-dir', external]);
    assert.equal(movedBack.method, 'merge-copy');
    assert.equal(existsSync(external), false);
    assert.ok(existsSync(join(defaultData, 'workspace.json')));
    for (const name of recoveryBefore) assert.ok(existsSync(join(defaultData, name)));

    const undone = runCli(['undo', root]);
    assert.equal(undone.status, 0, undone.stderr);
    assert.match(undone.stdout, /Refreshed the shared scan/);
    const inspected = runJson(['inspect', root]);
    assert.ok(inspected.scan.nodes.some((node) => node.id === 'keep.txt'));
    assert.ok(!inspected.scan.nodes.some((node) => node.id === 'kept.txt'));
  } finally {
    cleanup(stateRoot);
    cleanup(root);
  }
});

test('rebind validates a relocated source and CLI apply keeps recovery beside that source', () => {
  const container = sandbox({
    'source/docs/note.md': 'note',
    'source/docs/nested/deep.txt': 'deep',
    'source/keep.txt': 'keep',
    'wrong/docs/note.md': 'note',
    'wrong/docs/nested/deep.txt': 'deep',
    'wrong/keep.txt': 'different-size',
  });
  const originalRoot = join(container, 'source');
  const relocatedRoot = join(container, 'relocated');
  const wrongRoot = join(container, 'wrong');
  const stateRoot = sandbox({});
  const dataDir = join(stateRoot, 'portable');

  try {
    runJson(['inspect', originalRoot, '--data-dir', dataDir]);
    runJson(['mutate', originalRoot, '--data-dir', dataDir, '--input', '-'], {
      input: JSON.stringify([
        { type: 'rename', id: 'keep.txt', name: 'kept.txt' },
        { type: 'set-note', id: 'note:keep', target: 'keep.txt', body: 'Keep this context' },
        { type: 'merge-summaries', summaries: { 'keep.txt': 'A keeper' } },
      ]),
    });
    runJson(['view', originalRoot, '--data-dir', dataDir, '--focus', 'keep.txt']);

    const refused = runCli(['state', 'rebind', wrongRoot, '--data-dir', dataDir]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /does not match the frozen scan/i);

    renameSync(originalRoot, relocatedRoot);
    const rebound = runJson(['state', 'rebind', relocatedRoot, '--data-dir', dataDir]);
    assert.equal(rebound.workspace.root, relocatedRoot);

    const dry = runCli(['apply', '--data-dir', dataDir]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /keep\.txt\s+->\s+kept\.txt/);
    assert.ok(existsSync(join(relocatedRoot, 'keep.txt')));

    const applied = runCli(['apply', '--data-dir', dataDir, '--yes']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Undo with:.*--data-dir/);
    assert.equal(existsSync(join(relocatedRoot, 'keep.txt')), false);
    assert.ok(existsSync(join(relocatedRoot, 'kept.txt')));
    assert.ok(existsSync(join(relocatedRoot, '.reorg')));
    assert.equal(existsSync(join(dataDir, 'plan.json')), true);

    const inspected = runJson(['inspect', '--data-dir', dataDir]);
    assert.equal(inspected.workspace.root, relocatedRoot);
    assert.equal(inspected.plan.revision, 2);
    assert.deepEqual(inspected.plan.overrides, []);
    assert.equal(inspected.plan.notes[0].target, 'kept.txt');
    assert.equal(inspected.plan.summaries['kept.txt'], 'A keeper');
    assert.equal(inspected.view.selectedId, 'kept.txt');
    assert.ok(inspected.scan.nodes.some((node) => node.id === 'kept.txt'));
    assert.ok(!inspected.scan.nodes.some((node) => node.id === 'keep.txt'));
    assert.match(readFileSync(join(dataDir, 'transactions.jsonl'), 'utf8'), /retire-applied-plan/);
  } finally {
    cleanup(stateRoot);
    cleanup(container);
  }
});
