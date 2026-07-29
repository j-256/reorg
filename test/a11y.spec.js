// Enhanced contrast regression tests
//
// The dim end of the palette failed contrast checks once already -- six text styles
// between 2.34 and 3.10 -- and it failed invisibly, because "looks a bit faint" is
// not a thing anyone reliably notices in review. This measures it instead, so the
// next tweak to a colour variable cannot quietly undo the fix
//
// Contrast is computed against the COMPOSITED background rather than the nearest
// declared one. That distinction is not pedantry: several surfaces here are tinted
// with color-mix at 18% alpha, and measuring text against the raw rgba of a
// translucent layer produces false failures. Getting this wrong during the original
// audit reported a passing button as 2.77

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { planner, closeBrowser } from './ui-harness.js';

after(closeBrowser);

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

const TREE = {
  'keep.txt': 'keep me',
  'notes.md': 'notes',
  'docs/note.md': '# note',
  'old-backup/junk.log': 'junk',
};

/**
 * Sweep every element with its own text and return those below the WCAG AAA
 * enhanced threshold: 7:1 for normal text, 4.5:1 for large text
 */
const SWEEP = `(() => {
  const lum = ([r, g, b]) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  // Handles rgb(), rgba(), and color(srgb r g b / a) -- the last is what color-mix
  // computes to, with 0-1 channels rather than 0-255.
  const toRgba = (s) => {
    const n = (s.match(/-?\\d*\\.?\\d+(e-?\\d+)?/g) || []).map(Number);
    if (s.startsWith('color(')) return [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1];
    return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1];
  };
  // Composite each translucent layer over the first opaque ancestor, in paint order.
  const effectiveBg = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = toRgba(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let out = layers.length ? layers[layers.length - 1].slice(0, 3) : [255, 255, 255];
    for (let i = layers.length - 2; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
    }
    return out;
  };
  const fails = [];
  const seen = new Set();
  let checked = 0;
  for (const el of document.querySelectorAll('*')) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!own) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.5) continue;
    if (el.closest(':disabled, [aria-disabled="true"]')) continue;
    const bg = effectiveBg(el);
    const key = cs.color + '|' + cs.fontSize + '|' + bg.map(Math.round).join(',') + '|' + (el.className || el.tagName);
    if (seen.has(key)) continue;
    seen.add(key);
    checked++;
    const f = toRgba(cs.color);
    const fg = f[3] >= 1 ? f.slice(0, 3) : [f[0] * f[3] + bg[0] * (1 - f[3]), f[1] * f[3] + bg[1] * (1 - f[3]), f[2] * f[3] + bg[2] * (1 - f[3])];
    const a = lum(fg), b = lum(bg);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    const ratio = +(((hi + 0.05) / (lo + 0.05))).toFixed(2);
    const px = parseFloat(cs.fontSize);
    const need = (px >= 24 || (parseInt(cs.fontWeight) >= 700 && px >= 18.67)) ? 4.5 : 7;
    if (ratio < need) fails.push({ cls: String(el.className || el.tagName.toLowerCase()).slice(0, 30), px, ratio, need, sample: own.slice(0, 30) });
  }
  return { checked, fails };
})()`;

/** Put the page into a state where the coloured styles are actually on screen. */
async function populate(p) {
  await p.page.evaluate(async () => {
    const edit = await import('/lib/plan-edit.js');
    const { store } = await import('/lib/store.js');
    // A plan in progress, so change badges and delta chips render in their variants.
    edit.moveNode('keep.txt', 'docs');
    edit.renameNode('notes.md', 'renamed.md');
    store.nodes.get('old-backup').evicted = true;
    store.nodes.get('old-backup/junk.log').evicted = true;
    document.body.classList.add('git-on'); // git tints apply to text, so they count
  });
}

const PANELS = ['help', 'notes', 'triage', 'review'];

async function openPanel(p, name) {
  await p.page.evaluate(async (panel) => {
    const side = await import('/lib/side.js');
    if (panel === 'help') side.showHelp();
    else if (panel === 'notes') side.showNotes();
    else if (panel === 'triage') side.showTriage();
    else side.showReview();
  }, name);
  await p.page.waitForSelector('#sidePane .pane-head', { timeout: 5000 });
  // Review resolves server-side, so give the panel a beat to fill in.
  await p.page.waitForTimeout(200);
}

for (const scheme of ['dark', 'light']) {
  test(`${scheme} theme: the main view meets WCAG AAA enhanced contrast`, async () => {
    const p = await planner(TREE, { colorScheme: scheme });
    try {
      await populate(p);
      const { checked, fails } = await p.page.evaluate(SWEEP);
      assert.ok(checked > 15, `expected a meaningful sweep, only checked ${checked}`);
      assert.deepEqual(fails, [], `contrast failures in ${scheme}:\n${JSON.stringify(fails, null, 2)}`);
    } finally {
      await p.close();
    }
  });

  test(`${scheme} theme: every side panel meets WCAG AAA enhanced contrast`, async () => {
    const p = await planner(TREE, { colorScheme: scheme });
    try {
      await populate(p);
      for (const panel of PANELS) {
        await openPanel(p, panel);
        const { fails } = await p.page.evaluate(SWEEP);
        assert.deepEqual(fails, [], `contrast failures in ${scheme}/${panel}:\n${JSON.stringify(fails, null, 2)}`);
      }
    } finally {
      await p.close();
    }
  });
}

