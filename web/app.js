/* reorg -- browser planner.
 *
 * Mirrors src/plan.js deliberately: the same derived-order and change-detection
 * rules run here for display and on the server for resolution. The workspace is
 * authoritative, so this file submits semantic commands and renders canonical
 * plan and view revisions
 *
 * DOM is built with createElement/textContent throughout, never innerHTML: every
 * string here is a filename or file content, i.e. untrusted input.
 */

import { api, setToken } from './lib/api.js';
import { store, ROOT_ID, childrenOf, isDir, isDescendant, changesOf, pathOf } from './lib/store.js';
import * as edit from './lib/plan-edit.js';
import { renderTree, selectTreeNode, filterError } from './lib/tree.js';
import {
  renderSide,
  showPreview,
  showReview,
  showNotes,
  showTriage,
  showHelp,
  closeSide,
  currentSideMode,
  sideViewState,
  restoreSideView,
} from './lib/side.js';
import { toast, el } from './lib/dom.js';
import { createPlanExport, PLAN_EXPORT_FILENAME } from './lib/plan-file.js';

const $ = (s) => document.querySelector(s);
const TOP_LEVEL_LABEL = '(top level)';
const TOP_LEVEL_LOCATION = 'the top level';

let saveTimer = null;
let saveState = 'clean';
let planQueue = [];
let retryBatch = null;
let saveInFlight = null;
let viewTimer = null;
let viewInFlight = null;
let viewDirty = false;
let viewSaveState = 'clean';
let canonicalReloadNeeded = false;
let pollInFlight = false;

const PLAN_SAVE_DEBOUNCE_MS = 180;
const VIEW_SAVE_DEBOUNCE_MS = 180;
const REVISION_POLL_MS = 750;
const API_ERROR_CODE = Object.freeze({
  REVISION_CONFLICT: 'revision-conflict',
  WORKSPACE_BUSY: 'workspace-busy',
});

window.addEventListener('beforeunload', (event) => {
  if (
    saveState !== 'dirty' &&
    saveState !== 'saving' &&
    saveState !== 'error' &&
    viewSaveState !== 'dirty' &&
    viewSaveState !== 'saving' &&
    viewSaveState !== 'error'
  ) return;
  event.preventDefault();
  event.returnValue = '';
});

/* ---------------------------------------------------------------- persistence */
// Plan edits debounce into semantic transactions while presentation edits use an
// independent view revision so neither browser nor agent replaces whole state files
export function markDirty(command) {
  saveState = 'dirty';
  renderSaveState();
  if (store.static) {
    renderAll();
    return;
  }
  if (!command) throw new Error('A live plan edit requires a semantic command');
  planQueue.push(command);
  markViewDirty();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushPlan(), PLAN_SAVE_DEBOUNCE_MS);
  renderAll();
}

async function reloadFromServer(message = '') {
  const data = await api.get('/api/tree');
  store.allowApply = !!data.allowApply;
  store.undoScripts = data.undoScripts || [];
  store.applyScan(data.scan, data.plan || {}, data.view || null);
  store.savedAt = data.plan?.savedAt || null;
  saveState = 'clean';
  viewSaveState = 'clean';
  renderAll();
  await restoreSideView(store.sideView);
  if (message) toast(message);
  return data;
}

export async function flushPlan() {
  clearTimeout(saveTimer);
  if (store.static || (!planQueue.length && !retryBatch && !saveInFlight)) return;
  if (saveInFlight) {
    await saveInFlight;
    if (planQueue.length || retryBatch) return flushPlan();
    return;
  }

  const batch = retryBatch || {
    commands: planQueue.splice(0),
    transactionId: crypto.randomUUID(),
  };
  retryBatch = null;
  const commands = batch.commands;
  const expectedRevision = store.planRevision;
  saveInFlight = (async () => {
    try {
      saveState = 'saving';
      renderSaveState();
      let result;
      try {
        result = await api.post('/api/transactions', {
          expectedRevision,
          transactionId: batch.transactionId,
          actor: 'browser',
          commands,
        });
      } catch (e) {
        if (e.status !== 409 || e.payload?.code !== API_ERROR_CODE.REVISION_CONFLICT) throw e;
        const revisions = await api.get('/api/revisions');
        result = await api.post('/api/transactions', {
          expectedRevision: revisions.planRevision,
          transactionId: batch.transactionId,
          actor: 'browser',
          commands,
        });
        canonicalReloadNeeded = true;
        toast('Merged this edit with a plan change made elsewhere.');
      }
      if (result.duplicate) canonicalReloadNeeded = true;
      store.planRevision = result.plan.revision;
      store.recentTransactions = result.plan.recentTransactions || [];
      store.recentTransactionDigests = { ...(result.plan.recentTransactionDigests || {}) };
      store.savedAt = result.plan.savedAt;
      saveState = planQueue.length || retryBatch ? 'dirty' : 'clean';
    } catch (e) {
      retryBatch = batch;
      if (e.status === 503 && e.payload?.code === API_ERROR_CODE.WORKSPACE_BUSY) {
        saveState = 'saving';
        await new Promise((resolve) => setTimeout(resolve, REVISION_POLL_MS));
      } else {
        saveState = 'error';
        toast(`Could not save your plan: ${e.message}`, true);
      }
    } finally {
      saveInFlight = null;
      renderSaveState();
    }
  })();
  await saveInFlight;
  if ((planQueue.length || retryBatch) && saveState !== 'error') return flushPlan();
  if (viewDirty && !viewInFlight && saveState !== 'error') {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => flushView(), VIEW_SAVE_DEBOUNCE_MS);
  }
  await reloadCanonicalIfReady();
}

