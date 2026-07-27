// Harness for the browser tests: a real reorg server over a real temp directory,
// driven by a real Chromium.
//
// Nothing here is stubbed, because the whole point of this layer is the things a
// fake DOM cannot answer: whether a drop lands in the third of the row the user
// aimed at, whether a keypress reaches its handler, whether the page the server
// actually serves boots. jsdom returns zeros from getBoundingClientRect, so the
// drop-zone geometry -- the most error-prone code in web/ -- would be untestable.

import { chromium } from 'playwright';
import { createReorgServer } from '../src/server.js';
import { sandbox, cleanup } from './helpers.js';

let browser = null;

/** One browser for the whole file; contexts are cheap, launches are not. */
export async function getBrowser() {
  if (!browser) browser = await chromium.launch();
  return browser;
}

export async function closeBrowser() {
  if (browser) await browser.close();
  browser = null;
}

/**
 * Boot a planner against `layout` and hand back a page plus helpers.
 *
 * opts.allowApply   let the browser apply (default false, matching the CLI)
 * opts.colorScheme  emulate an OS theme preference
 */
export async function planner(layout, opts = {}) {
  const root = sandbox(layout);
  const { server, token } = createReorgServer({ root, allowApply: !!opts.allowApply });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;

  const b = await getBrowser();
  const context = await b.newContext({
    colorScheme: opts.colorScheme || 'dark',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  // Any uncaught page error is a test failure wherever it happens: a planner that
  // throws mid-render can still look right in a snapshot.
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(`${base}/?token=${token}`);
  await page.waitForSelector('.row', { timeout: 10000 });

  return {
    root,
    page,
    token,
    base,
    errors,

    /** The plan as the server has it -- what would actually be applied. */
    async savedPlan() {
      const res = await page.request.get(`${base}/api/tree?token=${token}`);
      return (await res.json()).plan;
    },

    /** Resolve the current in-page plan into operations, without touching disk. */
    async resolved() {
      return page.evaluate(async () => {
        const { store } = await import('/lib/store.js');
        const { api } = await import('/lib/api.js');
        return api.post('/api/resolve', { plan: store.serialize() });
      });
    },

    /** The client model's view of one node, for asserting an edit landed. */
    async node(id) {
      return page.evaluate(async (nodeId) => {
        const { store } = await import('/lib/store.js');
        const n = store.nodes.get(nodeId);
        return n ? { id: n.id, name: n.cur.name, parentId: n.cur.parentId, evicted: n.evicted, collapsed: n.collapsed } : null;
      }, id);
    },

    /** Wait out the 350ms save debounce so a persisted assertion is not racing it. */
    async settled() {
      await page.waitForFunction(
        () => !document.querySelector('.savestate')?.classList.contains('dirty'),
        null,
        { timeout: 5000 }
      );
    },

    async close() {
      await context.close();
      await new Promise((done) => server.close(done));
      cleanup(root);
    },
  };
}

/**
 * Drag `srcId` onto `targetId`, aiming at a specific zone.
 *
 * zone: 'into'   the middle third of a directory row
 *       'before' the top edge
 *       'after'  the bottom edge
 *
 * Real mouse movement rather than a synthetic DragEvent: the zone is computed from
 * clientY against the row's box, so the pointer path is the thing under test. The
 * intermediate move matters -- HTML5 drag needs a dragover before the drop for the
 * zone to be registered at all.
 */
export async function dragRow(page, srcId, targetId, zone = 'into') {
  const src = page.locator(`.row[data-id="${cssEscape(srcId)}"]`);
  const tgt = page.locator(`.row[data-id="${cssEscape(targetId)}"]`);
  const sBox = await src.boundingBox();
  const tBox = await tgt.boundingBox();
  if (!sBox || !tBox) throw new Error(`row not visible: ${srcId} -> ${targetId}`);

  const y =
    zone === 'into'
      ? tBox.y + tBox.height / 2
      : zone === 'before'
        ? tBox.y + tBox.height * 0.1
        : tBox.y + tBox.height * 0.9;

  await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(tBox.x + tBox.width / 2, y, { steps: 12 });
  await page.mouse.move(tBox.x + tBox.width / 2, y); // settle, so dragover fires at the final y
  await page.mouse.up();
}

/** CSS.escape for attribute selectors built from node ids, which contain slashes. */
export function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

/** Select a row by clicking it, so keyboard commands have a target. */
export async function selectRow(page, id) {
  await page.locator(`.row[data-id="${cssEscape(id)}"]`).click();
  await page.waitForFunction(
    (nodeId) => document.querySelector(`.row.sel[data-id="${nodeId.replace(/["\\]/g, '\\$&')}"]`) !== null,
    id,
    { timeout: 3000 }
  );
}
