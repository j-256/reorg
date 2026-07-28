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

import { mkdirSync, renameSync, writeFileSync, chmodSync, statSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { OP, describeOp } from './plan.js';
import { ensureStateDir, stateDir, logLine, STATE_DIR } from './state.js';

const TRASH_DIR = 'trash';
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
// Where the undo script parks cycle members while it unwinds a swap. Distinct
// from the forward run's `stage/` so a re-run of either can't collide.
const STAGE_UNDO_DIR = 'unstage';
const STATE_REL = STATE_DIR;

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

  // Track paths this run will create, so a move into a just-made dir, or a move
  // whose destination is vacated by an earlier move, is not flagged.
  const willExist = new Set();
  const willVacate = new Set();

  for (const op of ops) {
    if (op.op === OP.MKDIR) {
      const abs = join(root, op.to);
      if (pathExists(abs)) {
        // Already there: harmless, mkdir -p semantics. Only a file in the way is fatal.
        try {
          if (!statSync(abs).isDirectory()) {
            problems.push(`${op.to} exists and is not a directory (cannot create it).`);
          }
        } catch {
          /* raced; treat as absent */
        }
      }
      willExist.add(op.to);
      continue;
    }
    if (op.op === OP.MOVE || op.op === OP.STAGE || op.op === OP.UNSTAGE) {
      const src = join(root, op.from);
      if (!pathExists(src) && !willExist.has(op.from)) {
        problems.push(`${op.from} no longer exists (moved or deleted since the scan).`);
      }
      // Staging destinations live under .reorg/ and are created by this run, so
      // they are never pre-existing; only real destinations can be occupied.
      if (op.op !== OP.STAGE) {
        const dst = join(root, op.to);
        if (pathExists(dst) && !willVacate.has(op.to)) {
          problems.push(`${op.to} already exists; refusing to overwrite it.`);
        }
      }
      willVacate.add(op.from);
      willExist.add(op.to);
      continue;
    }
    if (op.op === OP.TRASH) {
      const abs = join(root, op.to);
      if (!pathExists(abs) && !willExist.has(op.to)) {
        problems.push(`${op.to} no longer exists (nothing to trash).`);
      }
      willVacate.add(op.to);
    }
  }
  return problems;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the inverse of a plan as a shell script. Written before execution so an
 * interrupted run is still recoverable -- it re-checks each path, so replaying it
 * after a partial application only undoes what actually happened.
 */
export function buildUndoScript(ops, stamp, opts = {}) {
  const lines = [
    '#!/bin/bash',
    '# Undo script generated by reorg. Run from the directory that was reorganized.',
    '# Each step is guarded, so this is safe to run after a partial apply: steps',
    '# whose source is missing are skipped rather than failing the whole script.',
    `# Generated for apply run ${stamp}.`,
    '',
    'set -u',
    '',
    // The script lives at <root>/.reorg/undo-<stamp>.sh, so one level up from its
    // own directory is the reorganized root. Paths below are relative to that.
    'cd "$(dirname "$0")/.." || exit 1',
    `printf 'Undoing reorg run %s in %s\\n' ${shellQuote(stamp)} "$PWD"`,
    '',
    'moved=0; skipped=0',
    '',
    'unmove() { # unmove <current> <original>',
    // -e follows symlinks, so a broken link would read as missing here and be
    // skipped -- stranding a perfectly movable entry. Test -L as well, on both
    // sides: presence is about the path, not about what it resolves to.
    '  if [ ! -e "$1" ] && [ ! -L "$1" ]; then printf "  skip (missing): %s\\n" "$1"; skipped=$((skipped+1)); return 0; fi',
    '  if [ -e "$2" ] || [ -L "$2" ]; then printf "  skip (occupied): %s\\n" "$2"; skipped=$((skipped+1)); return 0; fi',
    '  mkdir -p "$(dirname "$2")"',
    '  mv -- "$1" "$2" && printf "  %s -> %s\\n" "$1" "$2" && moved=$((moved+1))',
    '}',
    '',
  ];

  const trashRel = `${STATE_REL}/${TRASH_DIR}/${stamp}`;
  const undoStage = (p) => `${STATE_REL}/${STAGE_UNDO_DIR}/${stamp}/${p}`;

  // A cyclic group needs staging on the way back too: undoing a swap runs into the
  // same deadlock as making it, since both destinations are occupied. Mirror the
  // forward structure -- vacate the cycle first, unwind everything else, then land.
  const staged = ops.filter((op) => op.op === OP.UNSTAGE);
  for (const op of staged) {
    lines.push(`unmove ${shellQuote(op.to)} ${shellQuote(undoStage(op.origFrom))}`);
  }

  // Reverse order: undo the last thing first, so nested paths unwind cleanly.
  for (const op of [...ops].reverse()) {
    if (op.op === OP.MOVE) {
      lines.push(`unmove ${shellQuote(op.to)} ${shellQuote(op.from)}`);
    } else if (op.op === OP.STAGE || op.op === OP.UNSTAGE) {
      continue; // the staged group is handled before and after this loop
    } else if (op.op === OP.TRASH) {
      lines.push(`unmove ${shellQuote(`${trashRel}/${op.to}`)} ${shellQuote(op.to)}`);
    } else if (op.op === OP.MKDIR) {
      // Only remove it if the reorg left it empty; never recurse.
      lines.push(`rmdir ${shellQuote(op.to)} 2>/dev/null || true`);
    }
  }

  for (const op of staged) {
    lines.push(`unmove ${shellQuote(undoStage(op.origFrom))} ${shellQuote(op.origFrom)}`);
  }

  lines.push(
    '',
    'printf "\\nRestored %d item(s), skipped %d.\\n" "$moved" "$skipped"',
    `printf 'Trash from that run (if any) is still at %s\\n' ${shellQuote(trashRel)}`,
    ''
  );
  if (opts.gitNote) {
    lines.push(
      "printf 'Note: tracked files were moved with git mv, so your index now shows the\\n'",
      "printf '      undo as further renames. Review with: git status\\n'",
      ''
    );
  }
  return lines.join('\n');
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
  const dryRun = opts.dryRun !== false;
  const log = opts.onLog || (() => {});
  const stamp = opts.stamp || String(Date.now());
  const useGit = opts.useGit ?? isGitRepo(root);

  const problems = checkDrift(root, ops);
  if (problems.length) return { applied: 0, skipped: ops.length, problems, stamp, undoScript: null };

  const undoScript = buildUndoScript(ops, stamp, { gitNote: useGit });

  if (dryRun) {
    for (const op of ops) log(`  ${describeOp(op)}`);
    return { applied: 0, skipped: 0, problems: [], stamp, undoScript, dryRun: true };
  }

  ensureStateDir(root);
  const undoPath = join(stateDir(root), `undo-${stamp}.sh`);
  writeFileSync(undoPath, undoScript);
  try {
    chmodSync(undoPath, 0o755);
  } catch {
    /* non-POSIX filesystem; the script still runs via `bash undo-*.sh` */
  }

  const trashRoot = join(stateDir(root), TRASH_DIR, stamp);
  let applied = 0;

  const mv = (fromAbs, toAbs, relFrom) => {
    mkdirSync(dirname(toAbs), { recursive: true });
    // git mv keeps rename detection clean for tracked paths. It refuses on a
    // fully-untracked directory ("source directory is empty"), so fall back to a
    // plain rename whenever git declines -- the file move is what matters.
    if (useGit && relFrom && gitTracks(root, relFrom)) {
      try {
        execFileSync('git', ['-C', root, 'mv', '--', relFrom, relative(root, toAbs)], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        return 'git mv';
      } catch {
        /* fall through to a plain rename */
      }
    }
    renameSync(fromAbs, toAbs);
    return 'mv';
  };

  for (const op of ops) {
    if (op.op === OP.MKDIR) {
      mkdirSync(join(root, op.to), { recursive: true });
      log(`  mkdir  ${op.to}/`);
      applied++;
    } else if (op.op === OP.MOVE || op.op === OP.UNSTAGE) {
      const how = mv(join(root, op.from), join(root, op.to), op.from);
      log(`  ${how === 'git mv' ? 'git mv' : 'mv    '} ${op.from}  ->  ${op.to}`);
      applied++;
    } else if (op.op === OP.STAGE) {
      // Plain rename: the staging path is inside .reorg/ and is not a git
      // destination, so `git mv` would stage a spurious deletion.
      const dest = join(root, op.to);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(join(root, op.from), dest);
      log(`  stage  ${op.from}`);
      applied++;
    } else if (op.op === OP.TRASH) {
      const dest = join(trashRoot, op.to);
      mkdirSync(dirname(dest), { recursive: true });
      // Deliberately a plain rename: `git mv` to a path inside .reorg/ would stage
      // a deletion, and trashing is meant to be reversible without touching the index.
      renameSync(join(root, op.to), dest);
      log(`  trash  ${op.to}`);
      applied++;
    }
  }

  logLine(root, {
    at: new Date().toISOString(),
    stamp,
    applied,
    ops: ops.map((o) => ({ op: o.op, from: o.from ?? null, to: o.to })),
  });

  return { applied, skipped: 0, problems: [], stamp, undoScript, undoPath, trashRoot };
}