export function markViewDirty() {
  viewDirty = true;
  if (store.static) {
    saveState = 'dirty';
    renderSaveState();
    return;
  }
  viewSaveState = 'dirty';
  renderSaveState();
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => flushView(), VIEW_SAVE_DEBOUNCE_MS);
}

async function flushView() {
  clearTimeout(viewTimer);
  if (store.static || (!viewDirty && !viewInFlight)) return;
  if (viewInFlight) {
    await viewInFlight;
    if (viewDirty) return flushView();
    return;
  }
  if (planQueue.length || retryBatch || saveInFlight) {
    await flushPlan();
    if (planQueue.length || retryBatch || saveInFlight) return;
  }

  viewDirty = false;
  const expectedRevision = store.viewRevision;
  const patch = store.serializeView(sideViewState());
  delete patch.version;
  delete patch.revision;
  viewInFlight = (async () => {
    try {
      viewSaveState = 'saving';
      renderSaveState();
      const result = await api.put('/api/view', { expectedRevision, patch });
      store.viewRevision = result.view.revision;
      viewSaveState = 'clean';
    } catch (e) {
      if (e.status === 409 && e.payload?.code === API_ERROR_CODE.REVISION_CONFLICT) {
        await reloadFromServer('The shared view changed elsewhere; this tab has caught up.');
        viewSaveState = 'clean';
      } else if (e.status === 503 && e.payload?.code === API_ERROR_CODE.WORKSPACE_BUSY) {
        viewDirty = true;
        viewSaveState = 'saving';
        await new Promise((resolve) => setTimeout(resolve, REVISION_POLL_MS));
      } else {
        viewDirty = true;
        viewSaveState = 'error';
        toast(`Could not save the shared view: ${e.message}`, true);
      }
    } finally {
      viewInFlight = null;
      renderSaveState();
    }
  })();
  await viewInFlight;
  if (viewDirty) return flushView();
  await reloadCanonicalIfReady();
}

async function reloadCanonicalIfReady() {
  const busy = planQueue.length || retryBatch || saveInFlight || viewDirty || viewInFlight;
  if (!canonicalReloadNeeded || busy) return;
  canonicalReloadNeeded = false;
  try {
    await reloadFromServer();
  } catch (error) {
    canonicalReloadNeeded = true;
    toast(`Could not reload the merged workspace: ${error.message}`, true);
  }
}

async function pollRevisions() {
  if (store.static || pollInFlight) return;
  pollInFlight = true;
  try {
    const revisions = await api.get('/api/revisions');
    const scanChanged = revisions.scanId !== store.scan?.id;
    const planChanged = revisions.planRevision !== store.planRevision;
    const viewChanged = revisions.viewRevision !== store.viewRevision;
    const idle = !planQueue.length && !retryBatch && !saveInFlight && !viewDirty && !viewInFlight;
    if ((scanChanged || planChanged || viewChanged) && idle) {
      await reloadFromServer();
    }
  } catch {
    // The save path carries an actionable connection error when the user edits
  } finally {
    pollInFlight = false;
  }
}

function renderSaveState() {
  const s = $('#saveState');
  if (store.static) {
    s.classList.toggle('dirty', saveState === 'dirty');
    s.classList.toggle('error', saveState === 'error');
    s.textContent =
      saveState === 'exported'
        ? 'plan exported'
        : saveState === 'dirty'
          ? 'not exported'
          : 'static snapshot';
    s.title = 'This page cannot save changes; export the plan from Review';
    return;
  }
  const state =
    saveState === 'error' || viewSaveState === 'error'
      ? 'error'
      : saveState === 'saving' || viewSaveState === 'saving'
        ? 'saving'
        : saveState === 'dirty' || viewSaveState === 'dirty'
          ? 'dirty'
          : 'clean';
  s.classList.toggle('dirty', state === 'dirty' || state === 'saving');
  s.classList.toggle('error', state === 'error');
  const map = {
    clean: `saved \u00b7 plan ${store.planRevision} \u00b7 view ${store.viewRevision}`,
    dirty: 'unsaved\u2026',
    saving: 'saving\u2026',
    error: 'SAVE FAILED',
  };
  s.textContent = map[state];
}

