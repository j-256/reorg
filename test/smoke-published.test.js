import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publishedInstallArgs,
  RETRY_POLICY,
  retryInstall,
} from '../scripts/smoke-published.mjs';

test('registry install can resolve the version published moments earlier', () => {
  assert.deepEqual(
    publishedInstallArgs('reorg-cli@1.2.3'),
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--min-release-age=0',
      'reorg-cli@1.2.3',
    ],
  );
});

test('registry retries tolerate delayed availability after several misses', async () => {
  let calls = 0;
  const pauses = [];
  const failures = [];
  const successAttempt = await retryInstall({
    install: async () => {
      calls += 1;
      return { ok: calls > 5, output: 'ETARGET' };
    },
    pause: async (ms) => pauses.push(ms),
    report: ({ attempt }) => failures.push(attempt),
  });

  assert.equal(successAttempt, 6);
  assert.deepEqual(failures, [1, 2, 3, 4, 5]);
  assert.deepEqual(pauses, [10_000, 20_000, 30_000, 30_000, 30_000]);
});

test('registry retries fail after the full policy without a final pause', async () => {
  let calls = 0;
  const pauses = [];
  await assert.rejects(
    retryInstall({
      install: async () => {
        calls += 1;
        return { ok: false, output: 'ETARGET' };
      },
      pause: async (ms) => pauses.push(ms),
    }),
    /did not become installable/,
  );

  assert.equal(calls, RETRY_POLICY.maxAttempts);
  assert.equal(pauses.length, RETRY_POLICY.maxAttempts - 1);
});
