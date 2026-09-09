import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { apply } from '../src/apply.js';
import { resolve } from '../src/plan.js';
import { scan } from '../src/scan.js';
import { sandbox, cleanup } from './helpers.js';

const CRASH_EXIT = 86;
const STAMP = 'crash-test';
const HOOK = new URL('./fixtures/recovery-crash.mjs', import.meta.url);
const APPLY = new URL('../src/apply.js', import.meta.url);
const CASES = [
  {
    name: 'rename cycle',
    layout: { a: 'A', b: 'B', c: 'C' },
    plan: { overrides: [
      { id: 'a', cur: { name: 'b', parentId: '.' } },
      { id: 'b', cur: { name: 'c', parentId: '.' } },
      { id: 'c', cur: { name: 'a', parentId: '.' } },
    ] },
  },
  {
    name: 'folder creation and trash',
    layout: { 'old/kept': 'keep', 'junk/item': 'trash' },
    plan: {
      created: [{ id: 'new:dir', cur: { name: 'new directory', parentId: '.' } }],
      overrides: [
        { id: 'old/kept', cur: { name: 'kept', parentId: 'new:dir' } },
        { id: 'junk', cur: { name: 'junk', parentId: '.' }, evicted: true },
        { id: 'junk/item', cur: { name: 'item', parentId: 'junk' }, evicted: true },
      ],
    },
  },
];

function snapshot(root, parent = '') {
  const entries = [];
  for (const name of readdirSync(join(root, parent)).filter(name => name !== '.reorg').sort()) {
    const relative = join(parent, name);
    const entry = lstatSync(join(root, relative));
    entries.push([relative, entry.ino, entry.isDirectory() ? null : readFileSync(join(root, relative)).toString('base64')]);
    if (entry.isDirectory()) entries.push(...snapshot(root, relative));
  }
  return entries;
}

for (const scenario of CASES) {
  for (const phase of ['apply', 'undo']) {
    for (const boundary of ['before', 'after']) {
      test(`${scenario.name} survives abrupt ${phase} exit ${boundary} each rename`, () => {
        let length = Infinity;
        for (let cutoff = 1; cutoff <= length; cutoff++) {
          const root = sandbox(scenario.layout);
          try {
            const original = snapshot(root);
            const { ops, problems } = resolve(scan(root), scenario.plan);
            assert.deepEqual(problems, []);
            length = ops.length;
            const env = { ...process.env, REORG_TEST_CRASH_AFTER: String(cutoff), REORG_TEST_CRASH_BOUNDARY: boundary };
            const script = join(root, `.reorg/undo-${STAMP}.sh`);
            let result;
            if (phase === 'apply') {
              const code = `import { apply } from ${JSON.stringify(APPLY.href)}; apply(process.argv[1], JSON.parse(process.argv[2]), { dryRun: false, useGit: false, stamp: process.argv[3] });`;
              result = spawnSync(process.execPath, ['--import', fileURLToPath(HOOK), '--input-type=module', '-e', code, root, JSON.stringify(ops), STAMP], { encoding: 'utf8', env });
            } else {
              const applied = apply(root, ops, { dryRun: false, useGit: false, stamp: STAMP });
              assert.deepEqual(applied.problems, []);
              result = spawnSync('/bin/bash', [script], {
                encoding: 'utf8', env: { ...env, NODE_OPTIONS: '--import=' + HOOK.href },
              });
            }
            assert.equal(result.status, CRASH_EXIT, `operation ${cutoff}: ${result.stderr}`);
            for (let repeat = 0; repeat < 2; repeat++) {
              execFileSync('/bin/bash', [script], { stdio: 'pipe' });
              assert.deepEqual(snapshot(root), original, `operation ${cutoff}, recovery ${repeat}`);
            }
          } finally {
            cleanup(root);
          }
        }
      });
    }
  }
}
