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
import { mkdirSync, mkdtempSync, rmSync, openSync, writeSync, closeSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReorgServer } from '../src/server.js';

const OUT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
// Height is tuned so the tree content fills the frame: the demo tree runs to about
// 560px, and a taller viewport just adds dead space below the last row that a
// reader has to scroll past in the README.
const VIEWPORT = { width: 1280, height: 800 };

/* A directory that looks like a real one people actually have. The point of the
   screenshots is to show the tool earning its keep, and it cannot do that against
   five files totalling 8 bytes: the triage panel needs names worth flagging, the
   heat bars need a size spread, and the tree needs enough depth that collapsing
   means something.

   [bytes, ageInDays]. The ages are not decoration -- they reproduce the finding the
   ranking is built on, so the screenshots demonstrate it instead of the README
   having to assert it separately:

     - the junk is NEW. project-backup-20260415 and scratch.log are days old, so an
       age sort would rank them as active work and bury them.
     - the keepers are OLD. notes.md, todo.txt and the receipts are the things you
       would lose by sorting on mtime, at hundreds of days.

   A reader can now see "0d old" next to a flagged backup and "586d old" next to a
   file nothing flags, which is the whole argument in one frame. */
const TREE = {
  'Screenshot 2026-03-14 at 10.21.44.png': [220_000, 135],
  'Screenshot 2026-04-02 at 16.03.11.png': [310_000, 116],
  'invoice-march.pdf': [84_000, 141],
  'invoice-april.pdf': [91_000, 110],
  'notes.md': [2_400, 586],
  'todo.txt': [800, 402],

  'node-v24.18.0-darwin-arm64.tar.gz': [48_000_000, 34],
  'node-v24.18.0-darwin-arm64/README.md': [1_200, 34],
  'node-v24.18.0-darwin-arm64/bin/node': [92_000_000, 34],

  'project-backup-20260415/src/index.js': [4_100, 12],
  'project-backup-20260415/src/util.js': [2_800, 12],
  'project-backup-20260415/package.json': [640, 12],

  'project/src/index.js': [4_400, 2],
  'project/src/util.js': [2_800, 5],
  'project/src/api/client.js': [6_200, 1],
  'project/src/api/types.js': [1_900, 9],
  'project/package.json': [700, 21],
  'project/README.md': [3_300, 21],

  'receipts/2026-01.pdf': [61_000, 208],
  'receipts/2026-02.pdf': [58_000, 177],
  'receipts/2026-03.pdf': [64_000, 149],

  'Docker.dmg': [620_000_000, 73],
  'old-notes-presync.txt': [1_100, 9],
  'scratch.log': [240_000, 3],

  // Deliberate near-misses, present so the panel can be seen DECLINING to flag
  // them. Both contain a marker word in a non-trailing position -- one is a
  // document about backups, the other is actual mail -- and both were real false
  // positives before the position rule went in. A candidate list cannot show
  // restraint by itself; it needs the things it passed over to be on screen.
  'backup-strategy-notes.md': [4_800, 233],
  'all-mail-including-spam-and-trash.mbox': [3_100_000_000, 512],
};

const DAY_MS = 24 * 60 * 60 * 1000;

function buildTree() {
  const root = mkdtempSync(join(tmpdir(), 'reorg-shots-'));
  const now = Date.now();
  const dirAges = new Map(); // dir path -> oldest age seen beneath it

  for (const [rel, [size, ageDays]] of Object.entries(TREE)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    // Sparse: seek to size-1 and write one byte, so the file REPORTS its declared
    // size without the script writing hundreds of megabytes. The byte columns and
    // heat bars are driven by stat(), so this is indistinguishable in the UI.
    const fd = openSync(abs, 'w');
    if (size > 0) writeSync(fd, Buffer.from([0x20]), 0, 1, size - 1);
    closeSync(fd);
    const t = new Date(now - ageDays * DAY_MS);
    utimesSync(abs, t, t);

    // Record the age each ancestor should end up with. A directory's own mtime is
    // when its shape last changed, so the natural reading is the newest thing in
    // it -- that is what a real tree would show.
    for (let d = dirname(abs); d.startsWith(root) && d !== root; d = dirname(d)) {
      const prev = dirAges.get(d);
      if (prev === undefined || ageDays < prev) dirAges.set(d, ageDays);
    }
  }

  // Deepest first: writing a file into a directory bumps that directory's mtime,
  // so parents have to be stamped after everything beneath them is final.
  for (const dir of [...dirAges.keys()].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const t = new Date(now - dirAges.get(dir) * DAY_MS);
    utimesSync(dir, t, t);
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

  // 2. Move: create one missing destination, then show that the same control can
  //    immediately extend it with another nested folder
  await page.evaluate(async () => {
    const app = await import('/app.js');
    app.openMoveDialog('invoice-april.pdf');
  });
  await page.locator('#moveTarget').selectOption({ label: 'archive' });
  await page.locator('#moveCreateName').fill('invoices');
  await page.getByRole('button', { name: 'Create and select' }).click();
  await page.locator('#moveCreateName').fill('2026');
  await page.waitForTimeout(250);
  await shot(page, 'move.png');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#moveDialog')?.open);
  await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('show'));

  // 3. Triage: the panel that ranks disposable entries and says why
  await page.evaluate(async () => {
    const side = await import('/lib/side.js');
    side.showTriage();
  });
  await page.waitForTimeout(600);
  await shot(page, 'triage.png');

  // 4. Review: the resolved operations, which is the safety story in one frame
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
