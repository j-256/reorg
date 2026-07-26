/* Tree rendering, drag and drop, per-row interactions. */

import { store, ROOT_ID, childrenOf, isDir, changesOf, pathOf } from './store.js';
import { el, showMenu, toast } from './dom.js';
import {
  markDirty,
  toggleCollapse,
  toggleEvict,
  addDir,
  deleteCreated,
  beginRename,
  moveNode,
  addNote,
  renderAll,
  cssEsc,
  fmtBytes,
} from '../app.js';
import { showPreview } from './side.js';

const TWIST = { closed: '\u25b8', open: '\u25be' };
// Directories get no type glyph: the trailing "/" and the twist already mark them.
const ICON = { dir: '', file: '\u00b7', link: '\u21b3' };

let dragId = null;
let biggest = 1;

export function renderTree() {
  const host = document.getElementById('tree');
  host.replaceChildren();

  biggest = 1;
  for (const n of store.nodes.values()) if (n.bytes) biggest = Math.max(biggest, n.bytes);

  const matcher = compileFilter(store.ui.filterText);
  for (const child of childrenOf(ROOT_ID)) {
    const li = renderNode(child, matcher);
    if (li) host.appendChild(li);
  }

  if (!host.childElementCount) {
    host.appendChild(el('li', 'note-empty', 'Nothing matches that filter.'));
  }
}

/* A filter is a plain substring by default, or a regex when written /like this/.
 * A folder stays visible when anything inside it matches, so filtering never
 * hides the path to a hit. */
function compileFilter(text) {
  const q = (text || '').trim();
  if (!q) return null;
  const re = /^\/(.*)\/([a-z]*)$/.exec(q);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2].includes('i') ? re[2] : re[2] + 'i');
      return (n) => rx.test(n.cur.name) || rx.test(pathOf(n.id));
    } catch {
      return () => true; // mid-typing an invalid regex should not blank the tree
    }
  }
  const lower = q.toLowerCase();
  return (n) => n.cur.name.toLowerCase().includes(lower) || pathOf(n.id).toLowerCase().includes(lower);
}

function subtreeMatches(n, matcher) {
  if (matcher(n)) return true;
  for (const c of childrenOf(n.id)) if (subtreeMatches(c, matcher)) return true;
  return false;
}

function renderNode(n, matcher) {
  if (matcher && !subtreeMatches(n, matcher)) return null;

  const li = el('li');
  li.dataset.id = n.id;

  const tpl = document.getElementById('tpl-row');
  const row = tpl.content.firstElementChild.cloneNode(true).querySelector('.row');
  row.dataset.id = n.id;
  if (n.git) row.classList.add('g-' + n.git);

  const tags = changesOf(n);
  for (const t of tags) row.classList.add('st-' + t);
  if (store.ui.filterTag && !tags.includes(store.ui.filterTag)) row.classList.add('dimmed');

  const kids = isDir(n) ? childrenOf(n.id) : [];
  const hasKids = kids.length > 0;

  const twist = row.querySelector('.twist');
  if (hasKids) {
    twist.textContent = n.collapsed ? TWIST.closed : TWIST.open;
    twist.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapse(n, e.shiftKey || e.altKey);
    });
  } else {
    twist.classList.add('leaf');
    if (n.collapsedSubtree) {
      // A summarized dir has real children on disk, just none in the model. Say so,
      // rather than showing a misleading leaf.
      twist.classList.remove('leaf');
      twist.textContent = '\u2261';
      twist.style.cursor = 'default';
      twist.title = 'not expanded: summarized during the scan (rerun with --all to descend)';
    }
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

  wireRow(row, n);
  li.appendChild(row);

  if (hasKids && !n.collapsed) {
    const ul = el('ul');
    for (const c of kids) {
      const child = renderNode(c, matcher);
      if (child) ul.appendChild(child);
    }
    li.appendChild(ul);
  }
  return li;
}

/* ---------------------------------------------------------------- interactions */
function wireRow(row, n) {
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
    for (const r of document.querySelectorAll('.row.sel')) r.classList.remove('sel');
    row.classList.add('sel');
    store.selectedId = n.id;
    if (n.kind === 'file') showPreview(n.id);
  });

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    for (const r of document.querySelectorAll('.row.sel')) r.classList.remove('sel');
    row.classList.add('sel');
    store.selectedId = n.id;

    const items = [['rename', () => beginRename(n, row.querySelector('.name'))]];
    if (n.kind === 'file') items.push(['preview first 100 lines', () => showPreview(n.id)]);
    if (isDir(n)) items.push(['new folder inside', () => addDir(n.id)]);
    items.push('-', ['add a note', () => addNote(n.id)]);
    if (n.orig && n.cur.parentId !== ROOT_ID) {
      items.push(['move to top level', () => moveNode(n.id, ROOT_ID)]);
    }
    if (n.orig && (n.cur.parentId !== n.orig.parentId || n.cur.name !== n.orig.name)) {
      items.push([
        'undo my changes to this',
        () => {
          n.cur = { ...n.orig };
          markDirty();
        },
      ]);
    }
    items.push('-');
    items.push(
      n.orig
        ? [n.evicted ? 'keep (un-trash)' : 'mark for trash', () => toggleEvict(n), n.evicted ? '' : 'danger']
        : ['remove this folder', () => deleteCreated(n), 'danger']
    );
    showMenu(e.clientX, e.clientY, items);
  });
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
  }
  renderAll();
  requestAnimationFrame(() => {
    const row = document.querySelector(`.row[data-id="${cssEsc(id)}"]`);
    if (!row) {
      toast('That entry is no longer in the tree.');
      return;
    }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1200);
    for (const r of document.querySelectorAll('.row.sel')) r.classList.remove('sel');
    row.classList.add('sel');
    store.selectedId = id;
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
