// Plan persistence.
//
// Everything the user does lives in <root>/.reorg/plan.json -- a diff against the
// scan, not a copy of it. Only divergence is stored (moved/renamed/evicted nodes,
// dirs created in the planner, notes), which keeps the file small and lets it
// survive a rescan: a node that moved away simply won't match, and created dirs
// carry their own definition.
//
// .reorg/ is state, never source. It is git-ignored on first write and excluded
// from the scan, so planning a repo's own layout does not dirty that repo.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

export const STATE_DIR = '.reorg';
export const PLAN_FILE = 'plan.json';
export const PLAN_VERSION = 1;

export function stateDir(root) {
  return join(root, STATE_DIR);
}

export function planPath(root) {
  return join(stateDir(root), PLAN_FILE);
}

export function emptyPlan() {
  return {
    version: PLAN_VERSION,
    savedAt: null,
    scannedAt: null,
    overrides: [],
    created: [],
    notes: [],
    summaries: {},
    ui: {},
  };
}

// Keep .reorg/ out of the host repo's index without touching its .gitignore.
// .git/info/exclude is the wrong place (not shareable, and we may not be at the
// repo root), so a self-ignoring .gitignore inside .reorg/ does the job: it
// excludes the whole directory including itself.
function selfIgnore(dir) {
  const f = join(dir, '.gitignore');
  if (existsSync(f)) return;
  writeFileSync(f, '# reorg working state -- not source. Ignored wholesale.\n*\n');
}

export function ensureStateDir(root) {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  selfIgnore(dir);
  return dir;
}

export function loadPlan(root) {
  const p = planPath(root);
  if (!existsSync(p)) return emptyPlan();
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return { ...emptyPlan(), ...parsed };
  } catch (e) {
    throw new Error(`${p} is not valid JSON (${e.message}). Move it aside to start fresh.`);
  }
}

export function savePlan(root, plan) {
  ensureStateDir(root);
  const out = {
    ...emptyPlan(),
    ...plan,
    version: PLAN_VERSION,
    savedAt: new Date().toISOString(),
  };
  // Write-then-rename so an interrupted save can't truncate a good plan.
  const p = planPath(root);
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, p);
  return out;
}

/**
 * Clear the applied part of a plan, keeping the parts that are still meaningful.
 *
 * Once a plan is applied, the tree IS the plan: leaving the overrides in place
 * makes the next resolve see every created folder twice (once as a real scanned
 * entry, once as a pending creation) and report a phantom collision. Notes and
 * summaries are kept -- they are observations about content, not pending moves.
 */
export function clearAppliedPlan(root) {
  const plan = loadPlan(root);
  return savePlan(root, { ...plan, overrides: [], created: [] });
}

export function logLine(root, entry) {
  ensureStateDir(root);
  appendFileSync(join(stateDir(root), 'history.jsonl'), JSON.stringify(entry) + '\n');
}

export function listUndoScripts(root) {
  const dir = stateDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^undo-\d+\.sh$/.test(f))
    .sort()
    .reverse();
}
