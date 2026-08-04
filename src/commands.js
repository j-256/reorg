import { randomUUID } from 'node:crypto';
import {
  ROOT_ID,
  buildNodes,
  childrenOf,
  isDescendant,
  resolve as resolvePlan,
} from './plan.js';
import {
  loadPlan,
  logTransaction,
  savePlan,
  withWorkspaceLock,
} from './state.js';

export const COMMAND = Object.freeze({
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
  MERGE_SUMMARIES: 'merge-summaries',
});

export class CommandError extends Error {
  constructor(message, { code = 'invalid-command', details = null } = {}) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.details = details;
  }
}

export class RevisionConflictError extends CommandError {
  constructor(expected, actual) {
    super(`Plan revision changed: expected ${expected}, found ${actual}`, {
      code: 'revision-conflict',
      details: { expected, actual },
    });
    this.name = 'RevisionConflictError';
  }
}

export function isValidName(value) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !value.includes('/') &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('\0')
  );
}

function requireNode(nodes, id, label = 'node') {
  const node = nodes.get(id);
  if (!node) throw new CommandError(`No ${label} exists with id ${JSON.stringify(id)}`);
  return node;
}

function requireParent(nodes, id) {
  if (id === ROOT_ID) return null;
  const parent = requireNode(nodes, id, 'parent');
  if (parent.kind !== 'dir') throw new CommandError(`${JSON.stringify(id)} is not a folder`);
  if (parent.evicted) throw new CommandError(`${JSON.stringify(id)} is marked for trash`);
  return parent;
}

function walkDescendants(nodes, id, visit) {
  for (const child of childrenOf(nodes, id)) {
    visit(child);
    walkDescendants(nodes, child.id, visit);
  }
}

function nextId(prefix, used, start) {
  let seq = start;
  let id;
  do id = `${prefix}:${++seq}`;
  while (used.has(id));
  return { id, seq };
}

function serializeNodes(nodes, sourcePlan, state) {
  const overrides = [];
  const created = [];
  for (const node of nodes.values()) {
    if (!node.orig) {
      created.push({ id: node.id, cur: { ...node.cur }, evicted: !!node.evicted });
    } else if (
      node.cur.parentId !== node.orig.parentId ||
      node.cur.name !== node.orig.name ||
      node.evicted
    ) {
      overrides.push({ id: node.id, cur: { ...node.cur }, evicted: !!node.evicted });
    }
  }
  return {
    ...sourcePlan,
    overrides,
    created,
    notes: state.notes,
    summaries: state.summaries,
    seq: state.seq,
    noteSeq: state.noteSeq,
  };
}

function comparable(plan) {
  return JSON.stringify({
    overrides: plan.overrides || [],
    created: plan.created || [],
    notes: plan.notes || [],
    summaries: plan.summaries || {},
    seq: plan.seq || 0,
    noteSeq: plan.noteSeq || 0,
  });
}