function exportedPlanText() {
  return JSON.stringify(
    createPlanExport(store.scan, store.serialize(), store.serializeView(sideViewState())),
    null,
    2
  ) + '\n';
}

function markExported() {
  saveState = 'exported';
  renderSaveState();
}

export function downloadPlan() {
  const blob = new Blob([exportedPlanText()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = PLAN_EXPORT_FILENAME;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  markExported();
  toast(`Downloaded ${PLAN_EXPORT_FILENAME}`);
}

export async function copyPlan() {
  const text = exportedPlanText();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) {
      toast('Could not copy the plan; download it instead', true);
      return;
    }
  }
  markExported();
  toast('Copied plan JSON');
}

/* ---------------------------------------------------------------- delta rail */
export function renderDelta() {
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

  if (store.ui.filterTag && !counts[store.ui.filterTag]) store.ui.filterTag = null;

  for (const key of ['moved', 'renamed', 'new', 'trashed']) {
    const chip = el('button', 'chip ' + key + (store.ui.filterTag === key ? ' on' : ''));
    chip.appendChild(el('b', null, String(counts[key])));
    chip.appendChild(document.createTextNode(' ' + key));
    chip.title = counts[key] ? `Show only ${key} entries` : `No ${key} entries in this plan`;
    chip.disabled = counts[key] === 0;
    chip.setAttribute('aria-pressed', String(store.ui.filterTag === key));
    chip.addEventListener('click', () => {
      store.ui.filterTag = store.ui.filterTag === key ? null : key;
      markViewDirty();
      renderAll();
    });
    bar.appendChild(chip);
  }

  const summary = el('span', 'chip flat');
  if (!touched) {
    summary.textContent = 'no planned changes';
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

  const selected = store.selectedId ? store.nodes.get(store.selectedId) : null;
  if (!selected) return;

  const actions = el('div', 'selection-actions');
  const label = el('span', 'selection-label');
  label.appendChild(document.createTextNode('Selected: '));
  const selectedPath = pathOf(selected.id);
  const strong = el('b', null, selectedPath);
  strong.title = selectedPath;
  label.appendChild(strong);
  actions.appendChild(label);

  const action = (text, title, handler, cls = '') => {
    const button = el('button', `btn${cls ? ' ' + cls : ''}`, text);
    button.title = title;
    button.addEventListener('click', handler);
    actions.appendChild(button);
  };

  action('Rename', 'Rename the selected entry', () => {
    const name = document.querySelector(`.row[data-id="${cssEsc(selected.id)}"] .name`);
    if (name) beginRename(selected, name);
  });
  action('Move\u2026', 'Choose another containing folder', () => openMoveDialog(selected.id));
  const createInside = isDir(selected) && !selected.evicted;
  action(
    createInside ? 'New folder inside\u2026' : 'New folder alongside\u2026',
    createInside ? 'Create a folder inside the selected folder' : 'Create a folder beside the selected entry',
    () => openCreateFolderDialog(preferredFolderParent(selected.id))
  );
  action('Add note', 'Attach a note to the selected entry', () => addNote(selected.id));
  if (selected.orig) {
    action(
      selected.evicted ? 'Keep' : 'Trash',
      selected.evicted ? 'Remove the trash mark' : 'Move to .reorg/trash when the plan is applied',
      () => toggleEvict(selected),
      selected.evicted ? '' : 'danger'
    );
  } else {
    action('Remove', 'Remove this planned folder', () => deleteCreated(selected), 'danger');
  }
  bar.appendChild(actions);
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

  const mk = (label, title, onClick, options = {}) => {
    const b = el('button', `btn${options.primary ? ' primary' : ''}`, label);
    b.title = title;
    if (options.toggleKey) {
      b.dataset.toggle = options.toggleKey;
      b.setAttribute('aria-pressed', 'false');
    }
    if (options.panel) {
      b.dataset.panel = options.panel;
      b.setAttribute('aria-controls', 'sidePane');
      b.setAttribute('aria-expanded', 'false');
    }
    b.addEventListener('click', () => onClick(b));
    tb.appendChild(b);
    return b;
  };
  const sep = () => tb.appendChild(el('span', 'sep'));
  const panel = (name, show) => {
    if (currentSideMode() === name) closeSide();
    else show();
  };

  mk('new folder\u2026', 'Create a planned folder at an explicit location', () => openCreateFolderDialog(), {
    primary: true,
  });
  sep();
  mk('collapse all', 'Collapse every loaded folder', () => setAllCollapsed(true));
  mk('expand all', 'Expand every loaded folder', () => setAllCollapsed(false));
  sep();

  if (store.scan.git) {
    mk(
      'git status',
      'Tint rows by git status: tracked, ignored, untracked, nested repo',
      (b) => {
        store.ui.git = !store.ui.git;
        document.body.classList.toggle('git-on', store.ui.git);
        b.classList.toggle('on', store.ui.git);
        markViewDirty();
      },
      { toggleKey: 'git' }
    );
  }
  mk(
    'sizes',
    'Show relative size bars on tree rows',
    (b) => {
      store.ui.heat = !store.ui.heat;
      document.body.classList.toggle('heat-on', store.ui.heat);
      b.classList.toggle('on', store.ui.heat);
      markViewDirty();
    },
    { toggleKey: 'heat' }
  );
  {
    const b = mk('theme: system', 'Cycle between system, dark, and light themes', () => {
      edit.cycleTheme();
      applyTheme();
      markViewDirty();
    });
    b.dataset.themeBtn = '';
  }
  sep();

  mk('cleanup', 'Review likely-disposable entries ranked by name and structure', () => panel('triage', showTriage), {
    panel: 'triage',
  });
  mk('notes', 'Review notes attached to this plan', () => panel('notes', showNotes), { panel: 'notes' });
  mk('review plan', 'Review the exact operations and run a safety check', () => panel('review', showReview), {
    panel: 'review',
  });
  sep();

  if (!store.static) {
    mk('rescan disk', 'Reread the directory from disk while preserving applicable changes', (b) => rescan(b));
  }
  mk('reset plan', 'Discard every planned change and note', () => revertAll());
  mk('help', 'Open keyboard shortcuts and planner guidance', () => panel('help', showHelp), { panel: 'help' });

  syncToggles();
}

function syncToggles() {
  document.body.classList.toggle('git-on', !!store.ui.git);
  document.body.classList.toggle('heat-on', !!store.ui.heat);
  applyTheme();
  for (const b of document.querySelectorAll('.btn[data-toggle]')) {
    const pressed = !!store.ui[b.dataset.toggle];
    b.classList.toggle('on', pressed);
    b.setAttribute('aria-pressed', String(pressed));
  }
}

// `auto` removes the attribute entirely rather than setting it to "auto", because
// the CSS distinguishes the two with :not([data-theme]) -- an attribute present
// with any value means the OS preference has been overridden.
function applyTheme() {
  const theme = edit.currentTheme();
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  const btn = document.querySelector('.btn[data-theme-btn]');
  if (btn) {
    btn.textContent = `theme: ${theme === 'auto' ? 'system' : theme}`;
    btn.title =
      theme === 'auto'
        ? 'Using the system theme; activate to switch to dark'
        : theme === 'dark'
          ? 'Using the dark theme; activate to switch to light'
          : 'Using the light theme; activate to follow the system';
    btn.classList.toggle('on', theme !== 'auto');
  }
}

/* ---------------------------------------------------------------- actions */
export function setAllCollapsed(v) {
  edit.setAllCollapsed(v);
  markViewDirty();
  renderAll();
  toast(v ? 'Collapsed all loaded folders' : 'Expanded all loaded folders');
}

export function toggleCollapse(n, deep) {
  edit.toggleCollapse(n.id, deep);
  markViewDirty();
  renderAll();
}

export function toggleEvict(n) {
  const label = pathOf(n.id);
  const res = edit.toggleEvict(n.id);
  if (!res.changed) return;
  markDirty(res.command);
  toast(
    n.evicted
      ? `Marked ${label} for trash. Files stay on disk until the plan is applied.`
      : `Restored ${label} to the plan.`
  );
}

function folderChoices(excludeId = null) {
  const choices = [{ id: ROOT_ID, label: TOP_LEVEL_LABEL }];
  for (const candidate of store.nodes.values()) {
    if (!isDir(candidate) || candidate.evicted || candidate.id === excludeId) continue;
    if (excludeId && isDescendant(candidate.id, excludeId)) continue;
    choices.push({ id: candidate.id, label: pathOf(candidate.id) });
  }
  choices.sort((a, b) => {
    if (a.id === ROOT_ID) return -1;
    if (b.id === ROOT_ID) return 1;
    return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
  });
  return choices;
}

function fillFolderSelect(select, choices, selectedId) {
  select.replaceChildren();
  for (const choice of choices) {
    const option = el('option', null, choice.label);
    option.value = choice.id;
    select.appendChild(option);
  }
  select.value = choices.some((choice) => choice.id === selectedId) ? selectedId : ROOT_ID;
}

function preferredFolderParent(id = store.selectedId) {
  const selected = id ? store.nodes.get(id) : null;
  let candidateId =
    selected && isDir(selected) && !selected.evicted
      ? selected.id
      : selected
        ? selected.cur.parentId
        : ROOT_ID;
  let guard = 0;
  while (candidateId !== ROOT_ID && guard++ < 128) {
    const candidate = store.nodes.get(candidateId);
    if (candidate && isDir(candidate) && !candidate.evicted) return candidate.id;
    candidateId = candidate ? candidate.cur.parentId : ROOT_ID;
  }
  return ROOT_ID;
}

function folderNameProblem(rawName, parentId) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) return 'Enter a folder name';
  if (!edit.isValidName(name)) return 'Use one folder name without "/" or the special names "." and ".."';
  if (childrenOf(parentId).some((candidate) => candidate.cur.name === name)) {
    return `An entry named "${name}" already exists in this folder`;
  }
  return '';
}

