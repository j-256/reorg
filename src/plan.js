// Turn a scan + a plan into an ordered, checked list of filesystem operations.
//
// This module is pure: no fs, no exec. `apply` executes what it returns and the
// tests drive it directly, so the risky step is decided by code that can be
// reasoned about in isolation.
//
// Model: every node has a stable `id` (its path at scan time). Editing never
// changes ids -- only `cur {name, parentId}`. Sibling order is derived
// (dirs first, then alphabetical), never stored, so dragging a node out of a
// folder and back is a no-op rather than a phantom change.

export const ROOT_ID = '.';

export const OP = Object.freeze({
  MKDIR: 'mkdir',
  MOVE: 'move',
  // A cyclic group (e.g. renaming a -> b while b -> a) cannot be executed with
  // direct renames in any order, so those members route through a staging dir.
  STAGE: 'stage',
  UNSTAGE: 'unstage',
  TRASH: 'trash',
});

const isUnder = (child, parent) => child.startsWith(parent + '/');
const depth = (p) => p.split('/').length;

const COLLATE = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Build the working node map: scan nodes with their live `cur` position layered on.
 * Returns Map<id, node>.
 */
export function buildNodes(scanResult, plan) {
  const nodes = new Map();
  for (const n of scanResult.nodes) {
    const orig = { name: n.name, parentId: n.parentId };
    nodes.set(n.id, {
      ...n,
      orig,
      cur: { ...orig },
      evicted: false,
    });
  }
  for (const c of plan.created || []) {
    if (nodes.has(c.id)) continue;
    nodes.set(c.id, {
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
    });
  }
  for (const o of plan.overrides || []) {
    const n = nodes.get(o.id);
    if (!n) continue; // node vanished since the plan was written; drop the override
    if (o.cur) n.cur = { ...o.cur };
    n.evicted = !!o.evicted;
  }
  return nodes;
}

export function childrenOf(nodes, parentId) {
  const kids = [];
  for (const n of nodes.values()) if (n.cur.parentId === parentId) kids.push(n);
  kids.sort(
    (a, b) => (b.kind === 'dir' ? 1 : 0) - (a.kind === 'dir' ? 1 : 0) || COLLATE(a.cur.name, b.cur.name)
  );
  return kids;
}

/** Live path of a node, following its `cur` chain up to the root. */
export function pathOf(nodes, id) {
  const parts = [];
  let n = nodes.get(id);
  const seen = new Set();
  while (n && n.id !== ROOT_ID) {
    if (seen.has(n.id)) return null; // cycle; caller reports it
    seen.add(n.id);
    parts.unshift(n.cur.name);
    if (n.cur.parentId === ROOT_ID) break;
    n = nodes.get(n.cur.parentId);
    if (!n) return null; // orphaned: parent no longer exists
  }
  return parts.join('/');
}

/** Map stable node ids to their paths after a successful apply */
export function appliedIdMap(scanResult, plan) {
  const nodes = buildNodes(scanResult, plan);
  const ids = new Map();
  for (const node of nodes.values()) {
    if (!node.evicted) ids.set(node.id, pathOf(nodes, node.id));
  }
  return ids;
}

export function changesOf(n) {
  const out = [];
  if (!n.orig) return n.evicted ? ['new', 'trashed'] : ['new'];
  if (n.evicted) out.push('trashed');
  if (n.cur.parentId !== n.orig.parentId) out.push('moved');
  if (n.cur.name !== n.orig.name) out.push('renamed');
  return out;
}

/** True when `maybeAncestor` is on the `cur` chain above `id`. */
export function isDescendant(nodes, id, maybeAncestorId) {
  let n = nodes.get(id);
  const seen = new Set();
  while (n && n.cur.parentId !== ROOT_ID) {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    if (n.cur.parentId === maybeAncestorId) return true;
    n = nodes.get(n.cur.parentId);
  }
  return false;
}

/**
 * Resolve the plan into operations, in the order they must run.
 *
 * Returns { ops, problems, stats }.
 *
 * Ordering rules that matter:
 *  - mkdir before any move that targets the new dir (shallowest first).
 *  - a node is moved only if its own path changed for a reason its ancestors
 *    don't already cover: moving `a/` to `b/a/` relocates `a/x` implicitly, so
 *    emitting a separate move for `a/x` would be wrong (its source is gone).
 *  - trash last, so a moved-then-trashed node is trashed at its new location.
 */