export function applyCommands(scanResult, sourcePlan, commands) {
  if (!scanResult || !Array.isArray(scanResult.nodes)) {
    throw new CommandError('A frozen scan is required before changing the plan');
  }
  if (!Array.isArray(commands) || !commands.length) {
    throw new CommandError('A transaction requires at least one command');
  }

  const nodes = buildNodes(scanResult, sourcePlan);
  const state = {
    notes: (sourcePlan.notes || []).map((note) => ({ ...note })),
    summaries: { ...(sourcePlan.summaries || {}) },
    seq: Number.isInteger(sourcePlan.seq) ? sourcePlan.seq : 0,
    noteSeq: Number.isInteger(sourcePlan.noteSeq) ? sourcePlan.noteSeq : 0,
  };
  const results = [];

  for (const command of commands) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new CommandError('Every command must be an object');
    }

    if (command.type === COMMAND.MOVE) {
      const node = requireNode(nodes, command.id);
      requireParent(nodes, command.parentId);
      if (node.id === command.parentId || isDescendant(nodes, command.parentId, node.id)) {
        throw new CommandError('A folder cannot be moved inside itself');
      }
      const changed = node.cur.parentId !== command.parentId;
      node.cur.parentId = command.parentId;
      results.push({ type: command.type, id: node.id, changed });
      continue;
    }

    if (command.type === COMMAND.RENAME) {
      const node = requireNode(nodes, command.id);
      const name = typeof command.name === 'string' ? command.name.trim() : '';
      if (!isValidName(name)) {
        throw new CommandError('A name cannot be empty, contain "/", equal "." or "..", or contain NUL');
      }
      const changed = node.cur.name !== name;
      node.cur.name = name;
      results.push({ type: command.type, id: node.id, changed });
      continue;
    }

    if (command.type === COMMAND.CREATE_FOLDER) {
      requireParent(nodes, command.parentId);
      const name = typeof command.name === 'string' ? command.name.trim() : '';
      if (!isValidName(name)) {
        throw new CommandError('A folder name cannot be empty, contain "/", equal "." or "..", or contain NUL');
      }
      let id = command.id;
      if (id == null) {
        const next = nextId('new', nodes, state.seq);
        id = next.id;
        state.seq = next.seq;
      } else if (typeof id !== 'string' || !id.startsWith('new:')) {
        throw new CommandError('A caller-supplied folder id must start with "new:"');
      }
      if (nodes.has(id)) throw new CommandError(`A node already exists with id ${JSON.stringify(id)}`);
      const suffix = /:(\d+)$/.exec(id);
      if (suffix) state.seq = Math.max(state.seq, Number.parseInt(suffix[1], 10));
      nodes.set(id, {
        id,
        name,
        kind: 'dir',
        parentId: command.parentId,
        git: null,
        meta: null,
        bytes: null,
        files: null,
        mtime: null,
        nestedRepo: false,
        collapsedSubtree: false,
        orig: null,
        cur: { name, parentId: command.parentId },
        evicted: false,
      });
      results.push({ type: command.type, id, changed: true });
      continue;
    }

    if (command.type === COMMAND.REMOVE_CREATED) {
      const node = requireNode(nodes, command.id);
      if (node.orig) throw new CommandError('Only a folder created in the plan can be removed');
      for (const child of childrenOf(nodes, node.id)) child.cur.parentId = node.cur.parentId;
      nodes.delete(node.id);
      state.notes = state.notes.filter((note) => note.target !== node.id);
      results.push({ type: command.type, id: node.id, changed: true });
      continue;
    }

    if (command.type === COMMAND.TRASH || command.type === COMMAND.KEEP) {
      const node = requireNode(nodes, command.id);
      const value = command.type === COMMAND.TRASH;
      let changed = node.evicted !== value;
      node.evicted = value;
      walkDescendants(nodes, node.id, (child) => {
        if (child.evicted !== value) changed = true;
        child.evicted = value;
      });
      results.push({ type: command.type, id: node.id, changed });
      continue;
    }

    if (command.type === COMMAND.RESTORE_ENTRY) {
      const node = requireNode(nodes, command.id);
      if (!node.orig) throw new CommandError('A created folder must be removed rather than restored');
      const changed =
        node.cur.name !== node.orig.name ||
        node.cur.parentId !== node.orig.parentId ||
        node.evicted;
      node.cur = { ...node.orig };
      node.evicted = false;
      results.push({ type: command.type, id: node.id, changed });
      continue;
    }

    if (command.type === COMMAND.SET_NOTE) {
      if (command.target !== ROOT_ID) requireNode(nodes, command.target, 'note target');
      const body = typeof command.body === 'string' ? command.body.trim() : '';
      if (!body) throw new CommandError('A note body cannot be empty');
      let id = command.id;
      const existing = id ? state.notes.find((note) => note.id === id) : null;
      if (existing) {
        existing.target = command.target;
        existing.body = body;
      } else {
        if (id == null) {
          const used = new Set(state.notes.map((note) => note.id));
          const next = nextId('note', used, state.noteSeq);
          id = next.id;
          state.noteSeq = next.seq;
        }
        if (typeof id !== 'string') throw new CommandError('A note id must be a string');
        if (state.notes.some((note) => note.id === id)) {
          throw new CommandError(`A note already exists with id ${JSON.stringify(id)}`);
        }
        const suffix = /:(\d+)$/.exec(id);
        if (suffix) state.noteSeq = Math.max(state.noteSeq, Number.parseInt(suffix[1], 10));
        state.notes.push({ id, target: command.target, body });
      }
      results.push({ type: command.type, id, changed: true });
      continue;
    }

    if (command.type === COMMAND.DELETE_NOTE) {
      const before = state.notes.length;
      state.notes = state.notes.filter((note) => note.id !== command.id);
      results.push({ type: command.type, id: command.id, changed: state.notes.length !== before });
      continue;
    }

    if (command.type === COMMAND.RESET_PLAN) {
      for (const node of [...nodes.values()]) {
        if (!node.orig) nodes.delete(node.id);
        else {
          node.cur = { ...node.orig };
          node.evicted = false;
        }
      }
      state.notes = [];
      results.push({ type: command.type, changed: true });
      continue;
    }

    if (command.type === COMMAND.MERGE_SUMMARIES) {
      if (!command.summaries || typeof command.summaries !== 'object' || Array.isArray(command.summaries)) {
        throw new CommandError('merge-summaries requires a summaries object');
      }
      for (const [id, summary] of Object.entries(command.summaries)) {
        if (typeof summary === 'string' && summary.trim()) state.summaries[id] = summary.trim();
      }
      results.push({ type: command.type, changed: true });
      continue;
    }

    throw new CommandError(`Unknown command type: ${JSON.stringify(command.type)}`);
  }

  const plan = serializeNodes(nodes, sourcePlan, state);
  const resolved = resolvePlan(scanResult, plan);
  return { plan, results, resolved, changed: comparable(plan) !== comparable(sourcePlan) };
}

export function transactPlan({
  root,
  dataDir = null,
  scan,
  commands,
  expectedRevision,
  transactionId = randomUUID(),
  actor = 'cli',
}) {
  return withWorkspaceLock(root, dataDir, () => {
    const current = loadPlan(root, dataDir);
    if (current.recentTransactions.includes(transactionId)) {
      return {
        duplicate: true,
        changed: false,
        transactionId,
        plan: current,
        ...resolvePlan(scan, current),
      };
    }
    if (!Number.isInteger(expectedRevision)) {
      throw new CommandError('expectedRevision must be an integer');
    }
    if (current.revision !== expectedRevision) {
      throw new RevisionConflictError(expectedRevision, current.revision);
    }

    const result = applyCommands(scan, current, commands);
    if (!result.changed) {
      return {
        duplicate: false,
        changed: false,
        transactionId,
        plan: current,
        ...result.resolved,
        results: result.results,
      };
    }

    const next = {
      ...result.plan,
      revision: current.revision + 1,
      recentTransactions: [...current.recentTransactions, transactionId],
    };
    const saved = savePlan(root, next, dataDir);
    logTransaction(
      root,
      {
        at: saved.savedAt,
        transactionId,
        actor,
        fromRevision: current.revision,
        toRevision: saved.revision,
        commands,
      },
      dataDir
    );
    return {
      duplicate: false,
      changed: true,
      transactionId,
      plan: saved,
      ...result.resolved,
      results: result.results,
    };
  });
}
