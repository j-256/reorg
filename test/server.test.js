// Server tests: the access-control surface, over real HTTP.
//
// This is the one module that exposes file reads and (behind a flag) filesystem
// mutation to anything that can reach a socket, so its fences are tested the way
// an attacker would meet them -- actual requests against a listening server --
// rather than by calling the guard functions directly. A path-traversal check
// that passes in isolation proves nothing about whether the route consults it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createReorgServer } from '../src/server.js';
import { loadPlan } from '../src/state.js';
import { sandbox, cleanup } from './helpers.js';

const TREE = {
  'keep.txt': 'keep me',
  'secret-sibling.txt': 'not under the scan root once we point at a subdir',
  'docs/note.md': '# note',
  'docs/nested/deep.txt': 'deep',
};

// Boot a server on an ephemeral port and hand back a fetch bound to it.
async function serve(layout, opts = {}) {
  const root = sandbox(layout);
  const { server, token } = createReorgServer({ root, ...opts });
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

test('without --allow-apply the server can dry-run but never mutate', async () => {
  const s = await serve(TREE, { allowApply: false });
  try {
    const plan = {
      ...loadPlan(s.root),
      overrides: [{ id: 'keep.txt', cur: { name: 'keep.txt', parentId: 'docs' } }],
    };

    const dry = await s.call('/api/apply', { method: 'POST', body: { plan, dryRun: true } });
    assert.equal(dry.status, 200);
    assert.equal((await dry.json()).dryRun, true);
    assert.ok(existsSync(join(s.root, 'keep.txt')), 'a dry run must not move anything');

    const real = await s.call('/api/apply', { method: 'POST', body: { plan, dryRun: false } });
    assert.equal(real.status, 403);
    assert.match((await real.json()).error, /--allow-apply/);
    assert.ok(existsSync(join(s.root, 'keep.txt')), 'a refused apply must not move anything');
    assert.ok(!existsSync(join(s.root, 'docs/keep.txt')));
  } finally {
    await s.close();
  }
});

test('the apply route is reachable only as a POST', async () => {
  const s = await serve(TREE, { allowApply: true });
  try {
    const res = await s.call('/api/apply');
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

test('with --allow-apply the server applies and retires the plan server-side', async () => {
  const s = await serve(TREE, { allowApply: true });
  try {
    const plan = {
      ...loadPlan(s.root),
      overrides: [{ id: 'keep.txt', cur: { name: 'keep.txt', parentId: 'docs' } }],
    };
    await s.call('/api/plan', { method: 'PUT', body: { plan } });

    const res = await s.call('/api/apply', { method: 'POST', body: { plan, dryRun: false } });
    assert.equal(res.status, 200);
    assert.ok(existsSync(join(s.root, 'docs/keep.txt')));
    assert.ok(!existsSync(join(s.root, 'keep.txt')));

    // A plan left behind would make the next resolve report collisions against
    // the tree it just created, so the server clears it rather than trusting the
    // browser to follow up.
    assert.deepEqual(loadPlan(s.root).overrides, []);
  } finally {
    await s.close();
  }
});

test('an unresolvable plan is reported as a conflict and changes nothing', async () => {
  const s = await serve(TREE, { allowApply: true });
  try {
    // Two entries landing on one path is a plan-time collision, not a move-time surprise.
    const plan = {
      ...loadPlan(s.root),
      overrides: [
        { id: 'keep.txt', cur: { name: 'note.md', parentId: 'docs' } },
      ],
    };
    const res = await s.call('/api/apply', { method: 'POST', body: { plan, dryRun: false } });
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
    const plan = {
      ...loadPlan(s.root),
      overrides: [{ id: 'keep.txt', cur: { name: 'keep.txt', parentId: 'docs' } }],
    };
    const res = await s.call('/api/resolve', { method: 'POST', body: { plan } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ops.length > 0);
    assert.ok(Array.isArray(body.script));
    assert.ok(existsSync(join(s.root, 'keep.txt')), 'resolve must not move anything');
  } finally {
    await s.close();
  }
});

test('a saved plan is persisted and handed back by /api/tree', async () => {
  const s = await serve(TREE);
  try {
    const plan = { ...loadPlan(s.root), notes: [{ id: 'keep.txt', text: 'why this stays' }] };
    const put = await s.call('/api/plan', { method: 'PUT', body: { plan } });
    assert.equal(put.status, 200);
    assert.ok((await put.json()).savedAt);

    const tree = await (await s.call('/api/tree')).json();
    assert.deepEqual(tree.plan.notes, [{ id: 'keep.txt', text: 'why this stays' }]);
    assert.equal(tree.allowApply, false);
  } finally {
    await s.close();
  }
});

test('malformed JSON is answered with an error, not a crashed process', async () => {
  const s = await serve(TREE);
  try {
    const res = await fetch(`${s.base}/api/plan?token=${s.token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 500);
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