export function resolve(scanResult, plan) {
  const nodes = buildNodes(scanResult, plan);
  const problems = [];
  const ops = [];

  // --- integrity: cycles and orphans ------------------------------------------
  for (const n of nodes.values()) {
    const p = pathOf(nodes, n.id);
    if (p === null) {
      problems.push({
        level: 'error',
        id: n.id,
        message: `"${n.cur.name}" has no valid path (its parent chain is broken or circular).`,
      });
    }
  }
  if (problems.length) return { ops: [], problems, stats: emptyStats() };

  // --- collisions: two nodes landing on the same path -------------------------
  const byPath = new Map();
  for (const n of nodes.values()) {
    if (n.evicted) continue;
    const p = pathOf(nodes, n.id);
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push(n);
  }
  for (const [p, group] of byPath) {
    if (group.length > 1) {
      problems.push({
        level: 'error',
        id: group[0].id,
        message: `${group.length} entries would land on "${p}": ${group
          .map((g) => g.id)
          .join(', ')}. Rename or move one of them.`,
      });
    }
  }

  // --- an evicted directory cannot keep live children -------------------------
  for (const n of nodes.values()) {
    if (!n.evicted || n.kind !== 'dir') continue;
    const live = childrenOf(nodes, n.id).filter((c) => !c.evicted);
    if (live.length) {
      problems.push({
        level: 'error',
        id: n.id,
        message: `"${pathOf(nodes, n.id)}" is marked for trash but still holds ${
          live.length
        } kept item(s). Move them out or trash them too.`,
      });
    }
  }

  if (problems.some((p) => p.level === 'error')) {
    return { ops: [], problems, stats: emptyStats() };
  }

  // --- mkdir: created dirs, shallowest first ----------------------------------
  const created = [...nodes.values()].filter((n) => !n.orig && !n.evicted);
  created.sort((a, b) => pathOf(nodes, a.id).split('/').length - pathOf(nodes, b.id).split('/').length);
  for (const n of created) {
    ops.push({ op: OP.MKDIR, id: n.id, to: pathOf(nodes, n.id) });
  }

  // --- move: only nodes whose own position changed -----------------------------
  // `parentId` is an id reference, not a path, so a node whose `cur` is untouched
  // rides along with its parent automatically: moving `a` to `b/a` relocates
  // `a/x` for free. Emitting an op for `a/x` too would fail, since by then its
  // source is gone. So the criterion is simply "did this node's own cur change".
  const moves = [];
  for (const n of nodes.values()) {
    if (!n.orig) continue;
    if (n.cur.parentId === n.orig.parentId && n.cur.name === n.orig.name) continue;
    const from = n.id;
    const to = pathOf(nodes, n.id);
    if (from === to) continue;
    moves.push({ op: OP.MOVE, id: n.id, from, to, kind: n.kind, git: n.git });
  }
  ops.push(...orderMoves(moves));

  // --- trash: last, at the node's post-move location --------------------------
  const trashed = [...nodes.values()].filter((n) => n.evicted && n.orig);
  const trashSeen = new Set();
  const trashOps = [];
  for (const n of trashed) {
    // Skip children of an already-trashed ancestor: trashing the parent takes them.
    let covered = false;
    let cursor = nodes.get(n.cur.parentId);
    while (cursor && cursor.id !== ROOT_ID) {
      if (cursor.evicted) {
        covered = true;
        break;
      }
      cursor = nodes.get(cursor.cur.parentId);
    }
    if (covered) continue;
    const target = pathOf(nodes, n.id);
    if (trashSeen.has(target)) continue;
    trashSeen.add(target);
    trashOps.push({ op: OP.TRASH, id: n.id, to: target, kind: n.kind, bytes: n.bytes });
  }
  trashOps.sort((a, b) => COLLATE(a.to, b.to));
  ops.push(...trashOps);

  const stats = {
    mkdir: ops.filter((o) => o.op === OP.MKDIR).length,
    move: ops.filter((o) => o.op === OP.MOVE || o.op === OP.UNSTAGE).length,
    trash: ops.filter((o) => o.op === OP.TRASH).length,
    trashBytes: trashOps.reduce((a, o) => a + (o.bytes || 0), 0),
    touched: [...nodes.values()].filter((n) => changesOf(n).length).length,
  };

  return { ops, problems, stats };
}

