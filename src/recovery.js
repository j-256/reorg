import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { directoryProblem } from './paths.js';

export const RUNS_DIR = 'runs';
export const RECOVERY_LOCK_FILE = 'apply.lock';
const JOURNAL_FILE = 'journal.json';
const RECOVERY_VERSION = 1;
const RECOVERY_LOCK_RECLAIM_SUFFIX = '.reclaim';
export const RUN_STATUS = Object.freeze({ APPLYING: 'applying', APPLIED: 'applied', PARTIAL: 'partial', UNDOING: 'undoing', UNDONE: 'undone' });

export function entryIdentity(filename) {
  try {
    const entry = fs.lstatSync(filename, { bigint: true });
    return `${entry.dev}:${entry.ino}:${entry.mode & 0o170000n}:${entry.birthtimeNs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Flush the replacement before installing it, then flush its directory entry
export function saveJournal(filename, journal) {
  const root = path.resolve(path.dirname(filename), '../../..');
  const problem = directoryProblem(root, path.dirname(filename));
  if (problem) throw new Error(problem);
  if (journal.rootIdentity !== entryIdentity(fs.realpathSync(root))) {
    throw new Error('The source directory identity changed while saving recovery data');
  }
  const temporary = `${filename}.tmp-${randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(journal));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

export function createJournal(root, stamp) {
  if (!/^[A-Za-z0-9_-]+$/.test(stamp)) throw new Error('Invalid apply run identifier');
  const runs = path.join('.reorg', RUNS_DIR);
  const problem = directoryProblem(root, runs);
  if (problem) throw new Error(problem);
  fs.mkdirSync(path.join(root, runs), { recursive: true });
  const runDir = path.join(root, runs, stamp);
  fs.mkdirSync(runDir, { mode: 0o700 });
  const journal = {
    version: RECOVERY_VERSION,
    stamp,
    rootIdentity: entryIdentity(fs.realpathSync(root)),
    ownerPid: process.pid,
    status: RUN_STATUS.APPLYING,
    steps: [],
    nextUndo: null,
  };
  const journalPath = path.join(runDir, JOURNAL_FILE);
  saveJournal(journalPath, journal);
  return { runDir, journalPath, journal };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function readRegularJsonFile(filename, invalidMessage) {
  const fd = fs.openSync(filename, 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const linked = fs.lstatSync(filename, { bigint: true });
    if (!opened.isFile() || linked.isSymbolicLink() || opened.dev !== linked.dev || opened.ino !== linked.ino) {
      throw new Error(invalidMessage);
    }
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

export function acquireRecoveryLock(filename) {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600, flush: true });
      return () => {
        const lock = readRegularJsonFile(filename, 'Recovery lock is not a regular file');
        if (lock.token === token) fs.unlinkSync(filename);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let observed;
      try {
        observed = readRegularJsonFile(filename, 'Recovery lock is not a regular file');
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw readError;
      }
      const reclaim = `${filename}${RECOVERY_LOCK_RECLAIM_SUFFIX}`;
      try {
        fs.linkSync(filename, reclaim);
      } catch (claimError) {
        if (claimError.code === 'ENOENT') continue;
        if (claimError.code === 'EEXIST') throw new Error('Apply or recovery is busy; retry when the other process finishes');
        if (['EACCES', 'EISDIR', 'EPERM'].includes(claimError.code)) throw new Error('Recovery lock is not a regular file');
        throw claimError;
      }
      try {
        const lock = readRegularJsonFile(reclaim, 'Recovery lock is not a regular file');
        if (lock.pid !== observed.pid || lock.token !== observed.token || !Number.isInteger(lock.pid) || lock.pid <= 0 || processExists(lock.pid)) {
          throw new Error('Apply or recovery is busy; retry when the other process finishes');
        }
        fs.unlinkSync(filename);
      } finally {
        fs.unlinkSync(reclaim);
      }
    }
  }
  throw new Error('Recovery is busy');
}

function recoveryPath(root, value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) {
    throw new Error('Recovery journal contains an unsafe path');
  }
  const relative = path.relative(root, path.resolve(root, value));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Recovery journal contains an unsafe path');
  }
  const problem = directoryProblem(root, path.dirname(value));
  if (problem) throw new Error(problem);
  return path.join(root, value);
}

