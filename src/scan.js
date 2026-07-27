// Walk a directory into a flat node list the browser can render.
//
// Node ids are paths relative to the scan root, which makes them stable across
// rescans: a saved plan reattaches to the same nodes even after the tree drifts.
// Git status is optional -- outside a repo every node gets git:null and the UI
// simply omits the git layer.

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, statSync, readlinkSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';

export const ROOT_ID = '.';

// Never emitted at all: pure noise that would only dilute the tree.
const SKIP_NAMES = new Set(['.git', '.DS_Store', '.reorg']);

// Emitted as a single count node rather than descended into. These are units you
// move or delete wholesale, so their contents are never restructure targets.
const COLLAPSE_NAMES = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'coverage',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '.terraform',
  'Pods',
]);

// Hard ceiling so a pathological tree can't hang the scan or blow up the page.
const DEFAULT_MAX_NODES = 20000;
const DEFAULT_MAX_DEPTH = 24;

// Any directory holding more than this many files collapses to a single count
// node, whatever it is called. The name list above only catches conventions;
// real scratch directories are full of unpacked release archives and build
// artifacts with unguessable names, and a directory that big is one you decide
// about at its top level anyway -- nobody triages a release build file by file.
const DEFAULT_COLLAPSE_OVER = 400;

function gitCapture(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function isGitRepo(root) {
  try {
    return gitCapture(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

// The scan root can sit *inside* a repo without being its top level, in which
// case `git ls-files` paths are relative to the repo root, not to us. Capture the
// offset so ids and git paths can be translated in both directions.
//
// Both sides must be real paths before comparing: `--show-toplevel` resolves
// symlinks (on macOS /tmp is a link to /private/tmp), so diffing it against an
// unresolved root yields nonsense like "../../../tmp/x" and silently marks the
// entire tree untracked.
function repoPrefix(root) {
  try {
    const top = realpathSync(gitCapture(root, ['rev-parse', '--show-toplevel']).trim());
    const here = realpathSync(root);
    const rel = relative(top, here).split('\\').join('/');
    if (rel === '') return '';
    if (rel.startsWith('..')) return ''; // not actually inside; treat as top level
    return rel + '/';
  } catch {
    return '';
  }
}

function trackedSet(root, prefix) {
  const out = gitCapture(root, ['ls-files', '--full-name']);
  const set = new Set();
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (prefix && !line.startsWith(prefix)) continue;
    set.add(prefix ? line.slice(prefix.length) : line);
  }
  return set;
}

// Batch the ignore check: one `check-ignore --stdin` call for the whole tree
// beats one exec per node by orders of magnitude.
function ignoredSet(root, prefix, ids) {
  if (!ids.length) return new Set();
  const input = ids.map((id) => prefix + id).join('\n');
  let out = '';
  try {
    out = execFileSync('git', ['-C', root, 'check-ignore', '--stdin'], {
      input,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (e) {
    // check-ignore exits 1 when nothing matched; matches are still on stdout.
    out = (e.stdout || '').toString();
  }
  const set = new Set();
  for (const line of out.split('\n')) {
    if (!line) continue;
    set.add(prefix && line.startsWith(prefix) ? line.slice(prefix.length) : line);
  }
  return set;
}

// A directory's own mtime -- when its contents last changed shape, which is not
// the same as when anything inside was edited. Shown for context only; nothing is
// ranked on it (see src/signals.js for why age is a poor cleanup signal).
function dirMtime(abs) {
  try {
    return statSync(abs).mtimeMs;
  } catch {
    return null;
  }
}

function hasOwnGit(abs) {
  return existsSync(join(abs, '.git'));
}

// Aggregate size + file count for a collapsed node, so "node_modules, 41k files,
// 320 MB" reads as a single line instead of 41k rows.
function summarize(abs, budget = 200000) {
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const stack = [abs];
  while (stack.length) {
    if (files >= budget) {
      truncated = true;
      break;
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        files++;
        try {
          bytes += statSync(p).size;
        } catch {
          /* raced or unreadable; count the file, skip its size */
        }
      }
    }
  }
  return { files, bytes, truncated };
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Scan `root` into `{ root, generated, git, counts, nodes }`.
 *
 * Options:
 *   maxNodes      stop emitting past this many nodes (default 20000)
 *   maxDepth      stop descending past this depth (default 24)
 *   collapseOver  collapse any dir holding more files than this (default 400)
 *   all           descend into everything: ignores both the name list and
 *                 collapseOver (nested repos and maxDepth still collapse)
 *   hidden        include dotfiles (default true; false skips them entirely)
 */
export function scan(root, opts = {}) {
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const includeHidden = opts.hidden !== false;
  const descendAll = !!opts.all;

  const collapseOver = opts.collapseOver ?? DEFAULT_COLLAPSE_OVER;
  const useGit = opts.git !== false && isGitRepo(root);
  const prefix = useGit ? repoPrefix(root) : '';
  let tracked = new Set();
  if (useGit) {
    try {
      tracked = trackedSet(root, prefix);
    } catch {
      /* ls-files can fail on a repo with no commits; treat everything untracked */
    }
  }

  const flat = [];
  const collapsedDirs = [];
  let truncated = false;

  const relId = (abs) => {
    const r = relative(root, abs).split('\\').join('/');
    return r === '' ? ROOT_ID : r;
  };

  const walk = (abs, parentId, depth) => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries
      .filter((e) => !SKIP_NAMES.has(e.name))
      .filter((e) => includeHidden || !e.name.startsWith('.'))
      .sort((a, b) => {
        const ad = a.isDirectory();
        const bd = b.isDirectory();
        if (ad !== bd) return ad ? -1 : 1;
        return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
      });

    for (const e of entries) {
      if (flat.length >= maxNodes) {
        truncated = true;
        return;
      }
      const childAbs = join(abs, e.name);
      const id = relId(childAbs);
      const isLink = e.isSymbolicLink();
      const isDir = e.isDirectory() && !isLink;

      if (isDir) {
        const byName = !descendAll && COLLAPSE_NAMES.has(e.name);
        const nested = hasOwnGit(childAbs);
        const tooDeep = depth >= maxDepth;
        // Size the subtree before descending, so a huge directory collapses on its
        // own weight rather than flooding the tree with rows nobody will read.
        // One walk decides and labels: probing to the threshold and then walking
        // again for the tally would traverse the biggest directories twice.
        // Probe with a budget rather than a full walk: deciding "is this over 400
        // files" must not cost a traversal of a 3 GB subtree. Directories under
        // the threshold finish early and are cheap; ones over it stop at the
        // budget and get their real tally below, only if they collapse.
        const probe = descendAll ? null : summarize(childAbs, collapseOver + 1);
        const tooBig = probe && !byName && !nested && probe.files > collapseOver;

        if (byName || nested || tooDeep || tooBig) {
          // Collapsed directories get a full tally even though it costs a complete
          // traversal. Size is the whole point of collapsing something -- "3 GB" is
          // what tells you to deal with it -- and a partial count from the probe
          // budget would report megabytes for a multi-gigabyte tree, which is worse
          // than slow. Only these directories pay it; small ones stop at the probe.
          const full = probe && !probe.truncated ? probe : summarize(childAbs);
          const label = `${full.files} file${full.files === 1 ? '' : 's'}`;
          const why = nested ? 'nested repo' : tooDeep ? 'too deep' : null;
          flat.push({
            id,
            name: e.name,
            parentId,
            kind: 'dir',
            meta: [why, label, formatBytes(full.bytes)].filter(Boolean).join(', '),
            bytes: full.bytes,
            files: full.files,
            mtime: dirMtime(childAbs),
            nestedRepo: nested,
            collapsedSubtree: true,
          });
          collapsedDirs.push({ id, files: full.files, bytes: full.bytes });
          continue;
        }
        flat.push({ id, name: e.name, parentId, kind: 'dir', mtime: dirMtime(childAbs) });
        walk(childAbs, id, depth + 1);
      } else if (isLink) {
        let target = '';
        try {
          target = readlinkSync(childAbs);
        } catch {
          /* dangling or unreadable link: show it with no target */
        }
        flat.push({ id, name: e.name, parentId, kind: 'link', meta: target ? `-> ${target}` : 'broken link' });
      } else {
        let size = 0;
        let mtime = null;
        try {
          const st = statSync(childAbs);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          /* raced away between readdir and stat */
        }
        flat.push({
          id,
          name: e.name,
          parentId,
          kind: 'file',
          bytes: size,
          mtime,
          meta: formatBytes(size),
        });
      }
    }
  };

  walk(root, ROOT_ID, 0);

  // Roll directory sizes up from their children so a folder row can show its
  // own weight. Collapsed dirs already carry a summarized total.
  const byParent = new Map();
  for (const n of flat) {
    if (!byParent.has(n.parentId)) byParent.set(n.parentId, []);
    byParent.get(n.parentId).push(n);
  }
  const rollUp = (id) => {
    const kids = byParent.get(id) || [];
    let bytes = 0;
    let files = 0;
    for (const k of kids) {
      if (k.kind === 'dir' && !k.collapsedSubtree) rollUp(k.id);
      bytes += k.bytes || 0;
      files += k.kind === 'dir' ? k.files || 0 : 1;
    }
    const self = flat.find((n) => n.id === id);
    if (self && self.kind === 'dir' && !self.collapsedSubtree) {
      self.bytes = bytes;
      self.files = files;
      const size = formatBytes(bytes);
      self.meta = [`${files} file${files === 1 ? '' : 's'}`, size].filter(Boolean).join(', ');
    }
  };
  rollUp(ROOT_ID);

  if (useGit) {
    const candidates = flat
      .filter((n) => !tracked.has(n.id))
      .map((n) => (n.kind === 'dir' ? n.id + '/' : n.id));
    const ignored = ignoredSet(root, prefix, [...new Set(candidates)]);
    for (const n of flat) {
      if (n.nestedRepo) {
        n.git = 'nested';
      } else if (tracked.has(n.id)) {
        n.git = 'tracked';
      } else if (ignored.has(n.id) || ignored.has(n.id + '/')) {
        n.git = 'ignored';
      } else if (n.kind === 'dir') {
        // A dir git neither tracks nor ignores still holds tracked children in
        // the common case; only call it untracked when nothing under it is tracked.
        const p = n.id + '/';
        let anyTracked = false;
        for (const t of tracked) {
          if (t.startsWith(p)) {
            anyTracked = true;
            break;
          }
        }
        n.git = anyTracked ? 'tracked' : 'untracked';
      } else {
        n.git = 'untracked';
      }
    }
  } else {
    for (const n of flat) n.git = null;
  }

  const nodes = flat.map((n) => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    parentId: n.parentId,
    git: n.git ?? null,
    meta: n.meta || null,
    bytes: n.bytes ?? null,
    files: n.kind === 'dir' ? (n.files ?? null) : null,
    mtime: n.mtime ?? null,
    nestedRepo: !!n.nestedRepo,
    collapsedSubtree: !!n.collapsedSubtree,
  }));

  const count = (pred) => nodes.filter(pred).length;
  return {
    root,
    generated: new Date().toISOString(),
    git: useGit,
    truncated,
    // What we chose not to expand, biggest first. A bare `truncated: true` tells
    // you the view is partial but not what is missing, which is the part that
    // matters when you are deciding whether to rescan with --all.
    collapsed: collapsedDirs.sort((a, b) => b.files - a.files).slice(0, 50),
    counts: {
      nodes: nodes.length,
      dirs: count((n) => n.kind === 'dir'),
      files: count((n) => n.kind === 'file'),
      tracked: count((n) => n.git === 'tracked'),
      ignored: count((n) => n.git === 'ignored'),
      untracked: count((n) => n.git === 'untracked'),
      nested: count((n) => n.git === 'nested'),
      bytes: nodes.filter((n) => n.parentId === ROOT_ID).reduce((a, n) => a + (n.bytes || 0), 0),
    },
    nodes,
  };
}

export function readGitignore(root) {
  try {
    return gitCapture(root, ['show', 'HEAD:.gitignore']);
  } catch {
    return '';
  }
}