function showFolderNameProblem(input, output, button, parentId, showEmpty = false) {
  const problem = folderNameProblem(input.value, parentId);
  const visibleProblem = problem === 'Enter a folder name' && !showEmpty ? '' : problem;
  input.setAttribute('aria-invalid', String(!!visibleProblem));
  output.textContent = visibleProblem;
  button.disabled = !!problem;
  return problem;
}

function createPlannedFolder(parentId, rawName, { select = true } = {}) {
  const name = rawName.trim();
  const problem = folderNameProblem(name, parentId);
  if (problem) return { ok: false, problem };
  const result = edit.addDir(parentId, name);
  const { id } = result;
  if (select) store.selectedId = id;
  markDirty(result.command);
  toast(`Planned folder: ${pathOf(id)}. Nothing was created on disk.`);
  return { ok: true, id };
}

export function openCreateFolderDialog(parentId = preferredFolderParent()) {
  const dialog = $('#createFolderDialog');
  const input = $('#createFolderName');
  const select = $('#createFolderParent');
  const choices = folderChoices();
  const resolvedParent = choices.some((choice) => choice.id === parentId)
    ? parentId
    : preferredFolderParent(parentId);
  fillFolderSelect(select, choices, resolvedParent);
  input.value = '';
  showFolderNameProblem(input, $('#createFolderError'), $('#createFolderConfirm'), select.value);
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => input.focus());
}