// Serialized into each undo script so recovery does not need an installed package
function restoreRun(scriptPath, stamp) {
  const root = path.dirname(path.dirname(path.resolve(scriptPath)));
  const relativeRun = path.join('.reorg', RUNS_DIR, stamp);
  const problem = directoryProblem(root, relativeRun);
  if (problem) throw new Error(problem);
  const journalPath = path.join(root, relativeRun, JOURNAL_FILE);
  const release = acquireRecoveryLock(path.join(root, '.reorg', RECOVERY_LOCK_FILE));
  let journal;
  try {
    journal = readRegularJsonFile(journalPath, 'Recovery journal is not a regular file');
    if (journal.version !== RECOVERY_VERSION || journal.stamp !== stamp || !Array.isArray(journal.steps)) {
      throw new Error('Recovery journal has an unsupported format');
    }
    if (journal.rootIdentity !== entryIdentity(fs.realpathSync(root))) {
      throw new Error('The source directory identity changed; preserve the recovery data for review');
    }
    if (journal.status === RUN_STATUS.APPLYING && processExists(journal.ownerPid)) {
      throw new Error('The apply process is still running; recovery must wait for it to stop');
    }
    if (journal.status === RUN_STATUS.UNDONE) {
      console.log(`Reorg run ${stamp} is already restored`);
      return;
    }
    if (journal.nextUndo === null) journal.nextUndo = journal.steps.length - 1;
    if (!Number.isInteger(journal.nextUndo) || journal.nextUndo < -1 || journal.nextUndo >= journal.steps.length) {
      throw new Error('Recovery journal has an invalid undo position');
    }
    journal.status = RUN_STATUS.UNDOING;
    saveJournal(journalPath, journal);
    let restored = 0;
    while (journal.nextUndo >= 0) {
      const step = journal.steps[journal.nextUndo];
      const original = recoveryPath(root, step.from);
      const current = recoveryPath(root, step.to);
      const originalIdentity = entryIdentity(original);
      const currentIdentity = entryIdentity(current);
      if (originalIdentity === step.identity && currentIdentity === null) {
        console.log(`  already restored or not applied: ${step.from}`);
      } else {
        if (originalIdentity !== null) throw new Error(`${step.from} is occupied; recovery stopped without overwriting it`);
        if (currentIdentity !== step.identity) throw new Error(`${step.to} is missing or its identity was replaced; recovery stopped`);
        if (step.created && fs.readdirSync(current).length) {
          throw new Error(`${step.to} contains additional entries; recovery stopped without removing it`);
        }
        fs.renameSync(current, original);
        restored++;
        console.log(`  ${step.to} -> ${step.from}`);
      }
      journal.nextUndo--;
      saveJournal(journalPath, journal);
    }
    journal.status = RUN_STATUS.UNDONE;
    delete journal.error;
    saveJournal(journalPath, journal);
    console.log(`Restored ${restored} operation(s) from Reorg run ${stamp}`);
  } catch (error) {
    if (journal?.status === RUN_STATUS.UNDOING) {
      journal.error = { code: 'recovery-conflict', message: error.message, at: new Date().toISOString() };
      try { saveJournal(journalPath, journal); } catch { /* Keep the last durable cursor */ }
    }
    throw error;
  } finally {
    release();
  }
}

export function buildUndoScript(ops, stamp, opts = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(stamp)) throw new Error('Invalid apply run identifier');
  const helpers = [directoryProblem, entryIdentity, saveJournal, processExists, readRegularJsonFile, acquireRecoveryLock, recoveryPath, restoreRun];
  return [
    '#!/bin/bash',
    '# Undo script generated by Reorg; keep its neighboring runs directory',
    ...ops.map(op => `# ${JSON.stringify(op)}`),
    'case "${1:-}" in',
    '  -h|--help) printf \'%s\\n\' "Usage: bash $0 [--help]" "Restore this run using Node.js 22 or newer and its recovery journal" "Exit: 0 restored, 1 conflict or failure, 2 usage, 3 missing Node.js"; exit 0 ;;',
    'esac',
    'if [ "$#" -ne 0 ]; then printf \'%s\\n\' "Unexpected argument; use --help" >&2; exit 2; fi',
    'if ! command -v node >/dev/null 2>&1; then printf \'%s\\n\' "Node.js is required for recovery" >&2; exit 3; fi',
    'node --input-type=module - "$0" <<\'REORG_RECOVERY\'',
    "import * as fs from 'node:fs';",
    "import * as path from 'node:path';",
    "import { randomUUID } from 'node:crypto';",
    'const { lstatSync } = fs;',
    'const { join, relative, resolve, sep } = path;',
    `const RUNS_DIR = ${JSON.stringify(RUNS_DIR)};`,
    `const RECOVERY_LOCK_FILE = ${JSON.stringify(RECOVERY_LOCK_FILE)};`,
    `const JOURNAL_FILE = ${JSON.stringify(JOURNAL_FILE)};`,
    `const RECOVERY_VERSION = ${RECOVERY_VERSION};`,
    `const RECOVERY_LOCK_RECLAIM_SUFFIX = ${JSON.stringify(RECOVERY_LOCK_RECLAIM_SUFFIX)};`,
    `const RUN_STATUS = ${JSON.stringify(RUN_STATUS)};`,
    ...helpers.map(helper => helper.toString()),
    `try { restoreRun(process.argv[2], ${JSON.stringify(stamp)}); }`,
    `catch (error) { console.error('Reorg recovery ${stamp}: ' + error.message); process.exitCode = 1; }`,
    ...(opts.gitNote ? ["console.log('Review tracked-file index changes with: git status');"] : []),
    'REORG_RECOVERY',
    '',
  ].join('\n');
}
