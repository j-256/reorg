/* The client-side model.
 *
 * Mirrors src/plan.js: stable ids, a frozen `orig`, an editable `cur`, derived
 * sibling order. The server owns resolution and execution -- this exists so the
 * tree can render and the delta can be counted without a round trip per keystroke.
 */

export const ROOT_ID = '.';

const COLLATE = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export const store = {
  scan: null,
  nodes: new Map(),
  notes: [],
  summaries: {},
  ui: {},
  seq: 0,
  noteSeq: 0,
  savedAt: null,
  selectedId: null,
  allowApply: false,
  undoScripts: [],

  init(data) {
    this.allowApply = !!data.allowApply;
    this.undoScripts = data.undoScripts || [];
    this.applyScan(data.scan, data.plan || {});
    this.savedAt = (data.plan && data.plan.savedAt) || null;
  },

  applyScan(scan, plan) {
    this.scan = scan;
    this.nodes = new Map();
    for (const n of scan.nodes) {
      const orig = { name: n.name, parentId: n.parentId };
      this.nodes.set(n.id, {
        ...n,
        orig,
        cur: { ...orig },
        evicted: false,
        // Collapse below the top level by default: the first screen should be an
        // overview, not thousands of rows.
        collapsed: depthOf(scan, n.parentId) >= 1,
      });
    }
    for (const c of plan.created || []) {
      if (this.nodes.has(c.id)) continue;
      this.nodes.set(c.id, {
        id: c.id,
        name: c.cur.name,
        kind: 'dir',
        parentId: c.cur.parentId,
        git: null,
        meta: null,
        bytes: null,
        files: null,
        mtime: null,
        nestedRepo: false,
        collapsedSubtree: false,
        orig: null,
        cur: { ...c.cur },
        evicted: !!c.evicted,
        collapsed: false,
      });
    }
    for (const o of plan.overrides || []) {
      const n = this.nodes.get(o.id);
      if (!n) continue; // gone from disk since the plan was saved
      if (o.cur) n.cur = { ...o.cur };
      n.evicted = !!o.evicted;
    }
    // Reveal what the plan touches, so a reloaded page shows the work instead of
    // hiding it inside collapsed folders.
    for (const n of this.nodes.values()) {
      if (!changesOf(n).length) continue;
      let p = this.nodes.get(n.cur.parentId);
      let guard = 0;
      while (p && guard++ < 64) {
        p.collapsed = false;
        p = this.nodes.get(p.cur.parentId);
      }
    }
    this.notes = (plan.notes || []).slice();
    this.summaries = plan.summaries || {};
    // Git tinting is on by default in a repo: which entries git tracks, ignores,
    // or has never seen is usually the first question worth answering, and a layer
    // you have to discover is a layer most people never turn on.
    this.ui = { git: !!scan.git, ...(plan.ui || {}) };
    this.seq = plan.seq || highestSeq(plan.created || []);
    this.noteSeq = plan.noteSeq || highestSeq(this.notes);
  },

  serialize() {
    const overrides = [];
    const created = [];
    for (const n of this.nodes.values()) {
      if (!n.orig) {
        created.push({ id: n.id, cur: { ...n.cur }, evicted: n.evicted });
      } else if (n.cur.parentId !== n.orig.parentId || n.cur.name !== n.orig.name || n.evicted) {
        overrides.push({ id: n.id, cur: { ...n.cur }, evicted: n.evicted });
      }
    }
    return {
      version: 1,
      scannedAt: this.scan ? this.scan.generated : null,
      overrides,
      created,
      notes: this.notes,
      summaries: this.summaries,
      ui: this.ui,
      seq: this.seq,
      noteSeq: this.noteSeq,
    };
  },

  // After a successful apply the tree IS the plan, so the diff resets to empty.
  clearPlanEdits() {
    for (const n of this.nodes.values()) {
      n.cur = { ...n.orig };
      n.evicted = false;
    }
  },

  reset() {
    for (const n of [...this.nodes.values()]) {
      if (!n.orig) this.nodes.delete(n.id);
      else {
        n.cur = { ...n.orig };
        n.evicted = false;
      }
    }
    this.notes = [];
  },

  countTouched() {
    let n = 0;
    for (const node of this.nodes.values()) if (changesOf(node).length) n++;
    return n;
  },

  notesFor(id) {
    return this.notes.filter((n) => n.target === id);
  },
};

function highestSeq(list) {
  let max = 0;
  for (const item of list) {
    const m = /:(\d+)$/.exec(item.id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

function depthOf(scan, parentId) {
  if (parentId === ROOT_ID) return 0;
  const byId = depthOf._cache && depthOf._cache.scan === scan ? depthOf._cache.byId : buildIndex(scan);
  let d = 1;
  let p = byId.get(parentId);
  let guard = 0;
  while (p && p.parentId !== ROOT_ID && guard++ < 64) {
    d++;
    p = byId.get(p.parentId);
  }
  return d;
}

function buildIndex(scan) {
  const byId = new Map(scan.nodes.map((n) => [n.id, n]));
  depthOf._cache = { scan, byId };
  return byId;
}

export function isDir(n) {
  return n.kind === 'dir';
}

export function childrenOf(parentId, { includeEvicted = true } = {}) {
  const kids = [];
  for (const n of store.nodes.values()) {
    if (n.cur.parentId === parentId && (includeEvicted || !n.evicted)) kids.push(n);
  }
  kids.sort((a, b) => (isDir(b) ? 1 : 0) - (isDir(a) ? 1 : 0) || COLLATE(a.cur.name, b.cur.name));
  return kids;
}

export function changesOf(n) {
  if (!n.orig) return n.evicted ? ['new', 'trashed'] : ['new'];
  const out = [];
  if (n.evicted) out.push('trashed');
  if (n.cur.parentId !== n.orig.parentId) out.push('moved');
  if (n.cur.name !== n.orig.name) out.push('renamed');
  return out;
}

export function pathOf(id) {
  const parts = [];
  let n = store.nodes.get(id);
  let guard = 0;
  while (n && n.id !== ROOT_ID && guard++ < 128) {
    parts.unshift(n.cur.name);
    if (n.cur.parentId === ROOT_ID) break;
    n = store.nodes.get(n.cur.parentId);
  }
  return parts.join('/');
}

export function isDescendant(id, maybeAncestorId) {
  let n = store.nodes.get(id);
  let guard = 0;
  while (n && n.cur.parentId !== ROOT_ID && guard++ < 128) {
    if (n.cur.parentId === maybeAncestorId) return true;
    n = store.nodes.get(n.cur.parentId);
  }
  return false;
}