export function deleteCreated(n) {
  const result = edit.deleteCreated(n.id);
  if (!result.changed) return;
  const label = n.cur.name;
  if (store.selectedId === n.id) store.selectedId = null;
  markDirty(result.command);
  toast(`Removed the planned folder ${label}`);
}

export function beginRename(n, nameEl) {
  nameEl.setAttribute('contenteditable', 'plaintext-only');
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let done = false;
  const finish = (commit) => {
    // Guard against re-entry. Dropping contenteditable below blurs the element,
    // which fires onBlur -> finish(true) -- so an Escape would commit the very
    // edit it was cancelling. Detaching the listeners first is not enough,
    // because blur can be dispatched synchronously from removeAttribute.
    if (done) return;
    done = true;
    nameEl.removeEventListener('keydown', onKey);
    nameEl.removeEventListener('blur', onBlur);
    nameEl.removeAttribute('contenteditable');
    const res = commit ? edit.renameNode(n.id, nameEl.textContent) : { ok: true, changed: false };
    if (res.changed) {
      markDirty(res.command);
    } else {
      if (!res.ok) toast(res.message, true);
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

export function moveNode(srcId, targetId) {
  const before = pathOf(srcId);
  const res = edit.moveNode(srcId, targetId);
  if (!res.ok) return toast(res.message, true);
  if (!res.changed) {
    toast(`${before} is already in that folder`);
    return;
  }
  markDirty(res.command);
  toast(
    targetId === ROOT_ID
      ? `Planned move: ${before} to the top level. Files on disk are unchanged.`
      : `Planned move: ${before} into ${pathOf(targetId)}. Files on disk are unchanged.`
  );
}

let moveDialogNodeId = null;

export function openMoveDialog(id) {
  const n = store.nodes.get(typeof id === 'string' ? id : id.id);
  if (!n) return;

  const dialog = $('#moveDialog');
  moveDialogNodeId = n.id;
  $('#moveName').textContent = pathOf(n.id);
  populateMoveTargets(n.cur.parentId);
  $('#moveCreateName').value = '';
  updateMoveCreateValidation();
  if (!dialog.open) dialog.showModal();
}

function populateMoveTargets(selectedId) {
  const n = store.nodes.get(moveDialogNodeId);
  if (!n) return;
  fillFolderSelect($('#moveTarget'), folderChoices(n.id), selectedId);
  updateMoveConfirmation();
}

function updateMoveConfirmation() {
  const n = store.nodes.get(moveDialogNodeId);
  if (!n) return;
  const targetId = $('#moveTarget').value;
  const button = $('#moveConfirm');
  button.disabled = targetId === n.cur.parentId;
  button.textContent =
    targetId === n.cur.parentId
      ? 'Already in this folder'
      : targetId === ROOT_ID
        ? 'Move to top level'
        : 'Move into folder';
  $('#moveCreateLocation').textContent = targetId === ROOT_ID ? TOP_LEVEL_LOCATION : pathOf(targetId);
  updateMoveCreateValidation();
}

function updateMoveCreateValidation(showEmpty = false) {
  const input = $('#moveCreateName');
  return showFolderNameProblem(
    input,
    $('#moveCreateError'),
    $('#moveCreateConfirm'),
    $('#moveTarget').value,
    showEmpty
  );
}

function createMoveDestination() {
  const input = $('#moveCreateName');
  const parentId = $('#moveTarget').value;
  const problem = updateMoveCreateValidation(true);
  if (problem) {
    input.focus();
    return;
  }
  const created = createPlannedFolder(parentId, input.value, { select: false });
  if (!created.ok) {
    $('#moveCreateError').textContent = created.problem;
    return;
  }
  input.value = '';
  populateMoveTargets(created.id);
  input.focus();
}

function wireFolderDialogs() {
  const createDialog = $('#createFolderDialog');
  const createInput = $('#createFolderName');
  const createParent = $('#createFolderParent');
  const createConfirm = $('#createFolderConfirm');
  const updateCreateValidation = (showEmpty = false) =>
    showFolderNameProblem(
      createInput,
      $('#createFolderError'),
      createConfirm,
      createParent.value,
      showEmpty
    );

  createInput.addEventListener('input', () => updateCreateValidation());
  createInput.addEventListener('blur', () => updateCreateValidation(true));
  createParent.addEventListener('change', () => updateCreateValidation());
  $('#createFolderCancel').addEventListener('click', () => createDialog.close('cancel'));
  $('#createFolderForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const problem = updateCreateValidation(true);
    if (problem) {
      createInput.focus();
      return;
    }
    const created = createPlannedFolder(createParent.value, createInput.value);
    if (!created.ok) {
      $('#createFolderError').textContent = created.problem;
      createInput.focus();
      return;
    }
    createDialog.close('created');
    requestAnimationFrame(() => selectTreeNode(created.id, { focus: true }));
  });

  const dialog = $('#moveDialog');
  const select = $('#moveTarget');
  select.addEventListener('change', updateMoveConfirmation);
  const moveCreateInput = $('#moveCreateName');
  moveCreateInput.addEventListener('input', () => updateMoveCreateValidation());
  moveCreateInput.addEventListener('blur', () => updateMoveCreateValidation(true));
  moveCreateInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    createMoveDestination();
  });
  $('#moveCreateConfirm').addEventListener('click', createMoveDestination);
  $('#moveCancel').addEventListener('click', () => dialog.close('cancel'));
  $('#moveForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const id = moveDialogNodeId;
    const targetId = select.value;
    const n = store.nodes.get(id);
    if (!n || targetId === n.cur.parentId) return;
    dialog.close('moved');
    moveNode(id, targetId);
    requestAnimationFrame(() => selectTreeNode(id, { focus: true }));
  });
  dialog.addEventListener('close', () => {
    const returnId = moveDialogNodeId;
    moveDialogNodeId = null;
    if (returnId && store.nodes.has(returnId)) {
      requestAnimationFrame(() => selectTreeNode(returnId, { focus: true }));
    }
  });
}

