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
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

export const STATE_DIR = '.reorg';
export const PLAN_FILE = 'plan.json';
export const PLAN_VERSION = 1;
export const WORKSPACE_FILE = 'workspace.json';
export const WORKSPACE_VERSION = 1;
export const SCAN_FILE = 'scan.json';
export const VIEW_FILE = 'view.json';
export const VIEW_VERSION = 1;
export const TRANSACTION_LOG_FILE = 'transactions.jsonl';
export const LOCK_FILE = 'workspace.lock';
export const RECENT_TRANSACTION_LIMIT = 100;

export function stateDir(root, dataDir = null) {
  return dataDir ? resolvePath(dataDir) : join(root, STATE_DIR);
}

export function recoveryDir(root) {
  return join(root, STATE_DIR);
}

export function validateDataDir(root, dataDir = null) {
  const rootAbs = resolvePath(root);
  const dir = stateDir(rootAbs, dataDir);
  const rel = relative(rootAbs, dir);
  const isDefault = dir === recoveryDir(rootAbs);
  if (rel === '') {
    throw new Error('The reorganized directory itself cannot be used as --data-dir');
  }
  const isInside = rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  if (isInside && !isDefault) {
    throw new Error('An explicit --data-dir must be outside the reorganized directory');
  }
  return dir;
}

export function planPath(root, dataDir = null) {
  return join(stateDir(root, dataDir), PLAN_FILE);
}

export function workspacePath(root, dataDir = null) {
  return join(stateDir(root, dataDir), WORKSPACE_FILE);
}

export function scanPath(root, dataDir = null) {
  return join(stateDir(root, dataDir), SCAN_FILE);
}

export function viewPath(root, dataDir = null) {
  return join(stateDir(root, dataDir), VIEW_FILE);
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
    revision: 0,
    recentTransactions: [],
  };
}

