// Execute a resolved plan against the filesystem.
//
// Safety posture, in order of how much it matters:
//  1. Dry run is the default everywhere; nothing here runs without an explicit flag.
//  2. Drift check: every source path is verified to still exist, and every
//     destination to be free, BEFORE the first mutation. A tree that changed
//     under the plan aborts with no partial application.
//  3. Nothing is deleted. "Trash" means move into .reorg/trash/<stamp>/, which the
//     undo script can put back. Emptying that is a separate, manual decision.
//  4. An undo script is written before execution starts, so a crash mid-run still
//     leaves a way back.
//  5. Inside a git repo, tracked paths move with `git mv` so history follows.

import { mkdirSync, renameSync, writeFileSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { OP, describeOp } from './plan.js';
import { ensureStateDir, stateDir, logLine, STATE_DIR } from './state.js';
import { directoryProblem } from './paths.js';
import { acquireRecoveryLock, buildUndoScript, createJournal, entryIdentity, saveJournal, RECOVERY_LOCK_FILE, RUNS_DIR, RUN_STATUS } from './recovery.js';

export { buildUndoScript } from './recovery.js';

const TRASH_DIR = 'trash';
const APPLY_ERROR_CODE = Object.freeze({ PREFLIGHT: 'apply-preflight', INTERRUPTED: 'apply-interrupted' });
const OP_PATH_FIELDS = Object.freeze(['from', 'to', 'origFrom', 'finalTo']);

function pathStaysUnderRoot(root, path) {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) return false;
  const rel = relative(root, resolvePath(root, path));
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

// Presence check that does NOT follow symlinks. `existsSync` resolves the target,
// so a broken symlink reads as absent -- and scratch directories are full of them
// (a link to a deleted checkout, a dangling firmlink). Treating one as "gone since
// the scan" would abort an entire batch over an entry that is sitting right there
// and moves perfectly well. What matters here is whether the path is occupied, not
// whether what it points at resolves.
function pathExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
function gitTracks(root, relPath) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', relPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function isGitRepo(root) {
  try {
    return (
      execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

/**
 * Verify the tree still matches what the plan was built against.
 * Returns an array of problem strings; empty means safe to proceed.
 */
export function checkDrift(root, ops) {
  const problems = [];
  for (const op of ops) {
    for (const field of OP_PATH_FIELDS) {
      if (op[field] !== undefined && !pathStaysUnderRoot(root, op[field])) {
        problems.push(`Plan contains an unsafe ${field} path: ${JSON.stringify(op[field])}.`);
      }
    }
  }
  if (problems.length) return problems;

  const directories = [STATE_DIR, STATE_DIR + '/stage', STATE_DIR + '/' + TRASH_DIR, STATE_DIR + '/' + RUNS_DIR];
  for (const directory of directories) {
    const problem = directoryProblem(root, directory);
    if (problem) problems.push(problem);
  }
  if (problems.length) return [...new Set(problems)];

  // Replay prior operations backwards to locate an entry in the original tree
  // This accounts for descendants carried by a moved directory without scanning it
  const changes = [];
  const normalize = location => relative(resolvePath(root), resolvePath(root, location));
  const under = (child, parent) => child.startsWith(parent + sep);
  const entryAt = location => {
    let original = location;
    if (!original) return 'dir';
    for (let index = changes.length - 1; index >= 0; index--) {
      const change = changes[index];
      if (change.op === OP.MKDIR) {
        if (original === change.to) return 'dir';
        if (under(original, change.to)) return null;
      } else if (change.op === OP.TRASH) {
        if (original === change.from || under(original, change.from)) return null;
      } else {
        if (original === change.to || under(original, change.to)) {
          original = change.from + original.slice(change.to.length);
        } else if (original === change.from || under(original, change.from)) {
          return null;
        }
      }
    }
    const problem = directoryProblem(root, dirname(original));
    if (problem) throw new Error(problem);
    try {
      const entry = lstatSync(join(root, original));
      return entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : 'file';
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const checkParents = (location, createRecovery = false) => {
    const parts = location.split(sep).slice(0, -1);
    let parent = '';
    for (const part of parts) {
      parent = parent ? parent + sep + part : part;
      const kind = entryAt(parent);
      if (kind === null && createRecovery && (parent === STATE_DIR || under(parent, STATE_DIR))) {
        changes.push({ op: OP.MKDIR, to: parent });
      } else if (kind === 'link') {
        throw new Error(parent + ' is a symbolic link; refusing to follow it.');
      } else if (kind === null) {
        throw new Error(parent + ' no longer exists (required parent directory).');
      } else if (kind !== 'dir') {
        throw new Error(parent + ' is not a directory.');
      }
    }
  };

  for (const op of ops) {
    try {
      const to = normalize(op.to);
      checkParents(to, op.op === OP.STAGE);
      if (op.op === OP.MKDIR) {
        const kind = entryAt(to);
        if (kind === 'link') throw new Error(op.to + ' is a symbolic link; refusing to follow it.');
        if (kind !== null && kind !== 'dir') throw new Error(op.to + ' is not a directory.');
        if (kind === null) changes.push({ op: OP.MKDIR, to });
      } else if (op.op === OP.TRASH) {
        if (!entryAt(to)) throw new Error(op.to + ' no longer exists (nothing to trash).');
        changes.push({ op: OP.TRASH, from: to });
      } else {
        const from = normalize(op.from);
        checkParents(from);
        const kind = entryAt(from);
        if (kind === null) throw new Error(op.from + ' no longer exists (moved or deleted since the scan).');
        if (op.kind && kind !== op.kind) throw new Error(op.from + ' changed entry kind since the scan.');
        if (entryAt(to)) throw new Error(op.to + ' already exists; refusing to overwrite it.');
        if (under(to, from)) throw new Error(op.from + ' cannot move inside itself.');
        changes.push({ op: OP.MOVE, from, to });
      }
    } catch (error) {
      problems.push(error.message);
    }
  }
  return problems;
}


/**
 * Apply `ops` under `root`.
 *
 * opts:
 *   dryRun   (default true) print only, touch nothing
 *   onLog    (line) => void, progress sink
 *   useGit   force git mv on/off; defaults to auto-detect
 *
 * Returns { applied, skipped, undoScript, stamp, problems }.
 */
export function apply(root, ops, opts = {}) {
  const started = performance.now();
  const dryRun = opts.dryRun !== false;
  const log = opts.onLog || (() => {});
  const stamp = String(opts.stamp ?? Date.now());
  const useGit = opts.useGit ?? isGitRepo(root);
  const problems = checkDrift(root, ops);
  if (!/^[A-Za-z0-9_-]+$/.test(stamp)) problems.push('Invalid apply run identifier');
  if (problems.length) return { applied: 0, skipped: ops.length, problems, stamp, undoScript: null };

  const undoScript = buildUndoScript(ops, stamp, { gitNote: useGit });
  if (dryRun || !ops.length) {
    for (const op of ops) log('  ' + describeOp(op));
    return { applied: 0, skipped: 0, problems: [], stamp, undoScript, dryRun };
  }

  let recovery;
  let release;
  const undoPath = join(stateDir(root), 'undo-' + stamp + '.sh');
  try {
    ensureStateDir(root);
    release = acquireRecoveryLock(join(stateDir(root), RECOVERY_LOCK_FILE));
    recovery = createJournal(root, stamp);
    writeFileSync(undoPath, undoScript, { flag: 'wx', mode: 0o700, flush: true });
  } catch (error) {
    if (release) release();
    return { applied: 0, skipped: ops.length, problems: [error.message], stamp,
      undoScript: null, code: APPLY_ERROR_CODE.PREFLIGHT };
  }

  const { runDir, journalPath, journal } = recovery;
  const trashRoot = join(stateDir(root), TRASH_DIR, stamp);
  let applied = 0;
  const durationMs = () => Math.round(performance.now() - started);

  const mv = (fromAbs, toAbs, { useIndex = false, created = false } = {}) => {
    const from = relative(root, fromAbs);
    const to = relative(root, toAbs);
    for (const location of [dirname(from), dirname(to)]) {
      const problem = directoryProblem(root, location);
      if (problem) throw new Error(problem);
    }
    if (to.startsWith(STATE_DIR + '/')) mkdirSync(dirname(toAbs), { recursive: true });
    const identity = entryIdentity(fromAbs);
    if (!identity) throw new Error(from + ' no longer exists');
    if (pathExists(toAbs)) throw new Error(to + ' is occupied; refusing to overwrite it');
    const step = { from, to, identity, created, completed: false };
    journal.steps.push(step);
    saveJournal(journalPath, journal);
    let how = 'mv';
    if (useIndex && useGit && gitTracks(root, from)) {
      try {
        execFileSync('git', ['-C', root, 'mv', '--', from, to], { stdio: ['ignore', 'ignore', 'pipe'] });
        how = 'git mv';
      } catch {
        if (entryIdentity(toAbs) === identity && entryIdentity(fromAbs) === null) how = 'mv (review Git index)';
      }
    }
    if (how === 'mv') {
      if (entryIdentity(fromAbs) !== identity || pathExists(toAbs)) throw new Error('Filesystem drift while moving ' + from);
      renameSync(fromAbs, toAbs);
    }
    applied++;
    step.completed = true;
    saveJournal(journalPath, journal);
    return how;
  };

  try {
    for (const op of ops) {
      if (op.op === OP.MKDIR) {
        const problem = directoryProblem(root, op.to);
        if (problem) throw new Error(problem);
        if (pathExists(join(root, op.to))) {
          applied++;
        } else {
          const owned = join(runDir, 'directory-' + journal.steps.length);
          mkdirSync(owned);
          mv(owned, join(root, op.to), { created: true });
        }
        log('  mkdir  ' + op.to + '/');
      } else if (op.op === OP.MOVE || op.op === OP.UNSTAGE) {
        const how = mv(join(root, op.from), join(root, op.to), { useIndex: true });
        log('  ' + how + ' ' + op.from + '  ->  ' + op.to);
      } else if (op.op === OP.STAGE) {
        mv(join(root, op.from), join(root, op.to));
        log('  stage  ' + op.from);
      } else if (op.op === OP.TRASH) {
        mv(join(root, op.to), join(trashRoot, op.to));
        log('  trash  ' + op.to);
      }
    }
    journal.status = RUN_STATUS.APPLIED;
    saveJournal(journalPath, journal);
    logLine(root, {
      at: new Date().toISOString(), stamp, status: journal.status, applied, durationMs: durationMs(),
      ops: ops.map(op => ({ op: op.op, from: op.from ?? null, to: op.to })),
    });
  } catch (error) {
    journal.status = RUN_STATUS.PARTIAL;
    journal.error = { code: APPLY_ERROR_CODE.INTERRUPTED, message: error.message, at: new Date().toISOString() };
    const problems = [error.message];
    try { saveJournal(journalPath, journal); } catch (failure) { problems.push('Recovery journal update failed: ' + failure.message); }
    try {
      logLine(root, { at: journal.error.at, stamp, status: journal.status, applied,
        error: journal.error, durationMs: durationMs() });
    } catch (failure) { problems.push('History update failed: ' + failure.message); }
    return { applied, skipped: ops.length - applied, problems, stamp, undoScript, undoPath, trashRoot,
      partial: true, code: APPLY_ERROR_CODE.INTERRUPTED, durationMs: durationMs() };
  } finally {
    release();
  }

  return { applied, skipped: 0, problems: [], stamp, undoScript, undoPath, trashRoot, durationMs: durationMs() };
}