export function addNote(targetId) {
  const label = targetId === ROOT_ID ? 'the whole plan' : pathOf(targetId);
  const body = window.prompt(`Note on ${label}\n\nWhy this moves, what to check, what to decide later.`, '');
  if (body === null || !body.trim()) return;
  const note = { id: `note:${crypto.randomUUID()}`, target: targetId, body: body.trim() };
  store.notes.push(note);
  markDirty({ type: edit.PLAN_COMMAND.SET_NOTE, ...note });
}

export function editNote(id) {
  const note = store.notes.find((n) => n.id === id);
  if (!note) return;
  const body = window.prompt('Edit note:', note.body);
  if (body === null) return;
  if (!body.trim()) {
    store.notes = store.notes.filter((n) => n.id !== id);
    markDirty({ type: edit.PLAN_COMMAND.DELETE_NOTE, id });
  } else {
    note.body = body.trim();
    markDirty({ type: edit.PLAN_COMMAND.SET_NOTE, ...note });
  }
}

export function deleteNote(id) {
  if (!store.notes.some((note) => note.id === id)) return;
  store.notes = store.notes.filter((n) => n.id !== id);
  markDirty({ type: edit.PLAN_COMMAND.DELETE_NOTE, id });
}

async function rescan(button) {
  const originalLabel = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'rescanning\u2026';
    button.setAttribute('aria-busy', 'true');
  }
  toast('Rescanning the directory from disk\u2026');
  try {
    await flushPlan();
    await flushView();
    if (retryBatch) throw new Error('The pending plan edit must be saved before rescanning');
    const data = await api.post('/api/rescan', {});
    const before = store.countTouched();
    store.applyScan(data.scan, data.plan, data.view);
    store.savedAt = data.plan.savedAt;
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
  } finally {
    if (button && button.isConnected) {
      button.disabled = false;
      button.textContent = originalLabel;
      button.removeAttribute('aria-busy');
    }
  }
}

