// State tests: plan persistence, and the promise that .reorg/ never dirties a repo.
//
// The plan is a diff against the scan rather than a copy of the tree, which is
// what lets it survive a rescan. These tests pin that property, the atomicity of
// a save, and the self-ignoring state directory -- planning a repo's own layout
// must not show up in `git status`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  STATE_DIR,
  PLAN_VERSION,
  stateDir,
  planPath,
  emptyPlan,
  ensureStateDir,
  loadPlan,
  savePlan,
  clearAppliedPlan,
  logLine,
  listUndoScripts,
} from '../src/state.js';
import { sandbox, cleanup } from './helpers.js';

test('a directory with no state yet loads as an empty plan rather than failing', () => {
  const root = sandbox({ 'a.txt': 'x' });
  try {
    const plan = loadPlan(root);
    assert.equal(plan.version, PLAN_VERSION);
    assert.deepEqual(plan.overrides, []);
    assert.deepEqual(plan.created, []);
    assert.equal(plan.savedAt, null);
    assert.ok(!existsSync(stateDir(root)), 'reading must not create the state dir');
  } finally {
    cleanup(root);
  }
});

test('a saved plan round-trips and is stamped', () => {
  const root = sandbox({ 'a.txt': 'x' });
  try {
    const saved = savePlan(root, {
      ...emptyPlan(),
      overrides: [{ id: 'a.txt', cur: { name: 'b.txt', parentId: '.' } }],
    });
    assert.ok(saved.savedAt, 'a save records when it happened');

    const loaded = loadPlan(root);
    assert.deepEqual(loaded.overrides, [{ id: 'a.txt', cur: { name: 'b.txt', parentId: '.' } }]);
    assert.equal(loaded.version, PLAN_VERSION);
  } finally {
    cleanup(root);
  }
});

test('an unknown-shaped plan is filled in from the empty template', () => {
  // Forward compatibility: a plan written by an older build is missing keys the
  // current one reads, and every reader would otherwise need its own guards.
  const root = sandbox({ 'a.txt': 'x' });
  try {
    ensureStateDir(root);
    writeFileSync(planPath(root), JSON.stringify({ overrides: [{ id: 'a.txt' }] }));
    const plan = loadPlan(root);
    assert.deepEqual(plan.created, []);
    assert.deepEqual(plan.notes, []);
    assert.deepEqual(plan.summaries, {});
    assert.equal(plan.overrides.length, 1);
  } finally {
    cleanup(root);
  }
});

test('a corrupt plan is a clear error, not a silently discarded one', () => {
  // Silently starting fresh would throw away work the user can still recover by
  // hand, so this is deliberately loud.
  const root = sandbox({ 'a.txt': 'x' });
  try {
    ensureStateDir(root);
    writeFileSync(planPath(root), '{ this is not json');
    assert.throws(() => loadPlan(root), /not valid JSON/);
  } finally {
    cleanup(root);
  }
});

