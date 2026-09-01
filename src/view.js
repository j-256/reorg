import { buildNodes, changesOf, childrenOf, pathOf, ROOT_ID } from './plan.js';
import {
  loadPlan,
  loadScan,
  loadView,
  savePlan,
  saveView,
  withWorkspaceLock,
} from './state.js';
import { CommandError, RevisionConflictError } from './commands.js';

export const SIDE_MODE = Object.freeze({
  NONE: 'none',
  PREVIEW: 'preview',
  REVIEW: 'review',
  NOTES: 'notes',
  TRIAGE: 'triage',
  HELP: 'help',
});

export const FILTER_TAG = Object.freeze({
  MOVED: 'moved',
  RENAMED: 'renamed',
  NEW: 'new',
  TRASHED: 'trashed',
});

export const THEME = Object.freeze({
  AUTO: 'auto',
  DARK: 'dark',
  LIGHT: 'light',
});

const SIDE_MODES = new Set(Object.values(SIDE_MODE));
const FILTER_TAGS = new Set(Object.values(FILTER_TAG));
const THEMES = new Set(Object.values(THEME));
const VIEW_PATCH_FIELDS = new Set(['ui', 'treeInitialized', 'collapsed', 'selectedId', 'side']);
const UI_FIELDS = new Set(['filterText', 'filterTag', 'git', 'heat', 'theme', 'sideW']);
const SIDE_FIELDS = new Set(['mode', 'targetId']);

function rejectUnknownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new CommandError(`Unknown ${label} field: ${JSON.stringify(unknown[0])}`);
  }
}

function parsedRegex(text) {
  const query = (text || '').trim();
  const match = /^\/(.*)\/([a-z]*)$/.exec(query);
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

function compileFilter(text, nodes) {
  const query = (text || '').trim();
  if (!query) return null;
  const parsed = parsedRegex(query);
  if (parsed) {
    if (parsed.error) return () => true;
    return (node) => parsed.regex.test(node.cur.name) || parsed.regex.test(pathOf(nodes, node.id));
  }
  const lower = query.toLowerCase();
  return (node) =>
    node.cur.name.toLowerCase().includes(lower) || pathOf(nodes, node.id).toLowerCase().includes(lower);
}

function depthOf(nodes, id) {
  let depth = 0;
  let node = nodes.get(id);
  const seen = new Set();
  while (node && node.cur.parentId !== ROOT_ID && !seen.has(node.id)) {
    seen.add(node.id);
    depth++;
    node = nodes.get(node.cur.parentId);
  }
  return depth;
}

function defaultCollapsed(nodes) {
  const collapsed = new Set();
  for (const node of nodes.values()) {
    if (node.kind === 'dir' && depthOf(nodes, node.id) >= 1) collapsed.add(node.id);
  }
  for (const node of nodes.values()) {
    if (!changesOf(node).length) continue;
    let parent = nodes.get(node.cur.parentId);
    const seen = new Set();
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      collapsed.delete(parent.id);
      parent = nodes.get(parent.cur.parentId);
    }
  }
  return collapsed;
}

function subtreeMatcher(nodes, matcher) {
  const cache = new Map();
  const matches = (node) => {
    if (!matcher) return true;
    if (cache.has(node.id)) return cache.get(node.id);
    let value = matcher(node);
    if (!value) {
      for (const child of childrenOf(nodes, node.id)) {
        if (matches(child)) {
          value = true;
          break;
        }
      }
    }
    cache.set(node.id, value);
    return value;
  };
  return matches;
}

