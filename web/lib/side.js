/* The side pane: file preview, plan review, notes, keyboard help.
 *
 * One pane with a mode, not four panels. It is a non-modal drawer -- no veil --
 * because you want to keep dragging rows in the tree while reading a preview or
 * a problem list. */

import { store, pathOf, changesOf } from './store.js';
import { api } from './api.js';
import { el } from './dom.js';
import { editNote, deleteNote, addNote, runApply, fmtBytes } from '../app.js';
import { revealNode } from './tree.js';

const MODE = Object.freeze({
  NONE: 'none',
  PREVIEW: 'preview',
  REVIEW: 'review',
  NOTES: 'notes',
  HELP: 'help',
});

let mode = MODE.NONE;
let previewId = null;
let previewData = null;
let reviewData = null;

const $ = (s) => document.querySelector(s);

function open(newMode, title) {
  mode = newMode;
  $('#stage').classList.add('split');
  $('#sideTitle').textContent = title;
  if (!store.ui.sideW) $('#stage').style.setProperty('--side-w', '42%');
}

export function closeSide() {
  mode = MODE.NONE;
  previewId = null;
  previewData = null;
  reviewData = null;
  $('#stage').classList.remove('split');
  $('#sideBody').replaceChildren();
}

export function renderSide() {
  if (mode === MODE.NONE) return;
  const body = $('#sideBody');
  body.replaceChildren();
  if (mode === MODE.PREVIEW) renderPreview(body);
  else if (mode === MODE.REVIEW) renderReview(body);
  else if (mode === MODE.NOTES) renderNotes(body);
  else if (mode === MODE.HELP) renderHelp(body);
}

/* ---------------------------------------------------------------- preview */
export async function showPreview(id) {
  const n = store.nodes.get(id);
  if (!n) return;
  open(MODE.PREVIEW, 'preview');
  previewId = id;
  previewData = { loading: true };
  renderSide();

  // Preview reads the ORIGINAL path: the file has not moved on disk yet, only in
  // the plan. Using the planned path would 404 on every pending move.
  const readPath = n.orig ? n.id : null;
  if (!readPath) {
    previewData = { error: 'This folder only exists in your plan, so there is nothing to read yet.' };
    renderSide();
    return;
  }
  try {
    previewData = await api.get(`/api/head?path=${encodeURIComponent(readPath)}&lines=100`);
  } catch (e) {
    previewData = { error: e.message };
  }
  if (previewId === id) renderSide();
}

function renderPreview(body) {
  const n = store.nodes.get(previewId);
  if (!n) {
    body.appendChild(el('p', 'note-empty', 'That entry is gone.'));
    return;
  }

  const path = el('div', 'side-path');
  path.appendChild(el('b', null, pathOf(n.id)));
  const tags = changesOf(n);
  if (tags.length && n.orig) {
    path.appendChild(el('div', null, `originally: ${n.id}`));
  }
  const facts = [];
  if (n.bytes != null) facts.push(fmtBytes(n.bytes));
  if (n.mtime) facts.push(`modified ${new Date(n.mtime).toLocaleString()}`);
  if (n.git) facts.push(`git: ${n.git}`);
  if (facts.length) path.appendChild(el('div', null, facts.join('  \u00b7  ')));
  body.appendChild(path);

  const summary = store.summaries[n.id];
  if (summary) {
    const s = el('div', 'side-section');
    s.appendChild(el('h3', null, 'summary'));
    s.appendChild(el('div', 'note-empty', summary));
    body.appendChild(s);
  }

  const acts = el('div', 'note-card');
  const addBtn = el('button', 'btn', 'add a note');
  addBtn.addEventListener('click', () => addNote(n.id));
  const revealBtn = el('button', 'btn', 'reveal in tree');
  revealBtn.addEventListener('click', () => revealNode(n.id));
  const box = el('div', 'note-acts');
  box.append(addBtn, revealBtn);
  acts.appendChild(box);
  body.appendChild(acts);

  const sec = el('div', 'side-section');
  sec.appendChild(el('h3', null, 'first 100 lines'));
  if (previewData && previewData.loading) {
    sec.appendChild(el('p', 'note-empty', 'Reading\u2026'));
  } else if (previewData && previewData.error) {
    sec.appendChild(el('p', 'problem', previewData.error));
  } else if (previewData && previewData.binary) {
    sec.appendChild(
      el('p', 'note-empty', 'This looks like a binary file, so there is nothing readable to show.')
    );
  } else if (previewData) {
    const pre = el('pre', 'head');
    // One span per line so CSS can number them without building a table.
    for (const line of previewData.text.split('\n')) {
      pre.appendChild(el('span', 'l', line === '' ? '\u00a0' : line));
    }
    sec.appendChild(pre);
    if (previewData.truncated) {
      sec.appendChild(el('p', 'note-empty', `Showing ${previewData.shown} lines of a larger file.`));
    }
  }
  body.appendChild(sec);
}

