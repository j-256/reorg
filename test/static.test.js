import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { scan, readGitignore } from '../src/scan.js';
import { buildStaticPlanner } from '../src/static.js';
import { emptyPlan } from '../src/state.js';
import {
  createPlanExport,
  parsePlanExport,
  PLAN_EXPORT_FORMAT,
  PLAN_EXPORT_FILENAME,
} from '../web/lib/plan-file.js';
import { sandbox, cleanup } from './helpers.js';

const CLI = new URL('../bin/reorg', import.meta.url);
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

test('--version and -v report the package version', () => {
  for (const flag of ['--version', '-v']) {
    const result = runCli([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `reorg ${PACKAGE_VERSION}`);
    assert.equal(result.stderr, '');
  }
});

test('--help includes the package version in its header', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.split(/\r?\n/, 1)[0],
    `reorg ${PACKAGE_VERSION} -- plan alone or collaborate with an AI agent, then apply safely.`
  );
  assert.match(result.stdout, /--allow-apply/);
});

test('--allow-apply is limited to the live browser server', () => {
  const root = sandbox({ 'keep.txt': 'keep' });
  try {
    const staticResult = runCli([root, '--static', '--allow-apply', '--no-open']);
    assert.equal(staticResult.status, 1);
    assert.match(staticResult.stderr, /unavailable with --static/i);

    const inspectResult = runCli(['inspect', root, '--allow-apply']);
    assert.equal(inspectResult.status, 1);
    assert.match(inspectResult.stderr, /only applies to the browser server/i);
  } finally {
    cleanup(root);
  }
});

test('the static planner inlines its assets and scan data', () => {
  const root = sandbox({
    'keep.txt': 'keep me',
    'docs/note.md': '# note\nbody',
    'literal-script.txt': '</script><script>globalThis.bad = true</script>',
  });
  try {
    const result = buildStaticPlanner({
      root,
      scan: scan(root),
      plan: emptyPlan(),
      gitignore: readGitignore(root),
    });

    assert.match(result.html, /<script type="importmap">/);
    assert.match(result.html, /href="data:image\/svg\+xml;base64,/);
    assert.doesNotMatch(result.html, /(?:href|src)="\/(?:app|favicon)/);
    assert.doesNotMatch(result.html, /globalThis\.bad/);
    assert.ok(result.previewStats.included > 0);
  } finally {
    cleanup(root);
  }
});

test('plan exports retain the source scan and also accept a bare plan', () => {
  const root = sandbox({ 'keep.txt': 'keep' });
  try {
    const sourceScan = scan(root);
    const plan = {
      ...emptyPlan(),
      overrides: [{ id: 'keep.txt', cur: { name: 'renamed.txt', parentId: '.' } }],
    };
    const view = { revision: 3, selectedId: 'keep.txt', side: { mode: 'preview', targetId: 'keep.txt' } };
    const exported = createPlanExport(sourceScan, plan, view);
    const parsed = parsePlanExport(exported);

    assert.equal(exported.format, PLAN_EXPORT_FORMAT);
    assert.equal(parsed.sourceRoot, root);
    assert.equal(parsed.scan, sourceScan);
    assert.equal(parsed.plan, plan);
    assert.equal(parsed.view, view);
    assert.deepEqual(parsePlanExport(plan), { sourceRoot: null, scan: null, plan });
    assert.throws(
      () => parsePlanExport({ ...exported, format: 'something-else' }),
      /unsupported plan format/i
    );
  } finally {
    cleanup(root);
  }
});

test('the CLI generates a static page at an explicit output path', () => {
  const root = sandbox({ 'keep.txt': 'keep' });
  const exchange = sandbox({});
  try {
    const output = join(exchange, 'planner.html');
    const result = runCli([root, '-s', '--no-open', '-o', output]);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(output));
    const html = readFileSync(output, 'utf8');
    assert.match(html, /static-api/);
    assert.match(result.stdout, /static snapshot/i);

    const refused = runCli([root, '--static', '--no-open', '--output', output]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already exists/i);
    assert.equal(readFileSync(output, 'utf8'), html);
  } finally {
    cleanup(exchange);
    cleanup(root);
  }
});

test('-p is the short alias for --port', () => {
  const root = sandbox({ 'keep.txt': 'keep' });
  try {
    const result = runCli(['plan', root, '-p', '1234']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing planned/i);
  } finally {
    cleanup(root);
  }
});

test('explicitly empty CLI values are refused instead of targeting the current directory', () => {
  const root = sandbox({ 'keep.txt': 'keep' });
  try {
    const emptyRoot = runCli(['inspect', '', '--json'], { cwd: root });
    assert.equal(emptyRoot.status, 2);
    assert.match(emptyRoot.stderr, /positional arguments cannot be empty/i);
    assert.equal(existsSync(join(root, '.reorg')), false);

    const emptyDataDir = runCli(['inspect', root, '--data-dir', '', '--json'], { cwd: root });
    assert.equal(emptyDataDir.status, 2);
    assert.match(emptyDataDir.stderr, /--data-dir requires a non-empty value/i);
    assert.equal(existsSync(join(root, '.reorg')), false);
  } finally {
    cleanup(root);
  }
});

test('an exported plan dry-runs and applies through the CLI without a directory argument', () => {
  const root = sandbox({ 'keep.txt': 'keep' });
  const exchange = sandbox({});
  try {
    const sourceScan = scan(root);
    const plan = {
      ...emptyPlan(),
      overrides: [{ id: 'keep.txt', cur: { name: 'renamed.txt', parentId: '.' } }],
    };
    const json = JSON.stringify(createPlanExport(sourceScan, plan));
    const planPath = join(exchange, PLAN_EXPORT_FILENAME);
    writeFileSync(planPath, json);

    const dry = runCli(['apply', '--plan', '-'], { input: json });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /DRY RUN/);
    assert.match(dry.stdout, /keep\.txt\s+->\s+renamed\.txt/);
    assert.ok(existsSync(join(root, 'keep.txt')));

    const real = runCli(['apply', '--plan', planPath, '-y']);
    assert.equal(real.status, 0, real.stderr);
    assert.ok(!existsSync(join(root, 'keep.txt')));
    assert.ok(existsSync(join(root, 'renamed.txt')));
  } finally {
    cleanup(exchange);
    cleanup(root);
  }
});