export function emptyView(legacyUi = {}) {
  return {
    version: VIEW_VERSION,
    revision: 0,
    savedAt: null,
    ui: { ...legacyUi },
    treeInitialized: false,
    collapsed: [],
    selectedId: null,
    side: { mode: 'none', targetId: null },
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

export function ensureStateDir(root, dataDir = null) {
  const dir = validateDataDir(root, dataDir);
  mkdirSync(dir, { recursive: true });
  selfIgnore(dir);
  return dir;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} is not valid JSON for ${label} (${e.message}). Move it aside to start fresh.`);
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function loadPlan(root, dataDir = null) {
  const p = planPath(root, dataDir);
  if (!existsSync(p)) return emptyPlan();
  const parsed = readJson(p, 'plan');
  const plan = { ...emptyPlan(), ...parsed };
  if (!Number.isInteger(plan.revision) || plan.revision < 0) {
    throw new Error(`${p} has an invalid revision`);
  }
  if (!Array.isArray(plan.recentTransactions)) plan.recentTransactions = [];
  return plan;
}

export function savePlan(root, plan, dataDir = null) {
  ensureStateDir(root, dataDir);
  const out = {
    ...emptyPlan(),
    ...plan,
    version: PLAN_VERSION,
    savedAt: new Date().toISOString(),
  };
  if (!Number.isInteger(out.revision) || out.revision < 0) {
    throw new Error('Cannot save a plan with an invalid revision');
  }
  out.recentTransactions = (out.recentTransactions || []).slice(-RECENT_TRANSACTION_LIMIT);
  writeJsonAtomic(planPath(root, dataDir), out);
  return out;
}

export function loadView(root, dataDir = null, legacyUi = {}) {
  const p = viewPath(root, dataDir);
  if (!existsSync(p)) return emptyView(legacyUi);
  const parsed = readJson(p, 'view');
  const view = { ...emptyView(legacyUi), ...parsed };
  view.ui = { ...legacyUi, ...(parsed.ui || {}) };
  view.side = { mode: 'none', targetId: null, ...(parsed.side || {}) };
  if (!Array.isArray(view.collapsed)) view.collapsed = [];
  if (!Number.isInteger(view.revision) || view.revision < 0) {
    throw new Error(`${p} has an invalid revision`);
  }
  return view;
}

export function saveView(root, view, dataDir = null) {
  ensureStateDir(root, dataDir);
  const out = {
    ...emptyView(),
    ...view,
    version: VIEW_VERSION,
    savedAt: new Date().toISOString(),
    ui: { ...(view.ui || {}) },
    collapsed: [...new Set(view.collapsed || [])].sort(),
    side: { mode: 'none', targetId: null, ...(view.side || {}) },
  };
  if (!Number.isInteger(out.revision) || out.revision < 0) {
    throw new Error('Cannot save a view with an invalid revision');
  }
  writeJsonAtomic(viewPath(root, dataDir), out);
  return out;
}

export function loadScan(root, dataDir = null) {
  const p = scanPath(root, dataDir);
  if (!existsSync(p)) return null;
  const value = readJson(p, 'scan');
  if (!value || !Array.isArray(value.nodes) || typeof value.root !== 'string') {
    throw new Error(`${p} does not contain a valid scan`);
  }
  return value;
}

export function saveScan(root, scanResult, dataDir = null) {
  ensureStateDir(root, dataDir);
  writeJsonAtomic(scanPath(root, dataDir), scanResult);
  return scanResult;
}

export function loadWorkspace(root, dataDir = null) {
  const p = workspacePath(root, dataDir);
  if (!existsSync(p)) return null;
  const value = readJson(p, 'workspace');
  if (value.format !== 'reorg-workspace' || value.version !== WORKSPACE_VERSION || !value.id) {
    throw new Error(`${p} has an unsupported workspace format`);
  }
  return value;
}

export function ensureWorkspace(root, dataDir = null) {
  const dir = ensureStateDir(root, dataDir);
  const existing = loadWorkspace(root, dir);
  if (existing) return existing;
  const now = new Date().toISOString();
  const workspace = {
    format: 'reorg-workspace',
    version: WORKSPACE_VERSION,
    id: randomUUID(),
    root: resolvePath(root),
    createdAt: now,
    updatedAt: now,
  };
  writeJsonAtomic(workspacePath(root, dir), workspace);
  return workspace;
}

export function saveWorkspace(root, workspace, dataDir = null) {
  ensureStateDir(root, dataDir);
  const out = {
    ...workspace,
    format: 'reorg-workspace',
    version: WORKSPACE_VERSION,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(workspacePath(root, dataDir), out);
  return out;
}

export function withWorkspaceLock(root, dataDir, fn) {
  const dir = ensureStateDir(root, dataDir);
  const path = join(dir, LOCK_FILE);
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`Workspace is busy: ${path}`);
    throw e;
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}

export function logTransaction(root, entry, dataDir = null) {
  ensureStateDir(root, dataDir);
  appendFileSync(join(stateDir(root, dataDir), TRANSACTION_LOG_FILE), JSON.stringify(entry) + '\n');
}

/**
 * Clear the applied part of a plan, keeping the parts that are still meaningful.
 *
 * Once a plan is applied, the tree IS the plan: leaving the overrides in place
 * makes the next resolve see every created folder twice (once as a real scanned
 * entry, once as a pending creation) and report a phantom collision. Notes and
 * summaries are kept -- they are observations about content, not pending moves.
 */
export function clearAppliedPlan(root, sourcePlan = null, dataDir = null) {
  const plan = sourcePlan || loadPlan(root, dataDir);
  const revision = Number.isInteger(plan.revision) ? plan.revision + 1 : 1;
  return savePlan(root, { ...plan, overrides: [], created: [], revision }, dataDir);
}

export function logLine(root, entry) {
  const dir = recoveryDir(root);
  mkdirSync(dir, { recursive: true });
  selfIgnore(dir);
  appendFileSync(join(dir, 'history.jsonl'), JSON.stringify(entry) + '\n');
}

export function listUndoScripts(root) {
  const dir = recoveryDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^undo-\d+\.sh$/.test(f))
    .sort()
    .reverse();
}