function revertAll() {
  if (!store.countTouched() && !store.notes.length) {
    toast('There are no planned changes or notes to reset.');
    return;
  }
  if (!window.confirm('Reset every planned change and note?\n\nFiles on disk are untouched.')) return;
  store.reset();
  store.selectedId = null;
  markDirty({ type: edit.PLAN_COMMAND.RESET_PLAN });
  closeSide();
  toast('Plan reset. Files on disk were untouched.');
}

/* ---------------------------------------------------------------- apply */
export async function runSafetyCheck() {
  try {
    await flushPlan();
    await flushView();
    if (retryBatch) throw new Error('The pending plan edit must be saved before applying');
    const res = await api.post('/api/apply', { dryRun: true });
    if (res.problems && res.problems.length) {
      showReview(res.problems.map((p) => (typeof p === 'string' ? { message: p } : p)));
      toast('The tree changed since the scan, so nothing was applied. Rescan and retry.', true);
      return;
    }
    showReview(null, res.log);
    toast(`Dry run: ${res.log.length} operation(s). Nothing changed.`);
  } catch (e) {
    if (e.payload?.problems?.length) {
      showReview(e.payload.problems.map((problem) =>
        typeof problem === 'string' ? { message: problem } : problem
      ));
      toast('The tree changed since the scan, so nothing was applied. Rescan and retry.', true);
      return;
    }
    toast(`Apply failed: ${e.message}`, true);
  }
}

export async function runApply() {
  try {
    await flushPlan();
    await flushView();
    if (retryBatch) throw new Error('The pending plan edit must be saved before applying');
    const res = await api.post('/api/apply', {
      dryRun: false,
      expectedRevision: store.planRevision,
      expectedScanId: store.scan.id,
    });
    await reloadFromServer();
    showReview(null, res.log, {
      applied: res.applied,
      undo: res.undoPath,
      trash: res.trashRoot,
    });
    toast(`Applied ${res.applied} operation(s). Undo: bash ${res.undoPath}`);
  } catch (e) {
    if (e.payload?.problems?.length) {
      showReview(e.payload.problems.map((problem) =>
        typeof problem === 'string' ? { message: problem } : problem
      ));
      toast('The tree changed since the scan, so nothing was applied. Rescan and retry.', true);
      return;
    }
    toast(`Apply failed: ${e.message}`, true);
  }
}

function activateNode(n) {
  if (n.kind === 'file') {
    showPreview(n.id);
    return;
  }
  if (childrenOf(n.id).length) {
    toggleCollapse(n, false);
    return;
  }
  toast(
    n.collapsedSubtree
      ? `${pathOf(n.id)} was summarized during the scan. Restart with --all to browse its contents.`
      : `${pathOf(n.id)} is empty.`
  );
}

