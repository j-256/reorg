/* Plan mutations, with no DOM.
 *
 * These are the edits that end up in the plan the server executes, so they are
 * the part of the browser code where a bug is expensive: a wrong-but-internally-
 * valid plan passes every check in src/apply.js and gets faithfully carried out.
 * app.js owns the DOM and the feedback; this owns what the edit does to the model.
 *
 * Each function returns a result object rather than calling toast()/renderAll()
 * itself, so the outcome is assertable without a document. `ok: false` carries the
 * message for the caller to surface; `changed: false` means the edit was a no-op
 * and no save needs to fire.
 */

import { store, childrenOf, isDir, isDescendant } from './store.js';

const OK = { ok: true, changed: true };
const NOOP = { ok: true, changed: false };
const fail = (message) => ({ ok: false, changed: false, message });
const changed = (command, extra = {}) => ({ ...OK, command, ...extra });

export const PLAN_COMMAND = Object.freeze({
  MOVE: 'move',
  RENAME: 'rename',
  CREATE_FOLDER: 'create-folder',
  REMOVE_CREATED: 'remove-created',
  TRASH: 'trash',
  KEEP: 'keep',
  RESTORE_ENTRY: 'restore-entry',
  SET_NOTE: 'set-note',
  DELETE_NOTE: 'delete-note',
  RESET_PLAN: 'reset-plan',
});

/**
 * A name has to survive being joined into a path on the server, so the checks are
 * about path structure rather than taste: no separator, no traversal, no NUL.
 * Deliberately permissive otherwise -- spaces and unicode are legitimate filenames.
 */
export function isValidName(s) {
  return typeof s === 'string' && !s.includes('/') && s !== '.' && s !== '..' && !s.includes('\0');
}

/**
 * Reparent `srcId` under `targetId`.
 *
 * The cycle check is the one that matters: dropping a folder inside itself would
 * produce a plan whose parent chain never reaches the root, which the resolver
 * reports as "no valid path" -- better to refuse it at the point of the gesture.
 */
export function moveNode(srcId, targetId) {
  const src = store.nodes.get(srcId);
  if (!src || srcId === targetId) return NOOP;
  if (isDescendant(targetId, srcId)) return fail('A folder cannot be moved inside itself.');
  if (src.cur.parentId === targetId) return NOOP; // dragged out and back
  src.cur.parentId = targetId;
  const t = store.nodes.get(targetId);
  if (t) t.collapsed = false;
  return changed({ type: PLAN_COMMAND.MOVE, id: srcId, parentId: targetId });
}

/**
 * Rename in place, if the new name is different and usable.
 * Returns `{ ok: false }` with a message for an invalid name so the caller can
 * both warn and revert the field.
 */
export function renameNode(id, rawName) {
  const n = store.nodes.get(id);
  if (!n) return NOOP;
  const val = typeof rawName === 'string' ? rawName.trim() : '';
  if (!val || val === n.cur.name) return NOOP;
  if (!isValidName(val)) return fail('A name cannot contain "/" or start with a dot-dot.');
  n.cur.name = val;
  return changed({ type: PLAN_COMMAND.RENAME, id, name: val });
}

/**
 * Toggle trash on a node, cascading to everything inside it.
 *
 * The cascade is not cosmetic: the server refuses a plan that trashes a directory
 * still holding kept children, so a folder-level toggle that did not descend would
 * produce a plan that cannot be applied.
 */
export function toggleEvict(id) {
  const n = store.nodes.get(id);
  if (!n) return NOOP;
  n.evicted = !n.evicted;
  const walk = (node, v) => {
    for (const c of childrenOf(node.id)) {
      c.evicted = v;
      walk(c, v);
    }
  };
  walk(n, n.evicted);
  return changed({ type: n.evicted ? PLAN_COMMAND.TRASH : PLAN_COMMAND.KEEP, id });
}

/** Create a folder that exists only in the plan. Returns its new id. */
export function addDir(parentId, name = 'new-folder') {
  const id = `new:${crypto.randomUUID()}`;
  store.nodes.set(id, {
    id,
    name,
    kind: 'dir',
    git: null,
    meta: null,
    bytes: null,
    files: null,
    mtime: null,
    nestedRepo: false,
    collapsedSubtree: false,
    orig: null,
    cur: { name, parentId },
    evicted: false,
    collapsed: false,
  });
  const parent = store.nodes.get(parentId);
  if (parent) parent.collapsed = false;
  return changed({ type: PLAN_COMMAND.CREATE_FOLDER, id, parentId, name }, { id });
}

/**
 * Remove a planner-created folder.
 *
 * Children are reparented to where the folder sat rather than deleted: they are
 * real entries on disk that happened to be dragged into an invented container,
 * and dropping them from the plan would silently leave them where they started
 * while the user believes they were moved.
 */
export function deleteCreated(id) {
  const n = store.nodes.get(id);
  if (!n || n.orig) return NOOP; // never applies to something that exists on disk
  for (const c of childrenOf(n.id)) c.cur.parentId = n.cur.parentId;
  store.nodes.delete(n.id);
  store.notes = store.notes.filter((x) => x.target !== n.id);
  return changed({ type: PLAN_COMMAND.REMOVE_CREATED, id });
}

/* Theme is a three-state cycle rather than a boolean: "follow the OS" has to stay
   reachable, because a toggle that can only be dark or light silently stops
   tracking the system once touched. `auto` is stored as absent rather than as the
   string, so a plan written before this existed loads as auto without migration. */
export const THEMES = Object.freeze(['auto', 'dark', 'light']);

export function currentTheme() {
  return THEMES.includes(store.ui.theme) ? store.ui.theme : 'auto';
}

export function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  if (next === 'auto') delete store.ui.theme;
  else store.ui.theme = next;
  return { ...OK, theme: next };
}

export function setAllCollapsed(v) {
  for (const n of store.nodes.values()) if (isDir(n)) n.collapsed = v;
  return OK;
}

export function toggleCollapse(id, deep = false) {
  const n = store.nodes.get(id);
  if (!n) return NOOP;
  const target = !n.collapsed;
  if (deep) {
    const walk = (node) => {
      node.collapsed = target;
      for (const c of childrenOf(node.id)) if (isDir(c)) walk(c);
    };
    walk(n);
  } else {
    n.collapsed = target;
  }
  return OK;
}