/* ---------------------------------------------------------------- review */
export async function showReview(problems, log, applied) {
  open(MODE.REVIEW, 'review plan');
  reviewData = { loading: !problems && !log, problems, log, applied };
  renderSide();
  if (problems || log) return;

  try {
    const res = await api.post('/api/resolve', { plan: store.serialize() });
    reviewData = { ...res, applied };
  } catch (e) {
    reviewData = { error: e.message };
  }
  if (mode === MODE.REVIEW) renderSide();
}

function renderReview(body) {
  const d = reviewData || {};

  if (d.loading) {
    body.appendChild(el('p', 'note-empty', 'Working out the operations\u2026'));
    return;
  }
  if (d.error) {
    body.appendChild(el('p', 'problem', d.error));
    return;
  }

  if (d.applied) {
    const ok = el('div', 'ok-note');
    ok.appendChild(el('div', null, `Applied ${d.applied.applied} operation(s).`));
    if (d.applied.undo) ok.appendChild(el('div', null, `Undo:  bash ${d.applied.undo}`));
    if (d.applied.trash) ok.appendChild(el('div', null, `Trash: ${d.applied.trash}`));
    body.appendChild(ok);
  }

  const problems = d.problems || [];
  if (problems.length) {
    const sec = el('div', 'side-section');
    sec.appendChild(el('h3', null, `${problems.length} problem(s) to fix first`));
    for (const p of problems) {
      const card = el('div', 'problem');
      card.appendChild(el('div', null, p.message || String(p)));
      if (p.id && store.nodes.has(p.id)) {
        const b = el('button', 'btn', 'show me');
        b.addEventListener('click', () => revealNode(p.id));
        card.appendChild(b);
      }
      sec.appendChild(card);
    }
    body.appendChild(sec);
  }

  const ops = d.ops || [];
  const lines = d.script || d.log || [];
  const sec = el('div', 'side-section');
  sec.appendChild(el('h3', null, ops.length || lines.length ? 'operations, in order' : 'nothing to do'));

  if (!ops.length && !lines.length && !problems.length) {
    sec.appendChild(
      el(
        'p',
        'note-empty',
        'Your plan matches what is on disk. Drag rows, rename with F2, or mark things for trash with Delete.'
      )
    );
  }

  const list = el('div', 'op-list');
  if (ops.length) {
    for (let i = 0; i < ops.length; i++) {
      list.appendChild(el('div', 'op ' + ops[i].op, lines[i] || ops[i].op));
    }
  } else {
    for (const line of lines) list.appendChild(el('div', 'op', line.trim()));
  }
  sec.appendChild(list);

  if (d.stats) {
    const bits = [];
    if (d.stats.mkdir) bits.push(`${d.stats.mkdir} folder(s) created`);
    if (d.stats.move) bits.push(`${d.stats.move} moved`);
    if (d.stats.trash) {
      bits.push(`${d.stats.trash} to trash${d.stats.trashBytes ? ` (${fmtBytes(d.stats.trashBytes)})` : ''}`);
    }
    if (bits.length) sec.appendChild(el('p', 'note-empty', bits.join(' \u00b7 ')));
  }
  body.appendChild(sec);

  if (!ops.length || problems.length) return;

  // Action row. Dry run is always available; the real apply is gated on the flag
  // the server was started with, and we say plainly what to do when it is off.
  const actions = el('div', 'side-section');
  actions.appendChild(el('h3', null, 'apply'));
  const row = el('div', 'note-acts');

  const dry = el('button', 'btn', 'dry run');
  dry.title = 'Check every path against disk and print what would happen. Changes nothing.';
  dry.addEventListener('click', () => runApply(true));
  row.appendChild(dry);

  if (store.allowApply) {
    const go = el('button', 'btn danger', `apply ${ops.length} operation(s)`);
    go.title = 'Move files on disk. An undo script is written first.';
    go.addEventListener('click', () => {
      const t = d.stats && d.stats.trash;
      const msg = [
        `Apply ${ops.length} operation(s) to ${store.scan.root}?`,
        '',
        t ? `${t} item(s) move to .reorg/trash/ -- nothing is deleted.` : 'Nothing will be deleted.',
        'An undo script is written before any change.',
      ].join('\n');
      if (window.confirm(msg)) runApply(false);
    });
    row.appendChild(go);
  }
  actions.appendChild(row);

  if (!store.allowApply) {
    actions.appendChild(
      el(
        'p',
        'note-empty',
        'This server can only dry-run. To apply, run  reorg apply --yes  in the terminal, ' +
          'or restart with  reorg --allow-apply.'
      )
    );
  }
  if (store.undoScripts && store.undoScripts.length) {
    actions.appendChild(
      el('p', 'note-empty', `Previous runs you can still undo: ${store.undoScripts.join(', ')}`)
    );
  }
  body.appendChild(actions);
}

