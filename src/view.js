import { buildNodes, changesOf, childrenOf, pathOf, ROOT_ID } from './plan.js';
import {
  loadView,
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

const SIDE_MODES = new Set(Object.values(SIDE_MODE));

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
        selected: view.selectedId === node.id,
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

  return {
    view: {
      ...view,
      treeInitialized: true,
      collapsed: [...collapsed].sort(),
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
  const next = {
    ...current,
    ...patch,
    ui: { ...(current.ui || {}), ...(patch.ui || {}) },
    side: { ...(current.side || {}), ...(patch.side || {}) },
  };
  if (!Array.isArray(next.collapsed) || next.collapsed.some((id) => typeof id !== 'string')) {
    throw new CommandError('View collapsed ids must be strings');
  }
  if (next.selectedId !== null && typeof next.selectedId !== 'string') {
    throw new CommandError('View selectedId must be a string or null');
  }
  if (!SIDE_MODES.has(next.side.mode)) {
    throw new CommandError(`Unknown side mode: ${JSON.stringify(next.side.mode)}`);
  }
  return next;
}

export function transactView({ root, dataDir = null, expectedRevision, patch }) {
  return withWorkspaceLock(root, dataDir, () => {
    const current = loadView(root, dataDir);
    if (!Number.isInteger(expectedRevision)) {
      throw new CommandError('expectedRevision must be an integer');
    }
    if (current.revision !== expectedRevision) {
      throw new RevisionConflictError(expectedRevision, current.revision);
    }
    const next = normalizeViewPatch(current, patch);
    const saved = saveView(root, { ...next, revision: current.revision + 1 }, dataDir);
    return { view: saved };
  });
}