export function materializeView(scanResult, plan, sourceView = {}) {
  const nodes = buildNodes(scanResult, plan);
  const view = {
    revision: 0,
    ui: {},
    treeInitialized: false,
    collapsed: [],
    selectedId: null,
    side: { mode: SIDE_MODE.NONE, targetId: null },
    ...sourceView,
    ui: { git: !!scanResult.git, ...(sourceView.ui || {}) },
    side: { mode: SIDE_MODE.NONE, targetId: null, ...(sourceView.side || {}) },
  };
  const collapsed = view.treeInitialized ? new Set(view.collapsed || []) : defaultCollapsed(nodes);
  const matcher = compileFilter(view.ui.filterText, nodes);
  const subtreeMatches = subtreeMatcher(nodes, matcher);
  const projected = [];

  const visit = (node, level, collapsedAncestor = null) => {
    const filterMatch = subtreeMatches(node);
    const hiddenBy = !filterMatch
      ? 'filter'
      : collapsedAncestor
        ? 'collapsed-ancestor'
        : null;
    const changes = changesOf(node);
    const dimmed = !!view.ui.filterTag && !changes.includes(view.ui.filterTag);
    const currentPath = pathOf(nodes, node.id);
    projected.push({
      id: node.id,
      kind: node.kind,
      originalPath: node.orig ? node.id : null,
      currentPath,
      name: node.cur.name,
      parentId: node.cur.parentId,
      changes,
      evicted: !!node.evicted,
      git: node.git ?? null,
      bytes: node.bytes ?? null,
      files: node.files ?? null,
      summary: plan.summaries?.[node.id] || null,
      notes: (plan.notes || []).filter((note) => note.target === node.id),
      level,
      collapsed: node.kind === 'dir' && collapsed.has(node.id),
      collapsedSubtree: !!node.collapsedSubtree,
      visible: hiddenBy === null,
      hiddenBy,
      collapsedAncestor,
      presentation: {
        selected: view.selectedId === node.id && hiddenBy === null,
        dimmed,
        dimmedBecause: dimmed ? `active change filter is ${view.ui.filterTag}` : null,
        gitLayerEnabled: !!view.ui.git,
        gitMuted: !!view.ui.git && node.git === 'ignored',
        sizesEnabled: !!view.ui.heat,
      },
    });

    const nextCollapsed = hiddenBy
      ? collapsedAncestor
      : collapsed.has(node.id)
        ? node.id
        : null;
    for (const child of childrenOf(nodes, node.id)) visit(child, level + 1, nextCollapsed);
  };

  for (const child of childrenOf(nodes, ROOT_ID)) visit(child, 1);

  const selectedId = projected.some((node) => node.id === view.selectedId && node.visible)
    ? view.selectedId
    : null;
  const side =
    view.side.mode === SIDE_MODE.PREVIEW && !nodes.has(view.side.targetId)
      ? { mode: SIDE_MODE.NONE, targetId: null }
      : view.side;

  return {
    view: {
      ...view,
      treeInitialized: true,
      collapsed: [...collapsed]
        .filter((id) => nodes.get(id)?.kind === 'dir')
        .sort(),
      selectedId,
      side,
    },
    filterError: filterError(view.ui.filterText),
    nodes: projected,
    visibleNodes: projected.filter((node) => node.visible),
  };
}

function normalizeViewPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new CommandError('A view update must be an object');
  }
  rejectUnknownFields(patch, VIEW_PATCH_FIELDS, 'view');
  if (
    patch.ui !== undefined &&
    (!patch.ui || typeof patch.ui !== 'object' || Array.isArray(patch.ui))
  ) {
    throw new CommandError('View ui must be an object');
  }
  if (
    patch.side !== undefined &&
    (!patch.side || typeof patch.side !== 'object' || Array.isArray(patch.side))
  ) {
    throw new CommandError('View side must be an object');
  }
  if (patch.ui) rejectUnknownFields(patch.ui, UI_FIELDS, 'view ui');
  if (patch.side) rejectUnknownFields(patch.side, SIDE_FIELDS, 'view side');
  const next = {
    ...current,
    ...patch,
    ui: { ...(current.ui || {}), ...(patch.ui || {}) },
    side: { ...(current.side || {}), ...(patch.side || {}) },
  };
  if (!Array.isArray(next.collapsed) || next.collapsed.some((id) => typeof id !== 'string')) {
    throw new CommandError('View collapsed ids must be strings');
  }
  if (typeof next.treeInitialized !== 'boolean') {
    throw new CommandError('View treeInitialized must be a boolean');
  }
  if (next.selectedId !== null && typeof next.selectedId !== 'string') {
    throw new CommandError('View selectedId must be a string or null');
  }
  if (!SIDE_MODES.has(next.side.mode)) {
    throw new CommandError(`Unknown side mode: ${JSON.stringify(next.side.mode)}`);
  }
  if (next.side.targetId !== null && typeof next.side.targetId !== 'string') {
    throw new CommandError('View side targetId must be a string or null');
  }
  if (next.side.mode !== SIDE_MODE.PREVIEW) next.side.targetId = null;
  if (next.ui.filterText != null && typeof next.ui.filterText !== 'string') {
    throw new CommandError('View filterText must be a string');
  }
  if (next.ui.filterTag != null && !FILTER_TAGS.has(next.ui.filterTag)) {
    throw new CommandError(`Unknown view filterTag: ${JSON.stringify(next.ui.filterTag)}`);
  }
  for (const key of ['git', 'heat']) {
    if (next.ui[key] != null && typeof next.ui[key] !== 'boolean') {
      throw new CommandError(`View ${key} must be a boolean`);
    }
  }
  if (next.ui.theme != null && !THEMES.has(next.ui.theme)) {
    throw new CommandError(`Unknown view theme: ${JSON.stringify(next.ui.theme)}`);
  }
  if (
    next.ui.sideW != null &&
    (!Number.isFinite(next.ui.sideW) || next.ui.sideW < 20 || next.ui.sideW > 80)
  ) {
    throw new CommandError('View sideW must be a number from 20 through 80');
  }
  return next;
}

export function transactView({
  root,
  dataDir = null,
  expectedRevision,
  patch,
  legacyUi = null,
  focusId = null,
}) {
  return withWorkspaceLock(root, dataDir, () => {
    const plan = loadPlan(root, dataDir);
    const inheritedUi = legacyUi ?? plan.ui;
    const current = loadView(root, dataDir, inheritedUi);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new CommandError('expectedRevision must be a non-negative integer');
    }
    if (current.revision !== expectedRevision) {
      throw new RevisionConflictError(expectedRevision, current.revision, 'View');
    }
    const frozen = loadScan(root, dataDir);
    let requestedPatch = patch;
    if (focusId !== null) {
      if (typeof focusId !== 'string' || !focusId) {
        throw new CommandError('focusId must be a non-empty string');
      }
      if (!frozen) throw new CommandError('A frozen scan is required before focusing a node');
      const nodes = buildNodes(frozen, plan);
      const target = nodes.get(focusId);
      if (!target) throw new CommandError(`No node exists with id ${JSON.stringify(focusId)}`);
      const collapsed = new Set(materializeView(frozen, plan, current).view.collapsed);
      let parent = nodes.get(target.cur.parentId);
      const seen = new Set();
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        collapsed.delete(parent.id);
        parent = nodes.get(parent.cur.parentId);
      }
      requestedPatch = {
        ...patch,
        treeInitialized: true,
        collapsed: [...collapsed],
        selectedId: focusId,
        ui: { ...(patch.ui || {}), filterText: '' },
      };
    }
    const next = normalizeViewPatch(current, requestedPatch);
    const effective = frozen ? materializeView(frozen, plan, next).view : next;
    const saved = saveView(root, { ...effective, revision: current.revision + 1 }, dataDir);
    if (Object.keys(plan.ui || {}).length) savePlan(root, { ...plan, ui: {} }, dataDir);
    return { view: saved };
  });
}

export function remapViewAfterApplyLocked({ root, dataDir = null, idMap, legacyUi = {} }) {
  const current = loadView(root, dataDir, legacyUi);
  const remap = (id) => (id == null ? null : idMap.get(id) || null);
  const sideTarget = remap(current.side.targetId);
  const next = {
    ...current,
    revision: current.revision + 1,
    collapsed: current.collapsed.map((id) => remap(id)).filter(Boolean),
    selectedId: remap(current.selectedId),
    side:
      current.side.mode === SIDE_MODE.PREVIEW && !sideTarget
        ? { mode: SIDE_MODE.NONE, targetId: null }
        : { ...current.side, targetId: sideTarget },
  };
  return saveView(root, next, dataDir);
}
