/* Tree rendering, drag and drop, per-row interactions. */

import { store, ROOT_ID, childrenOf, isDir, changesOf, pathOf } from './store.js';
import { el, showMenu, toast } from './dom.js';
import {
  markDirty,
  markViewDirty,
  toggleCollapse,
  toggleEvict,
  openCreateFolderDialog,
  deleteCreated,
  beginRename,
  moveNode,
  openMoveDialog,
  addNote,
  renderAll,
  renderDelta,
  cssEsc,
  fmtBytes,
} from '../app.js';
import { showPreview } from './side.js';
import { PLAN_COMMAND } from './plan-edit.js';

const TWIST = { closed: '\u25b8', open: '\u25be' };
// Directories get no type glyph: the trailing "/" and the twist already mark them.
const ICON = { dir: '', file: '\u00b7', link: '\u21b3' };

let dragId = null;
let biggest = 1;

export function renderTree() {
  const host = document.getElementById('tree');
  const focusedId = document.activeElement?.closest?.('[role="treeitem"]')?.dataset.id || null;
  host.replaceChildren();

  biggest = 1;
  for (const n of store.nodes.values()) if (n.bytes) biggest = Math.max(biggest, n.bytes);

  const matcher = compileFilter(store.ui.filterText);
  for (const child of childrenOf(ROOT_ID)) {
    const li = renderNode(child, matcher, 1);
    if (li) host.appendChild(li);
  }

  if (!host.childElementCount) {
    const empty = el('li', 'note-empty', 'Nothing matches that filter.');
    empty.setAttribute('role', 'treeitem');
    empty.setAttribute('aria-disabled', 'true');
    empty.tabIndex = 0;
    host.appendChild(empty);
    store.selectedId = null;
    return;
  }

  let focusable = store.selectedId
    ? host.querySelector(`[role="treeitem"][data-id="${cssEsc(store.selectedId)}"]`)
    : null;
  if (store.selectedId && !focusable) store.selectedId = null;
  if (!focusable) focusable = host.querySelector('[role="treeitem"]');
  if (focusable) focusable.tabIndex = 0;

  if (focusedId) {
    const replacement = host.querySelector(`[role="treeitem"][data-id="${cssEsc(focusedId)}"]`);
    if (replacement) requestAnimationFrame(() => replacement.focus({ preventScroll: true }));
  }
}

/* A filter is a plain substring by default, or a regex when written /like this/.
 * A folder stays visible when anything inside it matches, so filtering never
 * hides the path to a hit. */
function parsedRegex(text) {
  const q = (text || '').trim();
  const match = /^\/(.*)\/([a-z]*)$/.exec(q);
  if (!match) return null;
  try {
    const requested = match[2].replace(/[gy]/g, '');
    const flags = [...new Set((requested.includes('i') ? requested : requested + 'i').split(''))].join('');
    return { regex: new RegExp(match[1], flags), error: '' };
  } catch {
    return { regex: null, error: 'Invalid regular expression' };
  }
}

export function filterError(text) {
  const parsed = parsedRegex(text);
  return parsed ? parsed.error : '';
}

function compileFilter(text) {
  const q = (text || '').trim();
  if (!q) return null;
  const parsed = parsedRegex(q);
  if (parsed) {
    if (parsed.error) return () => true;
    return (n) => parsed.regex.test(n.cur.name) || parsed.regex.test(pathOf(n.id));
  }
  const lower = q.toLowerCase();
  return (n) => n.cur.name.toLowerCase().includes(lower) || pathOf(n.id).toLowerCase().includes(lower);
}

function subtreeMatches(n, matcher) {
  if (matcher(n)) return true;
  for (const c of childrenOf(n.id)) if (subtreeMatches(c, matcher)) return true;
  return false;
}

function accessibleNodeLabel(n) {
  const facts = [n.cur.name, n.kind === 'dir' ? 'folder' : n.kind === 'link' ? 'symbolic link' : 'file'];
  if (n.meta) facts.push(n.meta);
  if (n.collapsedSubtree) facts.push('contents not loaded');
  const changes = changesOf(n);
  if (changes.length) facts.push(changes.join(', '));
  return facts.join(', ');
}

