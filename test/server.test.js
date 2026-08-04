// Server tests: the access-control surface, over real HTTP.
//
// This is the one module that exposes file reads and (behind a flag) filesystem
// mutation to anything that can reach a socket, so its fences are tested the way
// an attacker would meet them -- actual requests against a listening server --
// rather than by calling the guard functions directly. A path-traversal check
// that passes in isolation proves nothing about whether the route consults it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createReorgServer, listenOnAvailablePort } from '../src/server.js';
import { acquireWorkspaceLock } from '../src/state.js';
import { sandbox, cleanup } from './helpers.js';

const CLI = new URL('../bin/reorg', import.meta.url);

const TREE = {
  'keep.txt': 'keep me',
  'secret-sibling.txt': 'not under the scan root once we point at a subdir',
  'docs/note.md': '# note',
  'docs/nested/deep.txt': 'deep',
};

// Boot a server on an ephemeral port and hand back a fetch bound to it.
async function serve(layout, opts = {}) {
  const root = sandbox(layout);
  const { prepare, ...serverOptions } = opts;
  if (prepare) await prepare(root);
  const { server, token } = createReorgServer({ root, ...serverOptions });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = (path, { method = 'GET', body, auth = token, header = false } = {}) => {
    const url = new URL(base + path);
    if (auth && !header) url.searchParams.set('token', auth);
    return fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && header ? { 'x-reorg-token': auth } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  };

  return {
    root,
    token,
    base,
    call,
    async close() {
      await new Promise((done) => server.close(done));
      cleanup(root);
    },
  };
}