test('a save leaves no temp file behind', () => {
  // The write-then-rename is what stops an interrupted save from truncating a
  // good plan; a leftover .tmp would mean the rename never happened.
  const root = sandbox({ 'a.txt': 'x' });
  try {
    savePlan(root, emptyPlan());
    const leftovers = readdirSync(stateDir(root)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    assert.ok(existsSync(planPath(root)));
  } finally {
    cleanup(root);
  }
});

test('a second save replaces the first rather than appending', () => {
  const root = sandbox({ 'a.txt': 'x' });
  try {
    savePlan(root, { ...emptyPlan(), notes: [{ id: 'a.txt', text: 'first' }] });
    savePlan(root, { ...emptyPlan(), notes: [{ id: 'a.txt', text: 'second' }] });
    const plan = loadPlan(root);
    assert.deepEqual(plan.notes, [{ id: 'a.txt', text: 'second' }]);
    assert.doesNotThrow(() => JSON.parse(readFileSync(planPath(root), 'utf8')));
  } finally {
    cleanup(root);
  }
});

test('clearAppliedPlan drops pending moves but keeps observations', () => {
  const root = sandbox({ 'a.txt': 'x' });
  try {
    savePlan(root, {
      ...emptyPlan(),
      overrides: [{ id: 'a.txt', cur: { name: 'a.txt', parentId: 'docs' } }],
      created: [{ id: 'docs', cur: { name: 'docs', parentId: '.' } }],
      notes: [{ id: 'a.txt', text: 'keep this note' }],
      summaries: { 'a.txt': 'a text file' },
    });

    clearAppliedPlan(root);
    const plan = loadPlan(root);
    assert.deepEqual(plan.overrides, [], 'applied moves are retired');
    assert.deepEqual(plan.created, [], 'applied folder creations are retired');
    assert.deepEqual(plan.notes, [{ id: 'a.txt', text: 'keep this note' }], 'notes survive');
    assert.deepEqual(plan.summaries, { 'a.txt': 'a text file' }, 'summaries survive');
  } finally {
    cleanup(root);
  }
});

test('the state directory ignores itself, so planning a repo never dirties it', () => {
  const root = sandbox({ 'tracked.txt': 'x' }, { git: true });
  try {
    ensureStateDir(root);
    savePlan(root, { ...emptyPlan(), notes: [{ id: 'tracked.txt', text: 'n' }] });
    logLine(root, { at: 'now', applied: 1 });

    const ignore = readFileSync(join(stateDir(root), '.gitignore'), 'utf8');
    assert.match(ignore, /^\*$/m, 'the ignore file excludes everything including itself');

    const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(status.trim(), '', `planning left the repo dirty:\n${status}`);
  } finally {
    cleanup(root);
  }
});

test('an existing ignore file in the state dir is not overwritten', () => {
  const root = sandbox({ 'a.txt': 'x' });
  try {
    ensureStateDir(root);
    const f = join(stateDir(root), '.gitignore');
    writeFileSync(f, '# hand-edited\n*\n');
    ensureStateDir(root);
    assert.match(readFileSync(f, 'utf8'), /hand-edited/);
  } finally {
    cleanup(root);
  }
});

test('history is appended as one JSON record per line', () => {
  const root = sandbox({ 'a.txt': 'x' });
  try {
    logLine(root, { at: 'first', applied: 1 });
    logLine(root, { at: 'second', applied: 2 });
    const lines = readFileSync(join(stateDir(root), 'history.jsonl'), 'utf8')
      .trim()
      .split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).at, 'first');
    assert.equal(JSON.parse(lines[1]).applied, 2);
  } finally {
    cleanup(root);
  }
});

test('undo scripts are listed newest first, and nothing else is', () => {
  const root = sandbox({ 'a.txt': 'x' });
  try {
    assert.deepEqual(listUndoScripts(root), [], 'no state dir means no scripts');

    ensureStateDir(root);
    const dir = stateDir(root);
    for (const f of ['undo-100.sh', 'undo-300.sh', 'undo-200.sh']) writeFileSync(join(dir, f), '#!/bin/bash\n');
    // Neighbours that must not be mistaken for undo scripts.
    writeFileSync(join(dir, 'history.jsonl'), '{}\n');
    writeFileSync(join(dir, 'plan.json'), '{}');
    writeFileSync(join(dir, 'undo-notes.sh'), 'x');

    assert.deepEqual(listUndoScripts(root), ['undo-300.sh', 'undo-200.sh', 'undo-100.sh']);
  } finally {
    cleanup(root);
  }
});

test('state lives under the documented directory name', () => {
  const root = sandbox({ 'a.txt': 'x' });
  try {
    assert.equal(stateDir(root), join(root, STATE_DIR));
    assert.equal(planPath(root), join(root, STATE_DIR, 'plan.json'));
  } finally {
    cleanup(root);
  }
});