function renderNode(n, matcher, level) {
  if (matcher && !subtreeMatches(n, matcher)) return null;

  const li = el('li');
  li.dataset.id = n.id;
  li.setAttribute('role', 'treeitem');
  li.setAttribute('aria-level', String(level));
  li.setAttribute('aria-selected', String(store.selectedId === n.id));
  li.setAttribute('aria-label', accessibleNodeLabel(n));
  li.tabIndex = -1;

  const tpl = document.getElementById('tpl-row');
  const row = tpl.content.firstElementChild.cloneNode(true).querySelector('.row');
  row.dataset.id = n.id;
  row.classList.add(`kind-${n.kind}`);
  if (n.git) row.classList.add('g-' + n.git);

  const tags = changesOf(n);
  for (const t of tags) row.classList.add('st-' + t);
  if (store.ui.filterTag && !tags.includes(store.ui.filterTag)) row.classList.add('dimmed');

  const kids = isDir(n) ? childrenOf(n.id) : [];
  const hasKids = kids.length > 0;

  const twist = row.querySelector('.twist');
  if (hasKids) {
    twist.textContent = n.collapsed ? TWIST.closed : TWIST.open;
    twist.setAttribute('aria-label', `${n.collapsed ? 'Expand' : 'Collapse'} ${n.cur.name}`);
    li.setAttribute('aria-expanded', String(!n.collapsed));
    twist.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapse(n, e.shiftKey || e.altKey);
    });
  } else {
    if (n.collapsedSubtree) {
      twist.textContent = '\u2261';
      twist.disabled = true;
      twist.setAttribute('aria-label', `Contents of ${n.cur.name} were not loaded; restart with --all to browse them`);
      twist.title = 'Contents not loaded during the scan; restart with --all to browse them';
    } else twist.hidden = true;
  }

  const icon = row.querySelector('.icon');
  icon.textContent = ICON[n.kind] ?? ICON.file;

  const name = row.querySelector('.name');
  name.classList.add(n.kind);
  name.textContent = n.cur.name;
  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    beginRename(n, name);
  });

  const meta = row.querySelector('.meta');
  const bits = [];
  if (n.meta) bits.push(n.meta);
  if (n.orig && n.cur.name !== n.orig.name && !n.evicted) bits.push(`was: ${n.orig.name}`);
  if (n.orig && n.cur.parentId !== n.orig.parentId && !n.evicted) {
    bits.push(`from: ${n.orig.parentId === ROOT_ID ? '(root)' : n.orig.parentId}`);
  }
  meta.textContent = bits.join('  ');

  const desc = row.querySelector('.desc');
  const summary = store.summaries[n.id];
  if (summary) {
    desc.textContent = summary;
    desc.title = summary;
  }

  const tagBox = row.querySelector('.tags');
  for (const t of tags) tagBox.appendChild(el('span', 'tag ' + t, t));
  if (n.collapsedSubtree) {
    const limited = el('span', 'tag limited', 'contents not loaded');
    limited.title = 'Restart with --all to browse this directory';
    tagBox.appendChild(limited);
  }
  const notes = store.notesFor(n.id);
  if (notes.length) {
    const t = el('span', 'tag note', notes.length === 1 ? 'note' : `notes ${notes.length}`);
    t.title = notes.map((x) => x.body).join('\n\n');
    tagBox.appendChild(t);
  }

  if (n.bytes) {
    const heat = el('span', 'heat');
    const bar = el('i');
    // Log scale: on a real tree a couple of giants would flatten everything else
    // to invisibility on a linear scale.
    const frac = Math.log10(1 + n.bytes) / Math.log10(1 + biggest);
    bar.style.width = Math.max(2, Math.round(frac * 100)) + '%';
    heat.appendChild(bar);
    heat.title = fmtBytes(n.bytes) + (n.files ? `, ${n.files} files` : '');
    row.appendChild(heat);
  }

  wireRow(row, li, n);
  li.appendChild(row);

  if (hasKids && !n.collapsed) {
    const ul = el('ul');
    ul.setAttribute('role', 'group');
    for (const c of kids) {
      const child = renderNode(c, matcher, level + 1);
      if (child) ul.appendChild(child);
    }
    li.appendChild(ul);
  }
  return li;
}

/* ---------------------------------------------------------------- interactions */
function wireRow(row, item, n) {
  item.addEventListener('focus', () => selectTreeNode(n.id));
  item.addEventListener('keydown', (e) => {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = row.getBoundingClientRect();
    openRowMenu(row, item, n, rect.left + 24, rect.top + rect.height);
  });

  row.addEventListener('dragstart', (e) => {
    dragId = n.id;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', pathOf(n.id));
    } catch {
      /* some browsers restrict setData; the in-page dragId is what we rely on */
    }
  });

  row.addEventListener('dragend', () => {
    dragId = null;
    row.classList.remove('dragging');
    clearDropMarks();
  });

  row.addEventListener('dragover', (e) => {
    if (dragId == null || dragId === n.id) return;
    e.preventDefault();
    const zone = dropZone(e, row, n);
    row.classList.toggle('drop-into', zone === 'into');
    row.classList.toggle('drop-before', zone === 'before');
    row.classList.toggle('drop-after', zone === 'after');
  });

  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-into', 'drop-before', 'drop-after');
  });

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragId == null || dragId === n.id) return;
    const zone = dropZone(e, row, n);
    clearDropMarks();
    // Order is derived, so "before/after" only ever means "become a sibling of
    // this row" -- there is no index to set, which is what makes an out-and-back
    // drag a true no-op.
    moveNode(dragId, zone === 'into' ? n.id : n.cur.parentId);
    dragId = null;
  });

  row.addEventListener('click', (e) => {
    if (e.target.closest('.twist')) return;
    selectTreeNode(n.id, { focus: true });
    if (n.kind === 'file') showPreview(n.id);
  });

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectTreeNode(n.id, { focus: true });
    openRowMenu(row, item, n, e.clientX, e.clientY);
  });
}

