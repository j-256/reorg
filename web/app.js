/* reorg -- browser planner.
 *
 * Mirrors src/plan.js deliberately: the same derived-order and change-detection
 * rules run here for display and on the server for execution. The server is the
 * authority (it resolves and applies), so this file never computes operations --
 * it POSTs the plan to /api/resolve and renders what comes back.
 *
 * DOM is built with createElement/textContent throughout, never innerHTML: every
 * string here is a filename or file content, i.e. untrusted input.
 */

import { api, setToken } from './lib/api.js';
import { store, ROOT_ID, childrenOf, isDir, changesOf, pathOf, isDescendant } from './lib/store.js';
import { renderTree, revealNode } from './lib/tree.js';
import {
  renderSide,
  showPreview,
  showReview,
  showNotes,
  showTriage,
  showHelp,
  closeSide,
} from './lib/side.js';
import { toast, el } from './lib/dom.js';

const $ = (s) => document.querySelector(s);

let saveTimer = null;
let saveState = 'clean';

/* ---------------------------------------------------------------- persistence */
// The plan lives on disk, so there is no export/import dance: every edit debounces
// straight to .reorg/plan.json. The indicator distinguishes "saving" from "saved"
// from "failed" -- a silent failed write would be the worst outcome here.
export function markDirty() {
  saveState = 'dirty';
  renderSaveState();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 350);
  renderAll();
}

async function save() {
  try {
    saveState = 'saving';
    renderSaveState();
    const { savedAt } = await api.put('/api/plan', { plan: store.serialize() });
    store.savedAt = savedAt;
    saveState = 'clean';
  } catch (e) {
    saveState = 'error';
    toast(`Could not save your plan: ${e.message}`, true);
  }
  renderSaveState();
}

function renderSaveState() {
  const s = $('#saveState');
  s.classList.toggle('dirty', saveState === 'dirty' || saveState === 'saving');
  s.classList.toggle('error', saveState === 'error');
  const map = {
    clean: store.savedAt ? 'saved to .reorg/plan.json' : 'no changes yet',
    dirty: 'unsaved\u2026',
    saving: 'saving\u2026',
    error: 'SAVE FAILED',
  };
  s.textContent = map[saveState];
}

