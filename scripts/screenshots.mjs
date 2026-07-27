#!/usr/bin/env node
// Generate the README screenshots.
//
// Programmatic rather than hand-captured, for three reasons: there is no browser
// chrome to crop out (the page IS the app, so a full-page shot is already the
// framing we want), the demo tree is built fresh each run so the images cannot
// drift from what the tool actually does, and a device scale factor of 2 gives
// retina-sharp output that a window capture at 1x does not.
//
// Usage:  node scripts/screenshots.mjs [outDir]
// Default outDir is docs/.

import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReorgServer } from '../src/server.js';

const OUT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
// Height is tuned so the tree content fills the frame: the demo tree runs to about
// 560px, and a taller viewport just adds dead space below the last row that a
// reader has to scroll past in the README.
const VIEWPORT = { width: 1280, height: 760 };

/* A directory that looks like a real one people actually have. The point of the
   screenshots is to show the tool earning its keep, and it cannot do that against
   five files totalling 8 bytes: the triage panel needs names worth flagging, the
   heat bars need a size spread, and the tree needs enough depth that collapsing
   means something. Sizes are padded so the byte columns read plausibly. */
const TREE = {
  'Screenshot 2026-03-14 at 10.21.44.png': 220_000,
  'Screenshot 2026-04-02 at 16.03.11.png': 310_000,
  'invoice-march.pdf': 84_000,
  'invoice-april.pdf': 91_000,
  'notes.md': 2_400,
  'todo.txt': 800,

  'node-v24.18.0-darwin-arm64.tar.gz': 48_000_000,
  'node-v24.18.0-darwin-arm64/README.md': 1_200,
  'node-v24.18.0-darwin-arm64/bin/node': 92_000_000,

  'project-backup-20260415/src/index.js': 4_100,
  'project-backup-20260415/src/util.js': 2_800,
  'project-backup-20260415/package.json': 640,

  'project/src/index.js': 4_400,
  'project/src/util.js': 2_800,
  'project/src/api/client.js': 6_200,
  'project/src/api/types.js': 1_900,
  'project/package.json': 700,
  'project/README.md': 3_300,

  'receipts/2026-01.pdf': 61_000,
  'receipts/2026-02.pdf': 58_000,
  'receipts/2026-03.pdf': 64_000,

  'Docker.dmg': 620_000_000,
  'old-notes-presync.txt': 1_100,
  'scratch.log': 240_000,
};

function buildTree() {
  const root = mkdtempSync(join(tmpdir(), 'reorg-shots-'));
  for (const [rel, size] of Object.entries(TREE)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    // Sparse: seek to size-1 and write one byte, so the file REPORTS its declared
    // size without the script writing hundreds of megabytes. The byte columns and
    // heat bars are driven by stat(), so this is indistinguishable in the UI.
    const fd = openSync(abs, 'w');
    if (size > 0) writeSync(fd, Buffer.from([0x20]), 0, 1, size - 1);
    closeSync(fd);
  }
  return root;
}

const shot = (page, name) =>
  page.screenshot({ path: join(OUT, name), fullPage: false }).then(() => console.log('  wrote', name));

async function main() {
  mkdirSync(OUT, { recursive: true });
  const root = buildTree();
  const { server, token } = createReorgServer({ root, allowApply: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2, // retina: the UI is dense, and 1x makes the type mushy
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  await page.goto(`${base}/?token=${token}`);
  await page.waitForSelector('.row');

  // The root label is a temp path; swap it for something that reads like a real
  // one. Cosmetic only -- everything else in the shot is genuine output.
  await page.evaluate(() => {
    const el = document.querySelector('#rootLabel');
    if (el) el.textContent = '~/Downloads';
  });

  console.log('capturing into', OUT);

  // 1. The planner mid-edit: a plan in progress, so the badges and footer counts
  //    are populated and the reader can see what the tool is for.
  await page.evaluate(async () => {
    const edit = await import('/lib/plan-edit.js');
    edit.addDir('.');
    const { store } = await import('/lib/store.js');
    const created = [...store.nodes.values()].find((n) => !n.orig);
    edit.renameNode(created.id, 'archive');
    edit.moveNode('project-backup-20260415', created.id);
    edit.moveNode('Docker.dmg', created.id);
    edit.toggleEvict('scratch.log');
    edit.toggleEvict('old-notes-presync.txt');
    edit.toggleCollapse('node-v24.18.0-darwin-arm64');
    // plan-edit.js is deliberately DOM-free, so nothing above repaints on its own.
    // markDirty() is what app.js calls after a real edit: it re-renders and kicks
    // the debounced save, which is exactly the state a mid-edit screenshot wants.
    const app = await import('/app.js');
    app.markDirty();
  });
  await page.waitForTimeout(500);
  await shot(page, 'planner.png');

  // 2. Triage: the panel that ranks disposable entries and says why. This is the
  //    most distinctive screen, so it gets its own image.
  await page.evaluate(async () => {
    const side = await import('/lib/side.js');
    side.showTriage();
  });
  await page.waitForTimeout(600);
  await shot(page, 'triage.png');

  // 3. Review: the resolved operations, which is the safety story in one frame --
  //    exactly what will happen, before anything happens.
  await page.evaluate(async () => {
    const side = await import('/lib/side.js');
    side.showReview();
  });
  await page.waitForTimeout(900);
  await shot(page, 'review.png');

  await browser.close();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