function emptyStats() {
  return { mkdir: 0, move: 0, trash: 0, trashBytes: 0, touched: 0 };
}

/**
 * Order moves so each one is executable at the moment it runs, and break genuine
 * cycles with a staging hop.
 *
 * Destinations are computed from the *final* tree, which collapses what would
 * otherwise be a tangle of cases into two prerequisite rules:
 *
 *  1. Vacate before occupy. If X's destination is at or under Y's source path,
 *     Y must move away first -- otherwise X lands on something still there.
 *  2. Parent before child. If X's destination sits under Y's destination, Y must
 *     arrive first. Skipping this lets `mkdir -p` of X's parent conjure a
 *     directory at Y's destination, and Y then finds its target occupied.
 *
 * A cycle between those rules means no order works (canonical case: swapping two
 * names). Cycle members route through .reorg/stage/, which always breaks it.
 */
function orderMoves(moves) {
  if (moves.length <= 1) return moves;

  // deps.get(x) = moves that must run BEFORE x.
  const deps = new Map(moves.map((m) => [m.from, new Set()]));
  const need = (dependent, prerequisite) => {
    if (dependent === prerequisite) return;
    deps.get(dependent).add(prerequisite);
  };

  for (const x of moves) {
    for (const y of moves) {
      if (x === y) continue;
      // 1. x lands on ground y is still standing on.
      if (x.to === y.from || isUnder(x.to, y.from)) need(x.from, y.from);
      // 2. x lands inside where y is going.
      if (isUnder(x.to, y.to)) need(x.from, y.from);
    }
  }

  const byFrom = new Map(moves.map((m) => [m.from, m]));
  const state = new Map(); // 0 unvisited, 1 on stack, 2 emitted
  const out = [];
  const cyclic = new Set();

  const visit = (from, stack) => {
    const s = state.get(from) || 0;
    if (s === 2) return;
    if (s === 1) {
      // Everything from this point up the stack participates in the cycle.
      for (const m of stack.slice(stack.indexOf(from))) cyclic.add(m);
      return;
    }
    state.set(from, 1);
    stack.push(from);
    // Deterministic traversal so identical plans always yield identical scripts.
    for (const d of [...deps.get(from)].sort(COLLATE)) visit(d, stack);
    stack.pop();
    state.set(from, 2);
    out.push(byFrom.get(from));
  };

  for (const m of [...moves].sort((a, b) => depth(b.from) - depth(a.from) || COLLATE(a.from, b.from))) {
    visit(m.from, []);
  }

  if (!cyclic.size) return out;

  const staged = out.filter((m) => cyclic.has(m.from));
  const direct = out.filter((m) => !cyclic.has(m.from));
  return [
    ...staged.map((m) => ({ ...m, op: OP.STAGE, to: stagePath(m.from), finalTo: m.to })),
    ...direct,
    ...staged.map((m) => ({ ...m, op: OP.UNSTAGE, from: stagePath(m.from), to: m.to, origFrom: m.from })),
  ];
}

export const STAGE_PREFIX = '.reorg/stage';

function stagePath(from) {
  return `${STAGE_PREFIX}/${from}`;
}

/** One-line human summary of an op, used by dry-run output and the undo script. */
export function describeOp(op) {
  switch (op.op) {
    case OP.MKDIR:
      return `mkdir  ${op.to}/`;
    case OP.MOVE:
      return `mv     ${op.from}  ->  ${op.to}`;
    case OP.STAGE:
      return `stage  ${op.from}  ->  ${op.to}  (breaks a rename cycle)`;
    case OP.UNSTAGE:
      return `mv     ${op.from}  ->  ${op.to}`;
    case OP.TRASH:
      return `trash  ${op.to}`;
    default:
      return JSON.stringify(op);
  }
}
