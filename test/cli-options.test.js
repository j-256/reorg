import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const CLI = new URL('../bin/reorg', import.meta.url);

function runCli(args) {
  return spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: 'utf8',
  });
}

test('short aliases match long options and appear in help', () => {
  const shortResult = runCli([
    '-c', '2',
    '-d', 'state',
    '-e',
    '-f',
    '-i',
    '-j',
    '-l', '3',
    '-m', 'model',
    '-h',
  ]);
  const longResult = runCli([
    '--collapse-over', '2',
    '--data-dir', 'state',
    '--emit-prompts',
    '--force',
    '--ingest',
    '--json',
    '--limit', '3',
    '--model', 'model',
    '--help',
  ]);

  assert.equal(shortResult.status, 0, shortResult.stderr);
  assert.equal(longResult.status, 0, longResult.stderr);
  assert.equal(shortResult.stdout, longResult.stdout);
  for (const option of [
    '-c, --collapse-over',
    '-d, --data-dir',
    '-e, --emit-prompts',
    '-f, --force',
    '-i, --ingest',
    '-j, --json',
    '-l, --limit',
    '-m, --model',
  ]) {
    assert.match(shortResult.stdout, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('unknown short options remain usage errors', () => {
  const result = runCli(['-x']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option -x/);
});