function openRowMenu(row, item, n, x, y) {
  const items = [
    ['rename', () => beginRename(n, row.querySelector('.name'))],
    ['move to another folder\u2026', () => openMoveDialog(n.id)],
  ];
  if (n.kind === 'file') items.push(['preview first 100 lines', () => showPreview(n.id)]);
  items.push([
    isDir(n) && !n.evicted ? 'new folder inside\u2026' : 'new folder alongside\u2026',
    () => openCreateFolderDialog(isDir(n) && !n.evicted ? n.id : n.cur.parentId),
  ]);
  items.push('-', ['add a note', () => addNote(n.id)]);
  if (n.orig && (n.cur.parentId !== n.orig.parentId || n.cur.name !== n.orig.name)) {
    items.push([
      'undo changes to this entry',
      () => {
        n.cur = { ...n.orig };
        n.evicted = false;
        markDirty({ type: PLAN_COMMAND.RESTORE_ENTRY, id: n.id });
      },
    ]);
  }
  items.push('-');
  items.push(
    n.orig
      ? [n.evicted ? 'keep this entry' : 'mark for trash', () => toggleEvict(n), n.evicted ? '' : 'danger']
      : ['remove this planned folder', () => deleteCreated(n), 'danger']
  );
  showMenu(x, y, items, item);
}

export function selectTreeNode(id, { focus = false } = {}) {
  const item = document.querySelector(`[role="treeitem"][data-id="${cssEsc(id)}"]`);
  if (!item) return false;
  for (const candidate of document.querySelectorAll('[role="treeitem"]')) {
    const selected = candidate === item;
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    const row = candidate.querySelector(':scope > .row');
    if (row) row.classList.toggle('sel', selected);
  }
  store.selectedId = id;
  markViewDirty();
  renderDelta();
  if (focus) item.focus({ preventScroll: true });
  item.scrollIntoView({ block: 'nearest' });
  return true;
}

function clearDropMarks() {
  for (const r of document.querySelectorAll('.drop-into, .drop-before, .drop-after')) {
    r.classList.remove('drop-into', 'drop-before', 'drop-after');
  }
}

/* Middle third of a folder row means "into"; the outer bands mean "become a
 * sibling". Files have no inside, so they are sibling-only targets. */
function dropZone(e, row, n) {
  const r = row.getBoundingClientRect();
  const y = e.clientY - r.top;
  const third = r.height / 3;
  if (isDir(n) && y > third && y < third * 2) return 'into';
  return y < r.height / 2 ? 'before' : 'after';
}

/* Expand every ancestor of a node, scroll to it, and flash it. */
export function revealNode(id) {
  let p = store.nodes.get(id);
  const chain = [];
  let guard = 0;
  while (p && p.cur.parentId !== ROOT_ID && guard++ < 128) {
    p = store.nodes.get(p.cur.parentId);
    if (p) chain.push(p);
  }
  for (const a of chain) a.collapsed = false;
  // Clear any filter that would keep the target hidden.
  const box = document.getElementById('filterBox');
  if (box.value) {
    box.value = '';
    store.ui.filterText = '';
    box.setAttribute('aria-invalid', 'false');
    document.getElementById('filterStatus').textContent = '';
  }
  markViewDirty();
  renderAll();
  requestAnimationFrame(() => {
    const row = document.querySelector(`.row[data-id="${cssEsc(id)}"]`);
    if (!row) {
      toast('That entry is no longer in the tree.');
      return;
    }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1200);
    selectTreeNode(id, { focus: true });
  });
}

/* Dropping on empty canvas below the tree moves to the top level. */
const scrollHost = document.getElementById('treeScroll');
scrollHost.addEventListener('dragover', (e) => {
  if (dragId != null) e.preventDefault();
});
scrollHost.addEventListener('drop', (e) => {
  if (dragId == null || e.target.closest('.row')) return;
  e.preventDefault();
  clearDropMarks();
  moveNode(dragId, ROOT_ID);
  dragId = null;
});