async function mutate(s, commands, extra = {}) {
  const tree = await (await s.call('/api/tree')).json();
  const res = await s.call('/api/transactions', {
    method: 'POST',
    body: {
      expectedRevision: tree.plan.revision,
      transactionId: extra.transactionId || `test:${crypto.randomUUID()}`,
      actor: 'server-test',
      commands,
    },
  });
  assert.equal(res.status, 200);
  return res.json();
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('available-port fallback reports the port it actually binds', async () => {
  const occupied = createServer();
  const candidate = createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const occupiedPort = occupied.address().port;
  try {
    const reportedPort = await listenOnAvailablePort(candidate, occupiedPort);
    assert.notEqual(reportedPort, occupiedPort);
    assert.equal(reportedPort, candidate.address().port);
  } finally {
    await closeServer(candidate);
    await closeServer(occupied);
  }
});

test('the API is unreachable without the run token', async () => {
  const s = await serve(TREE);
  try {
    for (const path of ['/api/tree', '/api/triage', '/api/head?path=keep.txt']) {
      const res = await s.call(path, { auth: null });
      assert.equal(res.status, 403, `${path} should be refused`);
      assert.match((await res.json()).error, /token/i);
    }
  } finally {
    await s.close();
  }
});

test('a wrong token of the same length is refused', async () => {
  // timingSafeEqual throws on a length mismatch, so the equal-length case is the
  // one that actually exercises the comparison rather than the length guard.
  const s = await serve(TREE);
  try {
    const wrong = 'f'.repeat(s.token.length);
    assert.notEqual(wrong, s.token);
    const res = await s.call('/api/tree', { auth: wrong });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test('a token of the wrong length is refused rather than crashing the request', async () => {
  const s = await serve(TREE);
  try {
    for (const bad of ['', 'x', s.token.slice(0, -1), s.token + 'x']) {
      const res = await s.call('/api/tree', { auth: bad || null });
      assert.equal(res.status, 403, `token ${JSON.stringify(bad)} should be refused`);
    }
  } finally {
    await s.close();
  }
});

test('the token is accepted in a header as well as a query parameter', async () => {
  const s = await serve(TREE);
  try {
    const res = await s.call('/api/tree', { header: true });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

test('opening an existing workspace preserves its frozen scan until an explicit rescan', async () => {
  const s = await serve(TREE, {
    prepare(root) {
      const initialized = spawnSync(process.execPath, [CLI.pathname, 'inspect', root, '--json'], {
        encoding: 'utf8',
      });
      assert.equal(initialized.status, 0, initialized.stderr);
      writeFileSync(join(root, 'arrived.txt'), 'new');
    },
  });
  try {
    const frozen = await (await s.call('/api/tree')).json();
    assert.ok(!frozen.scan.nodes.some((node) => node.id === 'arrived.txt'));

    const refreshed = await (await s.call('/api/rescan', { method: 'POST', body: {} })).json();
    assert.ok(refreshed.scan.nodes.some((node) => node.id === 'arrived.txt'));
  } finally {
    await s.close();
  }
});

test('portable state cannot move while its browser server is running', async () => {
  const s = await serve(TREE);
  const destinationRoot = sandbox({});
  const destination = join(destinationRoot, 'moved-state');
  try {
    const result = spawnSync(
      process.execPath,
      [CLI.pathname, 'state', 'move', destination, '--data-dir', join(s.root, '.reorg')],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /being served/i);
    assert.ok(existsSync(join(s.root, '.reorg', 'workspace.json')));
    assert.equal(existsSync(destination), false);
  } finally {
    cleanup(destinationRoot);
    await s.close();
  }
});

test('a concurrent workspace write reports a retryable busy response', async () => {
  const s = await serve(TREE);
  const release = acquireWorkspaceLock(s.root);
  try {
    const res = await s.call('/api/revisions');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'workspace-busy');
  } finally {
    release();
    await s.close();
  }
});

test('static files are served without a token, but only from web/', async () => {
  const s = await serve(TREE);
  try {
    const ok = await s.call('/', { auth: null });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/html/);

    // The planner is a static asset; the scan root's files are not reachable here.
    const escape = await s.call('/../package.json', { auth: null });
    assert.equal(escape.status, 404);
  } finally {
    await s.close();
  }
});

test('/api/head refuses paths that escape the scan root', async () => {
  const s = await serve(TREE);
  try {
    const escapes = [
      '../secret-sibling.txt',
      '../../etc/passwd',
      'docs/../../etc/passwd',
      '/etc/passwd',
      './../package.json',
      // The example the README cites, kept in step with it on purpose
      '../../.ssh/id_rsa',
    ];
    for (const p of escapes) {
      const res = await s.call(`/api/head?path=${encodeURIComponent(p)}`);
      assert.equal(res.status, 400, `${p} should be refused`);
      assert.match((await res.json()).error, /escapes/i);
    }
  } finally {
    await s.close();
  }
});

test('/api/head refuses a path containing a null byte', async () => {
  const s = await serve(TREE);
  try {
    const res = await s.call(`/api/head?path=${encodeURIComponent('keep.txt\0.png')}`);
    assert.equal(res.status, 400);
  } finally {
    await s.close();
  }
});

test('/api/head refuses an empty or missing path instead of reading the root', async () => {
  const s = await serve(TREE);
  try {
    assert.equal((await s.call('/api/head?path=')).status, 400);
    assert.equal((await s.call('/api/head')).status, 400);
  } finally {
    await s.close();
  }
});

test('/api/head reads a file inside the root and reports a directory as such', async () => {
  const s = await serve(TREE);
  try {
    const file = await s.call('/api/head?path=docs/note.md');
    assert.equal(file.status, 200);
    const body = await file.json();
    assert.equal(body.binary, false);
    assert.equal(body.text, '# note');

    const dir = await s.call('/api/head?path=docs');
    assert.equal(dir.status, 400);
    assert.match((await dir.json()).error, /directory/i);

    const missing = await s.call('/api/head?path=nope.txt');
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

test('/api/head reports binary content rather than returning mojibake', async () => {
  const s = await serve(TREE);
  try {
    writeFileSync(join(s.root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    const res = await s.call('/api/head?path=blob.bin');
    const body = await res.json();
    assert.equal(body.binary, true);
    assert.equal(body.text, null);
  } finally {
    await s.close();
  }
});

test('/api/head caps how much it reads and says the result is truncated', async () => {
  const s = await serve(TREE);
  try {
    writeFileSync(join(s.root, 'big.txt'), Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
    const res = await s.call('/api/head?path=big.txt&lines=10');
    const body = await res.json();
    assert.equal(body.shown, 10);
    assert.equal(body.truncated, true);
    assert.equal(body.text.split('\n').length, 10);
  } finally {
    await s.close();
  }
});

test('the server can dry-run but never mutate the filesystem', async () => {
  const s = await serve(TREE);
  try {
    await mutate(s, [{ type: 'move', id: 'keep.txt', parentId: 'docs' }]);

    const dry = await s.call('/api/apply', { method: 'POST', body: { dryRun: true } });
    assert.equal(dry.status, 200);
    assert.equal((await dry.json()).dryRun, true);
    assert.ok(existsSync(join(s.root, 'keep.txt')), 'a dry run must not move anything');

    const real = await s.call('/api/apply', { method: 'POST', body: { dryRun: false } });
    assert.equal(real.status, 403);
    assert.match((await real.json()).error, /reorg apply --yes/);
    assert.ok(existsSync(join(s.root, 'keep.txt')), 'a refused apply must not move anything');
    assert.ok(!existsSync(join(s.root, 'docs/keep.txt')));
  } finally {
    await s.close();
  }
});

test('a live server adopts the refreshed scan after an explicit CLI apply', async () => {
  const s = await serve(TREE);
  try {
    const before = await (await s.call('/api/revisions')).json();
    await mutate(s, [{ type: 'rename', id: 'keep.txt', name: 'kept.txt' }]);

    const applied = spawnSync(process.execPath, [CLI.pathname, 'apply', s.root, '--yes'], {
      encoding: 'utf8',
    });
    assert.equal(applied.status, 0, applied.stderr);

    const after = await (await s.call('/api/revisions')).json();
    assert.notEqual(after.scanId, before.scanId);
    assert.equal(after.planRevision, 2);
    const tree = await (await s.call('/api/tree')).json();
    assert.ok(tree.scan.nodes.some((node) => node.id === 'kept.txt'));
    assert.ok(!tree.scan.nodes.some((node) => node.id === 'keep.txt'));
    assert.deepEqual(tree.plan.overrides, []);
  } finally {
    await s.close();
  }
});

test('the apply route is reachable only as a POST', async () => {
  const s = await serve(TREE);
  try {
    const res = await s.call('/api/apply');
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

test('an unresolvable plan is reported as a conflict and changes nothing', async () => {
  const s = await serve(TREE);
  try {
    // Two entries landing on one path is a plan-time collision, not a move-time surprise.
    const mutation = await mutate(s, [
      { type: 'move', id: 'keep.txt', parentId: 'docs' },
      { type: 'rename', id: 'keep.txt', name: 'note.md' },
    ]);
    assert.ok(mutation.problems.length > 0);
    const res = await s.call('/api/apply', { method: 'POST', body: { dryRun: true } });
    assert.equal(res.status, 409);
    assert.ok((await res.json()).problems.length > 0);
    assert.ok(existsSync(join(s.root, 'keep.txt')));
  } finally {
    await s.close();
  }
});

test('/api/resolve reports operations without touching disk', async () => {
  const s = await serve(TREE);
  try {
    await mutate(s, [{ type: 'move', id: 'keep.txt', parentId: 'docs' }]);
    const res = await s.call('/api/resolve', { method: 'POST', body: {} });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ops.length > 0);
    assert.ok(Array.isArray(body.script));
    assert.ok(existsSync(join(s.root, 'keep.txt')), 'resolve must not move anything');
  } finally {
    await s.close();
  }
});

test('a semantic transaction is persisted and handed back by /api/tree', async () => {
  const s = await serve(TREE);
  try {
    const mutation = await mutate(s, [
      { type: 'set-note', id: 'note:test', target: 'keep.txt', body: 'why this stays' },
    ]);
    assert.ok(mutation.plan.savedAt);

    const tree = await (await s.call('/api/tree')).json();
    assert.deepEqual(tree.plan.notes, [
      { id: 'note:test', target: 'keep.txt', body: 'why this stays' },
    ]);
    assert.equal(Object.hasOwn(tree, 'allowApply'), false);
  } finally {
    await s.close();
  }
});

test('inspect reports the exact shared view projected onto the canonical plan', async () => {
  const s = await serve(TREE);
  try {
    await mutate(s, [{ type: 'move', id: 'keep.txt', parentId: 'docs' }]);
    const view = await s.call('/api/view', {
      method: 'PUT',
      body: {
        expectedRevision: 0,
        patch: {
          treeInitialized: true,
          collapsed: ['docs'],
          selectedId: 'keep.txt',
          ui: { filterTag: 'moved', heat: true },
          side: { mode: 'preview', targetId: 'keep.txt' },
        },
      },
    });
    assert.equal(view.status, 200);

    const inspected = await (await s.call('/api/inspect')).json();
    const selected = inspected.projection.nodes.find((node) => node.id === 'keep.txt');
    assert.equal(inspected.plan.revision, 1);
    assert.equal(inspected.transactions[0].actor, 'server-test');
    assert.equal(inspected.view.revision, 1);
    assert.equal(inspected.view.side.mode, 'preview');
    assert.equal(inspected.view.selectedId, null);
    assert.equal(selected.currentPath, 'docs/keep.txt');
    assert.equal(selected.visible, false);
    assert.equal(selected.hiddenBy, 'collapsed-ancestor');
    assert.equal(selected.presentation.selected, false);
    assert.equal(selected.presentation.dimmed, false);

    const revisions = await (await s.call('/api/revisions')).json();
    assert.deepEqual(
      { planRevision: revisions.planRevision, viewRevision: revisions.viewRevision },
      { planRevision: 1, viewRevision: 1 }
    );
  } finally {
    await s.close();
  }
});

test('whole-plan replacement is unavailable and stale transactions are rejected', async () => {
  const s = await serve(TREE);
  try {
    const replacement = await s.call('/api/plan', {
      method: 'PUT',
      body: { plan: { overrides: [{ id: 'keep.txt', evicted: true }] } },
    });
    assert.equal(replacement.status, 404);

    await mutate(s, [{ type: 'move', id: 'keep.txt', parentId: 'docs' }]);
    const stale = await s.call('/api/transactions', {
      method: 'POST',
      body: {
        expectedRevision: 0,
        transactionId: 'stale-test',
        commands: [{ type: 'rename', id: 'keep.txt', name: 'kept.txt' }],
      },
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'revision-conflict');
  } finally {
    await s.close();
  }
});

test('malformed JSON is answered with an error, not a crashed process', async () => {
  const s = await serve(TREE);
  try {
    const res = await fetch(`${s.base}/api/transactions?token=${s.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);

    // Still serving afterwards.
    assert.equal((await s.call('/api/tree')).status, 200);
  } finally {
    await s.close();
  }
});

test('an unknown API route is a 404, and the token is still required first', async () => {
  const s = await serve(TREE);
  try {
    assert.equal((await s.call('/api/nope')).status, 404);
    assert.equal((await s.call('/api/nope', { auth: null })).status, 403);
  } finally {
    await s.close();
  }
});

test('API responses are marked no-store', async () => {
  // A cached plan or tree read against a live filesystem is always wrong.
  const s = await serve(TREE);
  try {
    const res = await s.call('/api/tree');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await s.close();
  }
});

test('/api/rescan picks up a tree that changed under the server', async () => {
  const s = await serve(TREE);
  try {
    writeFileSync(join(s.root, 'appeared.txt'), 'new');
    const before = await (await s.call('/api/tree')).json();
    assert.ok(!before.scan.nodes.some((n) => n.name === 'appeared.txt'));

    const after = await (await s.call('/api/rescan', { method: 'POST', body: {} })).json();
    assert.ok(after.scan.nodes.some((n) => n.name === 'appeared.txt'));
  } finally {
    await s.close();
  }
});

test('/api/triage ranks candidates and never mutates', async () => {
  const s = await serve({ ...TREE, 'work-backup/old.txt': 'x' });
  try {
    const res = await s.call('/api/triage');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.candidates.some((c) => c.id === 'work-backup'));
    assert.ok(existsSync(join(s.root, 'work-backup')));
  } finally {
    await s.close();
  }
});

test('the served planner is the one on disk', async () => {
  // Guards against a stale bundle or a wrong WEB_DIR: the bytes served must be
  // the bytes in web/.
  const s = await serve(TREE);
  try {
    const res = await s.call('/app.js', { auth: null });
    assert.equal(res.status, 200);
    const served = await res.text();
    const onDisk = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.equal(served, onDisk);
  } finally {
    await s.close();
  }
});