/* ---------------------------------------------------------------- keyboard */
function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('[contenteditable="plaintext-only"]')) return;
    const t = e.target;
    if (document.querySelector('dialog[open]')) return;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      if (e.key === 'Escape') t.blur();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (currentSideMode() !== 'none') {
        closeSide();
        return;
      }
      for (const r of document.querySelectorAll('.row.sel')) r.classList.remove('sel');
      for (const item of document.querySelectorAll('[role="treeitem"][aria-selected="true"]')) {
        item.setAttribute('aria-selected', 'false');
      }
      store.selectedId = null;
      markViewDirty();
      renderDelta();
      return;
    }
    if (t && t.closest('button, a, [role="menuitem"]')) return;
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
    } else if (e.key === 'n') {
      e.preventDefault();
      openCreateFolderDialog(preferredFolderParent(n.id));
    } else if (e.key === 'N') {
      e.preventDefault();
      addNote(n.id);
    } else if (e.key === 'm') {
      e.preventDefault();
      openMoveDialog(n.id);
    } else if (e.key === ' ') {
      e.preventDefault();
      activateNode(n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateNode(n);
    } else if (e.key === 'ArrowRight' && isDir(n)) {
      e.preventDefault();
      const children = childrenOf(n.id);
      if (children.length && n.collapsed) {
        toggleCollapse(n, e.altKey);
      } else if (children.length) {
        const child = children.find((candidate) =>
          document.querySelector(`[role="treeitem"][data-id="${cssEsc(candidate.id)}"]`)
        );
        if (child) selectTreeNode(child.id, { focus: true });
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (isDir(n) && childrenOf(n.id).length && !n.collapsed) {
        toggleCollapse(n, e.altKey);
      } else if (n.cur.parentId !== ROOT_ID) {
        selectTreeNode(n.cur.parentId, { focus: true });
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const items = [...document.querySelectorAll('#tree [role="treeitem"]')];
      const next = e.key === 'Home' ? items[0] : items[items.length - 1];
      if (next) selectTreeNode(next.dataset.id, { focus: true });
    }
  });
}

function moveSelection(dir) {
  const items = [...document.querySelectorAll('#tree [role="treeitem"]')];
  const i = items.findIndex((item) => item.dataset.id === store.selectedId);
  const next = items[Math.max(0, Math.min(items.length - 1, i + dir))];
  if (!next) return;
  selectTreeNode(next.dataset.id, { focus: true });
}

export function cssEsc(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
}

/* ---------------------------------------------------------------- filter */
function wireFilter() {
  const box = $('#filterBox');
  const status = $('#filterStatus');
  let t = null;
  box.value = store.ui.filterText || '';

  const showValidity = () => {
    const problem = filterError(box.value);
    box.setAttribute('aria-invalid', String(!!problem));
    status.textContent = problem || '';
  };
  showValidity();

  box.addEventListener('input', () => {
    showValidity();
    clearTimeout(t);
    t = setTimeout(() => {
      store.ui.filterText = box.value;
      markViewDirty();
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
    rz.setAttribute('aria-valuenow', String(Math.round(w)));
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
    markViewDirty();
  });
  rz.addEventListener('dblclick', () => {
    setW(42);
    markViewDirty();
  });
  rz.addEventListener('keydown', (e) => {
    if (!stage.classList.contains('split')) return;
    const step = e.shiftKey ? 10 : 5;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setW((store.ui.sideW || 42) + (e.key === 'ArrowLeft' ? step : -step));
      markViewDirty();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setW(e.key === 'Home' ? 80 : 20);
      markViewDirty();
    }
  });
  if (store.ui.sideW) stage.style.setProperty('--side-w', store.ui.sideW + '%');
  rz.setAttribute('aria-valuenow', String(Math.round(store.ui.sideW || 42)));
}

/* ---------------------------------------------------------------- boot */
export function renderAll() {
  renderScopeBanner();
  renderTree();
  renderDelta();
  renderSide();
  renderSaveState();
  syncToggles();
}

function renderScopeBanner() {
  const banner = $('#scopeBanner');
  banner.replaceChildren();
  const lead = el('strong');
  let detail;
  if (store.static) {
    lead.textContent = 'Static snapshot: ';
    detail = 'changes stay in this page until you export from Review; this page cannot rescan or move files';
  } else if (store.allowApply) {
    lead.textContent = 'Plan first: ';
    detail = 'browser actions update the shared workspace; files move only after Review, Apply, and confirmation';
  } else {
    lead.textContent = 'Planning only: ';
    detail = 'browser actions update the shared workspace; files stay on disk until you run reorg apply --yes';
  }
  banner.append(lead, document.createTextNode(detail));
  banner.classList.toggle('bad', !!store.scan.truncated);
  if (store.scan.truncated) {
    banner.append(
      document.createTextNode(' '),
      el('strong', null, 'Scan incomplete: '),
      document.createTextNode('restart with a larger --max-nodes value before relying on this plan')
    );
  }
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
  wireFolderDialogs();
  renderAll();
  await restoreSideView(store.sideView);

  if (!store.static) setInterval(pollRevisions, REVISION_POLL_MS);

  if (data.scan.truncated) {
    toast('This tree hit the scan limit, so it is only partly shown. Restart with a bigger --max-nodes.', true);
  }
}

boot();