/* ---------------------------------------------------------------- delta rail */
function renderDelta() {
  const bar = $('#delta');
  bar.replaceChildren();

  const counts = { moved: 0, renamed: 0, new: 0, trashed: 0 };
  let touched = 0;
  let trashBytes = 0;
  for (const n of store.nodes.values()) {
    const tags = changesOf(n);
    if (tags.length) touched++;
    for (const t of tags) if (t in counts) counts[t]++;
    if (n.evicted && n.bytes) trashBytes += n.bytes;
  }

  for (const key of ['moved', 'renamed', 'new', 'trashed']) {
    const chip = el('button', 'chip ' + key + (store.ui.filterTag === key ? ' on' : ''));
    chip.appendChild(el('b', null, String(counts[key])));
    chip.appendChild(document.createTextNode(key));
    chip.title = `show only ${key} entries`;
    chip.addEventListener('click', () => {
      store.ui.filterTag = store.ui.filterTag === key ? null : key;
      renderAll();
    });
    bar.appendChild(chip);
  }

  const summary = el('span', 'chip flat');
  if (!touched) {
    summary.textContent = 'no changes yet -- drag a row, or press ? for keys';
  } else {
    const bits = [`${touched} ${touched === 1 ? 'entry' : 'entries'} changed`];
    if (trashBytes) bits.push(`${fmtBytes(trashBytes)} to trash`);
    summary.textContent = bits.join(' \u00b7 ');
  }
  bar.appendChild(summary);

  if (touched) {
    const review = el('button', 'chip', 'review plan \u2192');
    review.addEventListener('click', () => showReview());
    bar.appendChild(review);
  }
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/* ---------------------------------------------------------------- toolbar */
function buildToolbar() {
  const tb = $('#toolbar');
  tb.replaceChildren();

  const mk = (label, title, onClick, toggleKey) => {
    const b = el('button', 'btn', label);
    b.title = title;
    if (toggleKey) b.dataset.toggle = toggleKey;
    b.addEventListener('click', () => onClick(b));
    tb.appendChild(b);
    return b;
  };
  const sep = () => tb.appendChild(el('span', 'sep'));

  mk('collapse', 'collapse every folder', () => setAllCollapsed(true));
  mk('expand', 'expand every folder', () => setAllCollapsed(false));
  sep();

  if (store.scan.git) {
    mk(
      'git',
      'tint rows by git status: tracked, ignored, untracked, nested repo',
      (b) => {
        store.ui.git = !store.ui.git;
        document.body.classList.toggle('git-on', store.ui.git);
        b.classList.toggle('on', store.ui.git);
        markDirty();
      },
      'git'
    );
  }
  mk(
    'heat',
    'show a size bar on each row, so bulk is visible at a glance',
    (b) => {
      store.ui.heat = !store.ui.heat;
      document.body.classList.toggle('heat-on', store.ui.heat);
      b.classList.toggle('on', store.ui.heat);
      renderAll();
      markDirty();
    },
    'heat'
  );
  sep();

  mk('triage', 'entries that look disposable, ranked by name and structure (not age)', () => showTriage());
  mk('notes', 'notes you have left on entries', () => showNotes());
  mk('review', 'the exact operations this plan resolves to', () => showReview());
  sep();

  mk('rescan', 'reread the directory from disk, keeping your plan', () => rescan());
  mk('revert', 'discard the whole plan and start over', () => revertAll());
  mk('?', 'keyboard shortcuts', () => showHelp());

  syncToggles();
}

function syncToggles() {
  document.body.classList.toggle('git-on', !!store.ui.git);
  document.body.classList.toggle('heat-on', !!store.ui.heat);
  for (const b of document.querySelectorAll('.btn[data-toggle]')) {
    b.classList.toggle('on', !!store.ui[b.dataset.toggle]);
  }
}

/* ---------------------------------------------------------------- actions */
export function setAllCollapsed(v) {
  for (const n of store.nodes.values()) if (isDir(n)) n.collapsed = v;
  renderAll();
}

export function toggleCollapse(n, deep) {
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
  renderAll();
}

export function toggleEvict(n) {
  n.evicted = !n.evicted;
  // Cascade: trashing a folder trashes what is inside it, which is both what
  // people expect and what keeps the plan resolvable (the server rejects a
  // trashed dir that still holds kept children).
  const walk = (node, v) => {
    for (const c of childrenOf(node.id)) {
      c.evicted = v;
      walk(c, v);
    }
  };
  walk(n, n.evicted);
  markDirty();
}

export function addDir(parentId) {
  const id = 'new:' + ++store.seq;
  store.nodes.set(id, {
    id,
    name: 'new-folder',
    kind: 'dir',
    git: null,
    meta: null,
    bytes: null,
    files: null,
    mtime: null,
    nestedRepo: false,
    collapsedSubtree: false,
    orig: null,
    cur: { name: 'new-folder', parentId },
    evicted: false,
    collapsed: false,
  });
  const parent = store.nodes.get(parentId);
  if (parent) parent.collapsed = false;
  markDirty();
  requestAnimationFrame(() => {
    const nameEl = document.querySelector(`.row[data-id="${cssEsc(id)}"] .name`);
    if (nameEl) beginRename(store.nodes.get(id), nameEl);
  });
  return id;
}

export function deleteCreated(n) {
  if (n.orig) return;
  // Reparent anything inside to where the created folder sat, so nothing is
  // orphaned by removing a container the user invented and then abandoned.
  for (const c of childrenOf(n.id)) c.cur.parentId = n.cur.parentId;
  store.nodes.delete(n.id);
  store.notes = store.notes.filter((x) => x.target !== n.id);
  markDirty();
}

export function beginRename(n, nameEl) {
  nameEl.setAttribute('contenteditable', 'plaintext-only');
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (commit) => {
    nameEl.removeAttribute('contenteditable');
    nameEl.removeEventListener('keydown', onKey);
    nameEl.removeEventListener('blur', onBlur);
    const val = nameEl.textContent.trim();
    if (commit && val && val !== n.cur.name && isValidName(val)) {
      n.cur.name = val;
      markDirty();
    } else {
      if (commit && val && !isValidName(val)) {
        toast('A name cannot contain "/" or start with a dot-dot.', true);
      }
      nameEl.textContent = n.cur.name;
      renderAll();
    }
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  nameEl.addEventListener('keydown', onKey);
  nameEl.addEventListener('blur', onBlur);
}

function isValidName(s) {
  return !s.includes('/') && s !== '.' && s !== '..' && !s.includes('\0');
}

export function moveNode(srcId, targetId) {
  const src = store.nodes.get(srcId);
  if (!src || srcId === targetId) return;
  if (isDescendant(targetId, srcId)) {
    toast('A folder cannot be moved inside itself.', true);
    return;
  }
  if (src.cur.parentId === targetId) return; // out-and-back is a no-op
  src.cur.parentId = targetId;
  const t = store.nodes.get(targetId);
  if (t) t.collapsed = false;
  markDirty();
}

export function addNote(targetId) {
  const label = targetId === ROOT_ID ? 'the whole plan' : pathOf(targetId);
  const body = window.prompt(`Note on ${label}\n\nWhy this moves, what to check, what to decide later.`, '');
  if (body === null || !body.trim()) return;
  store.notes.push({ id: 'note:' + ++store.noteSeq, target: targetId, body: body.trim() });
  markDirty();
}

export function editNote(id) {
  const note = store.notes.find((n) => n.id === id);
  if (!note) return;
  const body = window.prompt('Edit note:', note.body);
  if (body === null) return;
  if (!body.trim()) store.notes = store.notes.filter((n) => n.id !== id);
  else note.body = body.trim();
  markDirty();
}

export function deleteNote(id) {
  store.notes = store.notes.filter((n) => n.id !== id);
  markDirty();
}

async function rescan() {
  try {
    const { scan } = await api.post('/api/rescan', {});
    const before = store.countTouched();
    store.applyScan(scan, store.serialize());
    const after = store.countTouched();
    renderAll();
    const lost = before - after;
    toast(
      lost > 0
        ? `Rescanned. ${lost} planned change${lost === 1 ? '' : 's'} no longer apply (those entries are gone from disk).`
        : 'Rescanned. Your plan still fits.'
    );
  } catch (e) {
    toast(`Rescan failed: ${e.message}`, true);
  }
}

function revertAll() {
  if (!store.countTouched()) {
    toast('There is nothing to revert.');
    return;
  }
  if (!window.confirm('Discard every planned change and note? The files on disk are untouched.')) return;
  store.reset();
  markDirty();
  closeSide();
  toast('Plan cleared.');
}

/* ---------------------------------------------------------------- apply */
export async function runApply(dryRun) {
  try {
    const res = await api.post('/api/apply', { plan: store.serialize(), dryRun });
    if (res.problems && res.problems.length) {
      showReview(res.problems.map((p) => (typeof p === 'string' ? { message: p } : p)));
      toast('The tree changed since the scan, so nothing was applied. Rescan and retry.', true);
      return;
    }
    if (dryRun) {
      showReview(null, res.log);
      toast(`Dry run: ${res.log.length} operation(s). Nothing changed.`);
      return;
    }
    store.applyScan(res.scan, { ...store.serialize(), overrides: [], created: [], notes: store.notes });
    store.clearPlanEdits();
    await save();
    renderAll();
    showReview(null, res.log, {
      applied: res.applied,
      undo: res.undoPath,
      trash: res.trashRoot,
    });
    toast(`Applied ${res.applied} operation(s). Undo: bash ${res.undoPath}`);
  } catch (e) {
    toast(`Apply failed: ${e.message}`, true);
  }
}

/* ---------------------------------------------------------------- keyboard */
function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('[contenteditable="plaintext-only"]')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
      if (e.key === 'Escape') t.blur();
      return;
    }

    if (e.key === 'Escape') {
      closeSide();
      for (const r of document.querySelectorAll('.row.sel')) r.classList.remove('sel');
      store.selectedId = null;
      return;
    }
    if (e.key === '?') {
      e.preventDefault();
      showHelp();
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      $('#filterBox').focus();
      return;
    }

    const n = store.selectedId ? store.nodes.get(store.selectedId) : null;
    if (!n) return;

    if (e.key === 'F2' || e.key === 'r') {
      e.preventDefault();
      const nameEl = document.querySelector(`.row[data-id="${cssEsc(n.id)}"] .name`);
      if (nameEl) beginRename(n, nameEl);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      n.orig ? toggleEvict(n) : deleteCreated(n);
    } else if (e.key === 'n' && isDir(n)) {
      e.preventDefault();
      addDir(n.id);
    } else if (e.key === 'N') {
      e.preventDefault();
      addNote(n.id);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (n.kind === 'file') showPreview(n.id);
      else toggleCollapse(n, false);
    } else if (e.key === 'ArrowRight' && isDir(n) && n.collapsed) {
      e.preventDefault();
      toggleCollapse(n, e.altKey);
    } else if (e.key === 'ArrowLeft' && isDir(n) && !n.collapsed) {
      e.preventDefault();
      toggleCollapse(n, e.altKey);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    }
  });
}

