import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scan, readGitignore } from '../src/scan.js';
import { emptyPlan } from '../src/state.js';
import { writeStaticPlanner } from '../src/static.js';
import { PLAN_EXPORT_FILENAME } from '../web/lib/plan-file.js';
import { sandbox, cleanup } from './helpers.js';
import { getBrowser, closeBrowser } from './ui-harness.js';

after(closeBrowser);

test('the self-contained page plans, previews, reviews, and exports without a server', async () => {
  const root = sandbox({
    'keep.txt': 'keep me',
    'notes.md': 'first line\nsecond line',
    'docs/note.md': '# note',
  });
  const exchange = sandbox({});
  const output = join(exchange, 'planner.html');
  writeStaticPlanner(output, {
    root,
    scan: scan(root),
    plan: emptyPlan(),
    gitignore: readGitignore(root),
  });

  const browser = await getBrowser();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  try {
    await page.goto(pathToFileURL(output).href);
    await page.waitForSelector('.row');
    assert.equal(await page.locator('#saveState').textContent(), 'static snapshot');
    assert.equal(await page.getByRole('button', { name: 'rescan', exact: true }).count(), 0);
    const applyError = await page.evaluate(async () => {
      const { api } = await import('reorg:api');
      try {
        await api.post('/api/apply', { dryRun: false });
        return null;
      } catch (error) {
        return error.message;
      }
    });
    assert.match(applyError, /cannot check or write to disk/i);

    await page.locator('.row[data-id="notes.md"]').click();
    await page.waitForSelector('pre.head');
    assert.match(await page.locator('pre.head').textContent(), /first line/);

    await page.locator('.row[data-id="keep.txt"]').click();
    await page.keyboard.press('F2');
    await page.keyboard.type('renamed.txt');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#saveState').textContent(), 'not exported');

    await page.getByRole('button', { name: 'review', exact: true }).click();
    await page.waitForSelector('text=continue in the terminal');
    assert.match(await page.locator('#sideBody').textContent(), /keep\.txt\s+->\s+renamed\.txt/);
    assert.equal(await page.getByRole('button', { name: 'dry run', exact: true }).count(), 0);

    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'download plan', exact: true }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), PLAN_EXPORT_FILENAME);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    assert.equal(payload.root, root);
    assert.deepEqual(
      payload.plan.overrides.find((item) => item.id === 'keep.txt').cur,
      { name: 'renamed.txt', parentId: '.' }
    );
    assert.equal(await page.locator('#saveState').textContent(), 'plan exported');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    cleanup(exchange);
    cleanup(root);
  }
});