test('an explicit apply directory overrides the root embedded in an export', () => {
  const source = sandbox({ 'keep.txt': 'source' });
  const target = sandbox({ 'keep.txt': 'target' });
  try {
    const plan = {
      ...emptyPlan(),
      overrides: [{ id: 'keep.txt', cur: { name: 'renamed.txt', parentId: '.' } }],
    };
    const json = JSON.stringify(createPlanExport(scan(source), plan));

    const result = runCli(['apply', target, '--plan', '-', '--yes'], { input: json });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(source, 'keep.txt')));
    assert.ok(!existsSync(join(target, 'keep.txt')));
    assert.equal(readFileSync(join(target, 'renamed.txt'), 'utf8'), 'target');
  } finally {
    cleanup(target);
    cleanup(source);
  }
});

test('an exported scan lets the CLI detect drift instead of dropping a missing override', () => {
  const root = sandbox({ 'keep.txt': 'keep' });
  try {
    const sourceScan = scan(root);
    const plan = {
      ...emptyPlan(),
      overrides: [{ id: 'keep.txt', cur: { name: 'renamed.txt', parentId: '.' } }],
    };
    const json = JSON.stringify(createPlanExport(sourceScan, plan));
    unlinkSync(join(root, 'keep.txt'));

    const result = runCli(['apply', '--plan', '-'], { input: json });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no longer exists/i);
    assert.match(result.stderr, /nothing was changed/i);
  } finally {
    cleanup(root);
  }
});

test('the CLI refuses an exported plan whose edited name escapes the root', () => {
  const container = sandbox({ 'root/keep.txt': 'keep' });
  const root = join(container, 'root');
  try {
    const plan = {
      ...emptyPlan(),
      overrides: [{ id: 'keep.txt', cur: { name: '../escaped.txt', parentId: '.' } }],
    };
    const json = JSON.stringify(createPlanExport(scan(root), plan));

    const result = runCli(['apply', '--plan', '-', '--yes'], { input: json });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe .* path/i);
    assert.ok(existsSync(join(root, 'keep.txt')));
    assert.ok(!existsSync(join(container, 'escaped.txt')));
  } finally {
    cleanup(container);
  }
});