function moveSelection(dir) {
  const rows = [...document.querySelectorAll('#tree .row:not(.filtered-out)')];
  const i = rows.findIndex((r) => r.dataset.id === store.selectedId);
  const next = rows[Math.max(0, Math.min(rows.length - 1, i + dir))];
  if (!next) return;
  for (const r of rows) r.classList.remove('sel');
  next.classList.add('sel');
  store.selectedId = next.dataset.id;
  next.scrollIntoView({ block: 'nearest' });
}

export function cssEsc(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
}

/* ---------------------------------------------------------------- filter */
function wireFilter() {
  const box = $('#filterBox');
  let t = null;
  box.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      store.ui.filterText = box.value;
      renderAll();
    }, 120);
  });
}

/* ---------------------------------------------------------------- resizer */
function wireResizer() {
  const rz = $('#resizer');
  const stage = $('#stage');
  let dragging = false;
  const setW = (pct) => {
    const w = Math.min(80, Math.max(20, pct));
    store.ui.sideW = w;
    stage.style.setProperty('--side-w', w + '%');
  };
  rz.addEventListener('mousedown', (e) => {
    if (!stage.classList.contains('split')) return;
    dragging = true;
    rz.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const r = stage.getBoundingClientRect();
    setW(((r.right - e.clientX) / r.width) * 100);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    rz.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    markDirty();
  });
  rz.addEventListener('dblclick', () => {
    setW(42);
    markDirty();
  });
  if (store.ui.sideW) stage.style.setProperty('--side-w', store.ui.sideW + '%');
}

