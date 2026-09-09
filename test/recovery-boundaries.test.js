import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listUndoScripts } from '../src/state.js';
import { sandbox, cleanup } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/reorg', import.meta.url));
const HOOK = new URL('./fixtures/recovery-crash.mjs', import.meta.url);
const SERVER = new URL('../src/server.js', import.meta.url);
const FAILURE_ENV = { ...process.env, REORG_TEST_CRASH_AFTER: '2', REORG_TEST_CRASH_BOUNDARY: 'throw-before' };
const COMMANDS = [{ type: 'rename', id: 'a', name: 'renamed-a' }, { type: 'rename', id: 'b', name: 'renamed-b' }];

function prepare(t) {
  const root = sandbox({ a: 'A', b: 'B' });
  t.after(() => cleanup(root));
  const result = spawnSync(process.execPath, [CLI, 'mutate', root, '--input', '-', '--json'], {
    encoding: 'utf8', input: JSON.stringify(COMMANDS),
  });
  assert.equal(result.status, 0, result.stderr);
  return root;
}

function verifyRecovery(root) {
  assert.equal(readFileSync(join(root, 'renamed-a'), 'utf8'), 'A');
  assert.equal(readFileSync(join(root, 'b'), 'utf8'), 'B');
  const history = readFileSync(join(root, '.reorg/history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(history.at(-1).status, 'partial');
  assert.equal(history.at(-1).error.code, 'apply-interrupted');
  assert.ok(history.at(-1).durationMs >= 0);
  const restored = spawnSync(process.execPath, [CLI, 'undo', root], { encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'A');
  assert.equal(readFileSync(join(root, 'b'), 'utf8'), 'B');
}

test('CLI reports a partial apply and keeps its plan and recovery available', (t) => {
  const root = prepare(t);
  const result = spawnSync(process.execPath, ['--import', fileURLToPath(HOOK), CLI, 'apply', root, '--yes'], {
    encoding: 'utf8', env: FAILURE_ENV,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stopped after 1 completed operation/);
  assert.match(result.stderr, /Simulated filesystem failure/);
  assert.match(result.stderr, /Recovery: bash/);
  assert.doesNotMatch(result.stderr, /before making any change|nothing was applied/);
  assert.equal(JSON.parse(readFileSync(join(root, '.reorg/plan.json'), 'utf8')).overrides.length, 2);
  verifyRecovery(root);
});

test('HTTP reports the same partial apply with run identity and recovery path', async (t) => {
  const root = prepare(t);
  const code = `import { createReorgServer } from ${JSON.stringify(SERVER.href)}; const { server, token } = createReorgServer({ root: process.argv[1], allowApply: true }); server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, token })));`;
  const child = spawn(process.execPath, ['--import', fileURLToPath(HOOK), '--input-type=module', '-e', code, root], {
    env: FAILURE_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  });
  let output = '';
  const ready = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error('Server exited before startup: ' + code)));
    child.stdout.on('data', data => {
      output += data;
      if (output.includes('\n')) resolve(JSON.parse(output.slice(0, output.indexOf('\n'))));
    });
  });
  const url = endpoint => `http://127.0.0.1:${ready.port}${endpoint}?token=${ready.token}`;
  const before = await (await fetch(url('/api/tree'))).json();
  const response = await fetch(url('/api/apply'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: false, expectedRevision: before.plan.revision, expectedScanId: before.scan.id }) });
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.partial, true);
  assert.equal(result.code, 'apply-interrupted');
  assert.equal(result.applied, 1);
  assert.equal(result.undoPath, join(root, '.reorg', listUndoScripts(root)[0]));
  assert.ok(result.stamp);
  assert.ok(result.durationMs >= 0);
  const after = await (await fetch(url('/api/tree'))).json();
  assert.equal(after.plan.revision, before.plan.revision);
  verifyRecovery(root);
});