test('an explicitly forced theme is audited too, not just the OS-driven one', async () => {
  // The light palette exists twice -- once under prefers-color-scheme and once under
  // [data-theme=light] -- so a fix applied to only one copy would pass the tests
  // above while leaving the toolbar override broken.
  const p = await planner(TREE, { colorScheme: 'dark' });
  try {
    await populate(p);
    await p.page.locator('.btn[data-theme-btn]').click(); // auto -> dark
    await p.page.locator('.btn[data-theme-btn]').click(); // dark -> light
    assert.equal(await p.page.getAttribute('html', 'data-theme'), 'light');
    // .btn transitions colour over .12s, so sampling immediately reads a value
    // part-way between the two palettes -- a false failure, not a real one.
    await p.page.waitForTimeout(250);

    const { fails } = await p.page.evaluate(SWEEP);
    assert.deepEqual(fails, [], `forced-light contrast failures:\n${JSON.stringify(fails, null, 2)}`);
  } finally {
    await p.close();
  }
});

test('the focus ring is visible on a keyboard-focused control', async () => {
  // Keyboard users need to see where they are; a focus style that renders as nothing
  // is an accessibility failure that no contrast sweep would catch.
  const p = await planner(TREE);
  try {
    await p.page.keyboard.press('Tab');
    const ring = await p.page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { tag: el.tagName, outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle };
    });
    assert.ok(ring, 'Tab moved focus to a control');
    assert.notEqual(ring.outlineStyle, 'none', 'the focused control draws an outline');
    assert.ok(parseFloat(ring.outlineWidth) > 0, 'the outline has width');
  } finally {
    await p.close();
  }
});

test('every actionable control has an accessible name', async () => {
  const p = await planner(TREE);
  try {
    const unnamed = await p.page.$$eval('button, input, [role="button"]', (els) =>
      els
        .filter((e) => {
          const cs = getComputedStyle(e);
          if (cs.display === 'none' || cs.visibility === 'hidden') return false;
          const name = (e.getAttribute('aria-label') || e.title || e.textContent || e.getAttribute('placeholder') || '').trim();
          return !name;
        })
        .map((e) => e.outerHTML.slice(0, 80))
    );
    assert.deepEqual(unnamed, [], 'controls with no discernible name');
  } finally {
    await p.close();
  }
});

async function axeViolations(p) {
  await p.page.addScriptTag({ path: AXE_PATH });
  return p.page.evaluate(async () => {
    const baseline = await axe.run(document, { resultTypes: ['violations'] });
    const enhanced = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2aaa'] },
      resultTypes: ['violations'],
    });
    const violations = new Map([...baseline.violations, ...enhanced.violations].map((violation) => [violation.id, violation]));
    return [...violations.values()].map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target),
    }));
  });
}

test('automated accessibility rules, including available AAA rules, pass in every view', async () => {
  const p = await planner(TREE);
  try {
    assert.deepEqual(await axeViolations(p), [], 'main view violations');
    for (const panel of PANELS) {
      await openPanel(p, panel);
      assert.deepEqual(await axeViolations(p), [], `${panel} panel violations`);
    }
  } finally {
    await p.close();
  }
});

test('the narrow single-pane layout passes automated accessibility rules', async () => {
  const p = await planner(TREE, { viewport: { width: 320, height: 800 } });
  try {
    await openPanel(p, 'triage');
    assert.deepEqual(await axeViolations(p), []);
  } finally {
    await p.close();
  }
});

test('the document has useful landmarks and a roving keyboard tree', async () => {
  const p = await planner(TREE);
  try {
    assert.equal(await p.page.locator('main').count(), 1);
    assert.equal(await p.page.getByRole('heading', { level: 1 }).count(), 1);
    assert.equal(await p.page.getByRole('tree', { name: 'Planned directory tree' }).count(), 1);
    assert.ok(await p.page.getByRole('treeitem').count());
    assert.equal(await p.page.locator('[role="treeitem"][tabindex="0"]').count(), 1);
    assert.equal(await p.page.locator('#sidePane').isVisible(), false);
    assert.equal(await p.page.locator('#resizer').getAttribute('tabindex'), '-1');

    await p.page.getByRole('button', { name: 'review plan', exact: true }).click();
    await p.page.waitForSelector('#sidePane:not([hidden])');
    assert.equal(await p.page.locator('#resizer').getAttribute('tabindex'), '0');
  } finally {
    await p.close();
  }
});

test('visible controls meet the WCAG 2.2 minimum target size', async () => {
  const p = await planner(TREE);
  try {
    await openPanel(p, 'triage');
    const tooSmall = await p.page.$$eval('button, input, select, [role="treeitem"]', (controls) =>
      controls
        .filter((control) => {
          const style = getComputedStyle(control);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const box = control.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && (box.width < 24 || box.height < 24);
        })
        .map((control) => {
          const box = control.getBoundingClientRect();
          return {
            name: control.getAttribute('aria-label') || control.textContent.trim().slice(0, 30),
            width: Math.round(box.width),
            height: Math.round(box.height),
          };
        })
    );
    assert.deepEqual(tooSmall, []);
  } finally {
    await p.close();
  }
});