/* ---------------------------------------------------------------- boot */
export function renderAll() {
  renderTree();
  renderDelta();
  renderSide();
  renderSaveState();
  syncToggles();
}

async function boot() {
  const params = new URLSearchParams(location.search);
  setToken(params.get('token') || '');

  let data;
  try {
    data = await api.get('/api/tree');
  } catch (e) {
    document.body.replaceChildren(
      el(
        'p',
        'problem',
        `Could not reach the reorg server: ${e.message}\n\nOpen the URL printed by the reorg command -- it carries the access token this page needs.`
      )
    );
    return;
  }

  store.init(data);
  $('#rootLabel').textContent = data.scan.root;
  document.title = `reorg \u00b7 ${data.scan.root.split('/').filter(Boolean).pop() || '/'}`;

  const c = data.scan.counts;
  $('#treeHint').textContent =
    `${c.nodes} entries \u00b7 ${c.dirs} dirs \u00b7 ${c.files} files \u00b7 ${fmtBytes(c.bytes)}` +
    (data.scan.truncated ? ' \u00b7 TRUNCATED' : '');

  buildToolbar();
  wireKeyboard();
  wireFilter();
  wireResizer();
  renderAll();

  if (data.scan.truncated) {
    toast('This tree hit the scan limit, so it is only partly shown. Restart with a bigger --max-nodes.', true);
  }
}

boot();