/* ---------------------------------------------------------------- notes */
export function showNotes() {
  open(MODE.NOTES, 'notes');
  renderSide();
}

function renderNotes(body) {
  const add = el('button', 'btn', '+ note on the whole plan');
  add.addEventListener('click', () => addNote('.'));
  body.appendChild(add);

  const sec = el('div', 'side-section');
  sec.appendChild(el('h3', null, `${store.notes.length} note(s)`));
  if (!store.notes.length) {
    sec.appendChild(
      el(
        'p',
        'note-empty',
        'No notes yet. Right-click an entry and pick "add a note" to record why it moves, ' +
          'or what you still need to decide. Notes are saved with the plan, so they survive a reload.'
      )
    );
  }
  for (const note of store.notes) {
    const card = el('div', 'note-card');
    card.appendChild(el('div', 'note-target', note.target === '.' ? '(whole plan)' : pathOf(note.target) || note.target));
    card.appendChild(el('div', 'note-body', note.body));
    const acts = el('div', 'note-acts');
    const edit = el('button', 'btn', 'edit');
    edit.addEventListener('click', () => editNote(note.id));
    const del = el('button', 'btn danger', 'delete');
    del.addEventListener('click', () => deleteNote(note.id));
    acts.append(edit, del);
    if (note.target !== '.' && store.nodes.has(note.target)) {
      const rev = el('button', 'btn', 'reveal');
      rev.addEventListener('click', () => revealNode(note.target));
      acts.appendChild(rev);
    }
    card.appendChild(acts);
    sec.appendChild(card);
  }
  body.appendChild(sec);
}

/* ---------------------------------------------------------------- help */
export function showHelp() {
  open(MODE.HELP, 'shortcuts');
  renderSide();
}

const KEYS = [
  ['drag a row', "onto a folder's middle to move into it; onto the top or bottom edge to become a sibling"],
  ['drag below the tree', 'move to the top level'],
  ['double-click / F2 / r', 'rename in place'],
  ['Delete', 'mark for trash (folders take their contents)'],
  ['n', 'new folder inside the selected folder'],
  ['N', 'add a note to the selected entry'],
  ['Space', 'preview a file, or fold a folder'],
  ['click twist', 'fold; hold Shift or Alt to fold the whole subtree'],
  ['arrow up / down', 'move the selection'],
  ['arrow left / right', 'fold or unfold'],
  ['/', 'jump to the filter box'],
  ['Esc', 'close this pane, or clear the selection'],
  ['?', 'this list'],
];

function renderHelp(body) {
  const sec = el('div', 'side-section');
  sec.appendChild(el('h3', null, 'keys'));
  const list = el('div', 'shortcuts');
  for (const [k, v] of KEYS) {
    const line = el('div');
    line.appendChild(el('kbd', null, k));
    line.appendChild(document.createTextNode('  '));
    line.appendChild(el('span', null, v));
    list.appendChild(line);
  }
  sec.appendChild(list);
  body.appendChild(sec);

  const about = el('div', 'side-section');
  about.appendChild(el('h3', null, 'how this works'));
  about.appendChild(
    el(
      'p',
      'note-empty',
      'Nothing you do here touches disk. Your plan is a diff against the scan, saved to ' +
        '.reorg/plan.json as you work, and applied only when you ask. Sibling order is derived ' +
        '(folders first, then alphabetical), so dragging something out and back is a genuine no-op ' +
        'rather than a phantom change.'
    )
  );
  about.appendChild(
    el(
      'p',
      'note-empty',
      'Applying writes an undo script first, refuses to run if the tree changed since the scan, ' +
        'and moves "trashed" items into .reorg/trash/ instead of deleting them. Inside a git repo, ' +
        'tracked files move with git mv so history follows.'
    )
  );
  body.appendChild(about);

  const filter = el('div', 'side-section');
  filter.appendChild(el('h3', null, 'filtering'));
  filter.appendChild(
    el(
      'p',
      'note-empty',
      'The filter box matches names and paths. Wrap it in slashes for a regex: /\\.log$/ finds log ' +
        'files, /^src/ finds anything under src. Folders stay visible when something inside them matches.'
    )
  );
  body.appendChild(filter);
}

/* Close button in the pane header. */
document.getElementById('sideClose').addEventListener('click', closeSide);
