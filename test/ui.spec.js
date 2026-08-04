// Browser tests for the planner.
//
// Separate from the *.test.js suites and run by `npm run test:ui`, because these
// need a Chromium and those deliberately need nothing. What lives here is only what
// a fake DOM cannot answer:
//
//   - drop-zone geometry, which is computed from clientY against the row's box
//   - whether events actually reach their handlers
//   - whether the page the server really serves boots and renders
//   - contrast, which requires the browser's own compositing to measure
//
// Anything assertable without layout belongs in store.test.js instead.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planner, dragRow, selectRow, closeBrowser } from './ui-harness.js';

after(closeBrowser);

const CLI = new URL('../bin/reorg', import.meta.url);

function runCliJson(args, input = undefined) {
  const result = spawnSync(process.execPath, [CLI.pathname, ...args, '--json'], {
    encoding: 'utf8',
    input,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const TREE = {
  'keep.txt': 'keep me',
  'notes.md': 'notes',
  'docs/note.md': '# note',
  'docs/deep/inner.txt': 'inner',
  'old-backup/junk.log': 'junk',
};

/* ---------------------------------------------------------------- boot */

test('the served page boots and renders the tree without errors', async () => {
  const p = await planner(TREE);
  try {
    assert.equal(await p.page.locator('.row').count(), 7, 'every scanned entry gets a row');
    assert.match(await p.page.locator('#rootLabel').textContent(), /reorg-test-/);
    assert.match(await p.page.locator('#treeHint').textContent(), /8 entries/);
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test('nothing is marked as changed on a fresh scan', async () => {
  const p = await planner(TREE);
  try {
    assert.equal(await p.page.locator('.row.changed, .row .badge').count(), 0);
    const { ops } = await p.resolved();
    assert.deepEqual(ops, []);
  } finally {
    await p.close();
  }
});

test('plan-only scope and unavailable filters are explicit on first load', async () => {
  const p = await planner(TREE);
  try {
    assert.match(await p.page.locator('#scopeBanner').textContent(), /planning only/i);
    assert.match(await p.page.locator('#scopeBanner').textContent(), /files stay on disk/i);
    assert.equal(await p.page.locator('#sidePane').getAttribute('hidden'), '');

    const disabled = await p.page.$$eval('#delta button[disabled]', (buttons) =>
      buttons.map((button) => button.textContent.trim())
    );
    assert.deepEqual(disabled, ['0 moved', '0 renamed', '0 new', '0 trashed']);

    const centers = await p.page.$$eval('#delta > .chip', (chips) =>
      chips.map((chip) => {
        const box = chip.getBoundingClientRect();
        return box.top + box.height / 2;
      })
    );
    assert.ok(Math.max(...centers) - Math.min(...centers) < 1, 'all summary chips share a visual baseline');
  } finally {
    await p.close();
  }
});

test('new folder is always available and can create at the top level', async () => {
  const p = await planner(TREE);
  try {
    const open = p.page.getByRole('button', { name: 'new folder\u2026', exact: true });
    assert.equal(await open.count(), 1);
    await open.click();
    await p.page.waitForSelector('#createFolderDialog[open]');
    assert.equal(await p.page.locator('#createFolderParent').inputValue(), '.');
    await p.page.waitForFunction(() => document.activeElement?.id === 'createFolderName');

    await p.page.locator('#createFolderName').fill('archive');
    await p.page.getByRole('button', { name: 'Create folder', exact: true }).click();
    await p.page.waitForSelector('.row[data-id^="new:"]');

    const created = await p.page.evaluate(async () => {
      const { store } = await import('/lib/store.js');
      const node = [...store.nodes.values()].find((candidate) => !candidate.orig);
      return { id: node.id, name: node.cur.name, parentId: node.cur.parentId };
    });
    assert.equal(created.name, 'archive');
    assert.equal(created.parentId, '.');
    assert.equal(await p.page.locator('[role="treeitem"][aria-selected="true"]').getAttribute('data-id'), created.id);
    assert.equal(await p.page.evaluate(() => document.activeElement?.dataset.id), created.id);
    assert.match(await p.page.locator('#toast').textContent(), /nothing was created on disk/i);
  } finally {
    await p.close();
  }
});

test('new folder defaults to the selected context and validates before planning', async () => {
  const p = await planner(TREE);
  try {
    await selectRow(p.page, 'docs');
    await p.page.getByRole('button', { name: 'new folder\u2026', exact: true }).click();
    assert.equal(await p.page.locator('#createFolderParent').inputValue(), 'docs');

    const name = p.page.locator('#createFolderName');
    const confirm = p.page.getByRole('button', { name: 'Create folder', exact: true });
    await name.fill('note.md');
    assert.equal(await confirm.isDisabled(), true);
    assert.match(await p.page.locator('#createFolderError').textContent(), /already exists/i);

    await name.fill('bad/name');
    assert.equal(await confirm.isDisabled(), true);
    assert.match(await p.page.locator('#createFolderError').textContent(), /one folder name/i);

    await name.fill('archive');
    assert.equal(await confirm.isEnabled(), true);
    await p.page.keyboard.press('Escape');

    await selectRow(p.page, 'docs/note.md');
    assert.equal(
      await p.page.getByRole('button', { name: 'New folder alongside\u2026', exact: true }).count(),
      1
    );
    await p.page.getByRole('button', { name: 'new folder\u2026', exact: true }).click();
    assert.equal(await p.page.locator('#createFolderParent').inputValue(), 'docs');
  } finally {
    await p.close();
  }
});

test('directories omitted from the scan disclose that their contents are unavailable', async () => {
  const p = await planner({ 'keep.txt': 'keep', 'node_modules/pkg/index.js': 'module' });
  try {
    const row = p.page.locator('.row[data-id="node_modules"]');
    assert.match(await row.locator('.tag.limited').textContent(), /contents not loaded/i);
    const disclosure = row.locator('.twist');
    assert.equal(await disclosure.isDisabled(), true);
    assert.match(await disclosure.getAttribute('aria-label'), /restart with --all/i);
    await row.click();
    await p.page.keyboard.press('Enter');
    assert.match(await p.page.locator('#toast').textContent(), /summarized during the scan/i);
  } finally {
    await p.close();
  }
});

test('one toolbar click opens and identifies a panel, and the next closes it', async () => {
  const p = await planner(TREE);
  try {
    const cleanup = p.page.getByRole('button', { name: 'cleanup', exact: true });
    await cleanup.click();
    await p.page.waitForSelector('#sidePane:not([hidden])');
    assert.equal(await cleanup.getAttribute('aria-expanded'), 'true');
    assert.match(await p.page.locator('#sideTitle').textContent(), /cleanup candidates/i);
    await p.page.waitForFunction(() => document.activeElement?.id === 'sideTitle');

    await cleanup.click();
    await p.page.waitForFunction(() => document.querySelector('#sidePane')?.hasAttribute('hidden'));
    assert.equal(await cleanup.getAttribute('aria-expanded'), 'false');
    await p.page.waitForFunction(() => document.activeElement?.dataset.panel === 'triage');
  } finally {
    await p.close();
  }
});

test('one folder click exposes plainly labeled selection actions', async () => {
  const p = await planner(TREE);
  try {
    await p.page.locator('.row[data-id="docs"]').click();
    assert.match(await p.page.locator('.selection-label').textContent(), /selected:\s*docs/i);
    for (const name of ['Rename', 'Move\u2026', 'New folder inside\u2026', 'Add note', 'Trash']) {
      assert.equal(await p.page.getByRole('button', { name, exact: true }).count(), 1, `${name} is available`);
    }
  } finally {
    await p.close();
  }
});

/* ---------------------------------------------------------------- drag geometry */
// The reason this file exists. dropZone() splits a row into thirds: the middle
// third of a directory means "into", the outer thirds mean "become a sibling".
// jsdom reports every box as zero-sized, so none of this is reachable there.

test('dropping on the middle of a folder moves into it', async () => {
  const p = await planner(TREE);
  try {
    await dragRow(p.page, 'keep.txt', 'docs', 'into');
    const n = await p.node('keep.txt');
    assert.equal(n.parentId, 'docs');

    const { script, problems } = await p.resolved();
    assert.deepEqual(problems, []);
    assert.deepEqual(script, ['mv     keep.txt  ->  docs/keep.txt']);
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test('dropping on the top edge makes it a sibling, not a child', async () => {
  // The distinction the thirds exist for: same target row, different intent, and
  // getting it wrong silently files things one level deeper than the user meant.
  const p = await planner(TREE);
  try {
    await dragRow(p.page, 'keep.txt', 'docs', 'before');
    const n = await p.node('keep.txt');
    assert.equal(n.parentId, '.', 'a sibling of docs stays at the root');
    const { ops } = await p.resolved();
    assert.deepEqual(ops, [], 'already a sibling, so this is a no-op rather than a move');
  } finally {
    await p.close();
  }
});

test('dropping on the bottom edge is also a sibling', async () => {
  const p = await planner(TREE);
  try {
    await dragRow(p.page, 'notes.md', 'docs', 'after');
    assert.equal((await p.node('notes.md')).parentId, '.');
  } finally {
    await p.close();
  }
});

test('a file row has no "into" zone, so a drop on it becomes a sibling', async () => {
  // dropZone() only returns 'into' for a directory; the middle of a file row must
  // fall through to before/after rather than nesting a file inside a file.
  const p = await planner(TREE);
  try {
    await dragRow(p.page, 'keep.txt', 'notes.md', 'into');
    const n = await p.node('keep.txt');
    assert.equal(n.parentId, '.', 'never parented to a file');
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test('a folder refuses to be dropped inside its own descendant', async () => {
  const p = await planner(TREE);
  try {
    // docs is expanded at boot (only depth >= 1 starts collapsed), so docs/deep is
    // already on screen and draggable onto.
    await dragRow(p.page, 'docs', 'docs/deep', 'into');

    assert.equal((await p.node('docs')).parentId, '.', 'the move was refused');
    assert.match(await p.page.locator('#toast').textContent(), /inside itself/i);
    const { ops } = await p.resolved();
    assert.deepEqual(ops, []);
  } finally {
    await p.close();
  }
});

test('a drag into a collapsed folder expands it, so the result is visible', async () => {
  const p = await planner(TREE);
  try {
    // docs/deep starts collapsed, being below the top level.
    assert.equal((await p.node('docs/deep')).collapsed, true, 'precondition: target is collapsed');
    await dragRow(p.page, 'keep.txt', 'docs/deep', 'into');

    assert.equal((await p.node('keep.txt')).parentId, 'docs/deep', 'the move landed');
    assert.equal((await p.node('docs/deep')).collapsed, false, 'the target opens to show what landed in it');
    await p.page.waitForFunction(
      () => [...document.querySelectorAll('.row')].some((r) => r.dataset.id === 'keep.txt' && r.closest('li')?.parentElement?.closest('li')),
      null,
      { timeout: 5000 }
    );
  } finally {
    await p.close();
  }
});

/* ---------------------------------------------------------------- keyboard */

test('Delete marks the selection for trash and cascades to its contents', async () => {
  const p = await planner(TREE);
  try {
    await selectRow(p.page, 'old-backup');
    await p.page.keyboard.press('Delete');

    assert.equal((await p.node('old-backup')).evicted, true);
    assert.equal((await p.node('old-backup/junk.log')).evicted, true, 'contents come with it');

    const { script, problems } = await p.resolved();
    assert.deepEqual(problems, [], 'a cascaded trash resolves cleanly');
    assert.deepEqual(script, ['trash  old-backup']);
  } finally {
    await p.close();
  }
});

test('Delete twice restores, leaving no pending change', async () => {
  const p = await planner(TREE);
  try {
    await selectRow(p.page, 'old-backup');
    await p.page.keyboard.press('Delete');
    await p.page.keyboard.press('Delete');
    assert.equal((await p.node('old-backup')).evicted, false);
    assert.equal((await p.node('old-backup/junk.log')).evicted, false);
    const { ops } = await p.resolved();
    assert.deepEqual(ops, []);
  } finally {
    await p.close();
  }
});

test('F2 renames in place and Enter commits', async () => {
  const p = await planner(TREE);
  try {
    await selectRow(p.page, 'keep.txt');
    await p.page.keyboard.press('F2');
    // F2 puts the .name span into contenteditable and selects its contents, so
    // typing replaces the name without needing a select-all first.
    await p.page.keyboard.type('renamed.txt');
    await p.page.keyboard.press('Enter');

    assert.equal((await p.node('keep.txt')).name, 'renamed.txt');
    const { script } = await p.resolved();
    assert.deepEqual(script, ['mv     keep.txt  ->  renamed.txt']);
  } finally {
    await p.close();
  }
});

test('Escape abandons a rename and restores the original name', async () => {
  const p = await planner(TREE);
  try {
    await selectRow(p.page, 'keep.txt');
    await p.page.keyboard.press('F2');
    await p.page.keyboard.type('abandoned');
    await p.page.keyboard.press('Escape');

    assert.equal((await p.node('keep.txt')).name, 'keep.txt');
    assert.equal(await p.page.locator('.row[data-id="keep.txt"] .name').textContent(), 'keep.txt');
    const { ops } = await p.resolved();
    assert.deepEqual(ops, []);
  } finally {
    await p.close();
  }
});

test('a rename to a path-breaking name is refused and warned about', async () => {
  const p = await planner(TREE);
  try {
    await selectRow(p.page, 'keep.txt');
    await p.page.keyboard.press('F2');
    await p.page.keyboard.type('bad/name');
    await p.page.keyboard.press('Enter');

    assert.equal((await p.node('keep.txt')).name, 'keep.txt', 'the model is untouched');
    assert.match(await p.page.locator('#toast').textContent(), /cannot contain/i);
    assert.equal(
      await p.page.locator('.row[data-id="keep.txt"] .name').textContent(),
      'keep.txt',
      'the field reverts too, rather than showing a name that was not accepted'
    );
  } finally {
    await p.close();
  }
});

test('n creates a folder inside the selected directory', async () => {
  const p = await planner(TREE);
  try {
    await selectRow(p.page, 'docs');
    await p.page.keyboard.press('n');
    await p.page.waitForSelector('#createFolderDialog[open]');
    assert.equal(await p.page.locator('#createFolderParent').inputValue(), 'docs');
    await p.page.locator('#createFolderName').fill('research');
    await p.page.keyboard.press('Enter');
    await p.page.waitForSelector('.row[data-id^="new:"]');

    const created = await p.page.evaluate(async () => {
      const { store } = await import('/lib/store.js');
      const n = [...store.nodes.values()].find((x) => !x.orig);
      return { id: n.id, parentId: n.cur.parentId, name: n.cur.name };
    });
    assert.equal(created.parentId, 'docs');
    assert.equal(created.name, 'research');
  } finally {
    await p.close();
  }
});

test('arrow keys move the selection, and right/left expand and collapse', async () => {
  const p = await planner(TREE);
  try {
    await selectRow(p.page, 'docs');
    assert.equal((await p.node('docs')).collapsed, false, 'top-level folders start expanded');

    await p.page.keyboard.press('ArrowLeft');
    assert.equal((await p.node('docs')).collapsed, true, 'left collapses an open folder');

    await p.page.keyboard.press('ArrowRight');
    assert.equal((await p.node('docs')).collapsed, false, 'right reopens it');

    await p.page.keyboard.press('ArrowDown');
    const sel = await p.page.locator('.row.sel').getAttribute('data-id');
    assert.notEqual(sel, 'docs', 'the selection moved off docs');
  } finally {
    await p.close();
  }
});

test('the tree is usable from the keyboard before any row is clicked', async () => {
  const p = await planner(TREE);
  try {
    await p.page.locator('#tree').focus();
    await p.page.keyboard.press('Tab');
    assert.equal(await p.page.evaluate(() => document.activeElement?.getAttribute('role')), 'treeitem');
    assert.ok(await p.page.locator('[role="treeitem"][aria-selected="true"]').count());

    await p.page.keyboard.press('ArrowDown');
    const selected = await p.page.locator('[role="treeitem"][aria-selected="true"]').getAttribute('data-id');
    assert.ok(selected);

    await p.page.keyboard.press('m');
    await p.page.waitForSelector('#moveDialog[open]');
    assert.match(await p.page.locator('#moveName').textContent(), new RegExp(selected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await p.page.keyboard.press('Escape');
  } finally {
    await p.close();
  }
});

test('Shift+F10 opens a keyboard-operable action menu', async () => {
  const p = await planner(TREE);
  try {
    await selectRow(p.page, 'docs');
    await p.page.keyboard.press('Shift+F10');
    await p.page.waitForSelector('[role="menu"]');
    assert.equal(await p.page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem');
    assert.ok(
      (await p.page.getByRole('menuitem').allTextContents()).some((label) => /new folder inside/i.test(label)),
      'the context menu repeats folder creation where it is useful'
    );
    await p.page.keyboard.press('ArrowDown');
    assert.match(await p.page.evaluate(() => document.activeElement?.textContent), /move to another folder/i);
    await p.page.keyboard.press('Escape');
    assert.equal(await p.page.locator('[role="menu"]').count(), 0);
    assert.equal(await p.page.evaluate(() => document.activeElement?.getAttribute('role')), 'treeitem');
  } finally {
    await p.close();
  }
});

test('switching context menus works on the first right-click', async () => {
  const p = await planner(TREE);
  try {
    await p.page.locator('.row[data-id="notes.md"]').click({ button: 'right' });
    await p.page.waitForSelector('[role="menu"]');
    await p.page.locator('.row[data-id="docs"]').click({ button: 'right' });

    assert.equal(await p.page.locator('[role="menu"]').count(), 1);
    assert.equal(await p.page.evaluate(async () => (await import('/lib/store.js')).store.selectedId), 'docs');
  } finally {
    await p.close();
  }
});

test('the Move action provides a non-dragging path to reorganize an entry', async () => {
  const p = await planner(TREE);
  try {
    await selectRow(p.page, 'keep.txt');
    await p.page.getByRole('button', { name: 'Move\u2026', exact: true }).click();
    await p.page.locator('#moveTarget').selectOption('docs');
    await p.page.getByRole('button', { name: 'Move into folder', exact: true }).click();

    assert.equal((await p.node('keep.txt')).parentId, 'docs');
    assert.match(await p.page.locator('#toast').textContent(), /files on disk are unchanged/i);
  } finally {
    await p.close();
  }
});

test('Move can create a missing destination and select it without leaving the flow', async () => {
  const p = await planner(TREE);
  try {
    await selectRow(p.page, 'keep.txt');
    await p.page.getByRole('button', { name: 'Move\u2026', exact: true }).click();
    await p.page.locator('#moveTarget').selectOption('docs');
    assert.equal(await p.page.locator('#moveCreateLocation').textContent(), 'docs');

    await p.page.locator('#moveCreateName').fill('note.md');
    assert.equal(await p.page.getByRole('button', { name: 'Create and select', exact: true }).isDisabled(), true);
    assert.match(await p.page.locator('#moveCreateError').textContent(), /already exists/i);

    await p.page.locator('#moveCreateName').fill('sorted');
    await p.page.getByRole('button', { name: 'Create and select', exact: true }).click();
    const firstDestinationId = await p.page.locator('#moveTarget').inputValue();
    assert.match(firstDestinationId, /^new:/);
    assert.equal(await p.page.locator('#moveTarget option:checked').textContent(), 'docs/sorted');
    assert.equal(await p.page.locator('#moveDialog').getAttribute('open'), '');

    await p.page.locator('#moveCreateName').fill('2026');
    await p.page.getByRole('button', { name: 'Create and select', exact: true }).click();
    const destinationId = await p.page.locator('#moveTarget').inputValue();
    assert.match(destinationId, /^new:/);
    assert.notEqual(destinationId, firstDestinationId);
    assert.equal(await p.page.locator('#moveTarget option:checked').textContent(), 'docs/sorted/2026');

    await p.page.getByRole('button', { name: 'Move into folder', exact: true }).click();
    assert.equal((await p.node('keep.txt')).parentId, destinationId);
    const firstDestination = await p.node(firstDestinationId);
    const destination = await p.node(destinationId);
    assert.equal(firstDestination.parentId, 'docs');
    assert.equal(firstDestination.name, 'sorted');
    assert.equal(destination.parentId, firstDestinationId);
    assert.equal(destination.name, '2026');

    const { problems, script } = await p.resolved();
    assert.deepEqual(problems, []);
    assert.ok(script.some((line) => /mkdir.*docs\/sorted/.test(line)));
    assert.ok(script.some((line) => /mkdir.*docs\/sorted\/2026/.test(line)));
    assert.ok(script.some((line) => /keep\.txt.*docs\/sorted\/2026\/keep\.txt/.test(line)));
  } finally {
    await p.close();
  }
});

test('? opens the shortcuts panel and Escape closes it', async () => {
  const p = await planner(TREE);
  try {
    await p.page.keyboard.press('?');
    await p.page.waitForSelector('#sidePane .pane-head');
    assert.match(await p.page.locator('#sidePane').textContent(), /shortcuts/i);

    await p.page.keyboard.press('Escape');
    await p.page.waitForFunction(() => !document.querySelector('.stage')?.classList.contains('split'));
  } finally {
    await p.close();
  }
});

/* ---------------------------------------------------------------- filter */

test('the filter hides non-matching rows and / focuses it', async () => {
  const p = await planner(TREE);
  try {
    await p.page.keyboard.press('/');
    assert.equal(await p.page.evaluate(() => document.activeElement.id), 'filterBox');

    await p.page.keyboard.type('junk');
    // Non-matching rows are removed from the DOM, not hidden with a class, so the
    // assertion is about what remains rather than about visibility.
    await p.page.waitForFunction(() => document.querySelectorAll('.row').length < 7);
    const ids = await p.page.$$eval('.row', (els) => els.map((e) => e.dataset.id));
    assert.ok(ids.includes('old-backup/junk.log'), 'the match survives');
    assert.ok(!ids.includes('keep.txt'), 'non-matches are gone');
    assert.ok(ids.includes('old-backup'), 'an ancestor is kept so the match has a path');
  } finally {
    await p.close();
  }
});

test('a slash-wrapped filter is treated as a regex', async () => {
  const p = await planner(TREE);
  try {
    await p.page.locator('#filterBox').fill('/\\.log$/');
    await p.page.waitForFunction(() => document.querySelectorAll('.row').length < 7);
    const ids = await p.page.$$eval('.row', (els) => els.map((e) => e.dataset.id));
    assert.ok(ids.includes('old-backup/junk.log'), 'the regex matches the .log file');
    assert.ok(!ids.includes('docs/note.md'), 'a .md file does not match /\\.log$/');
  } finally {
    await p.close();
  }
});

test('an invalid regular expression is identified instead of silently matching everything', async () => {
  const p = await planner(TREE);
  try {
    const filter = p.page.locator('#filterBox');
    await filter.fill('/[/');
    assert.equal(await filter.getAttribute('aria-invalid'), 'true');
    assert.match(await p.page.locator('#filterStatus').textContent(), /invalid regular expression/i);
  } finally {
    await p.close();
  }
});

/* ---------------------------------------------------------------- persistence */

test('an edit made in the browser is persisted to the server', async () => {
  const p = await planner(TREE);
  try {
    await dragRow(p.page, 'keep.txt', 'docs', 'into');
    await p.settled();

    const plan = await p.savedPlan();
    assert.deepEqual(
      plan.overrides.find((o) => o.id === 'keep.txt').cur,
      { name: 'keep.txt', parentId: 'docs' },
      'the server has the edit, not just the page'
    );
  } finally {
    await p.close();
  }
});

test('a plan survives a reload', async () => {
  const p = await planner(TREE);
  try {
    await dragRow(p.page, 'keep.txt', 'docs', 'into');
    await p.settled();
    await p.page.reload();
    await p.page.waitForSelector('.row');

    assert.equal((await p.node('keep.txt')).parentId, 'docs', 'the plan came back from disk');
    const ids = await p.page.$$eval('.row', (els) => els.map((e) => e.dataset.id));
    assert.ok(ids.includes('keep.txt'), 'the moved node is rendered under its new parent');
  } finally {
    await p.close();
  }
});

test('CLI agent edits and browser presentation converge on the same inspectable state', async () => {
  const p = await planner(TREE, { colorScheme: 'light' });
  try {
    const mutation = runCliJson(
      ['mutate', p.root, '--input', '-'],
      JSON.stringify([{ type: 'move', id: 'keep.txt', parentId: 'docs' }])
    );
    assert.equal(mutation.plan.revision, 1);
    await p.page.waitForFunction(async () => {
      const { store } = await import('/lib/store.js');
      return store.planRevision === 1 && store.nodes.get('keep.txt')?.cur.parentId === 'docs';
    });

    writeFileSync(join(p.root, 'arrived.txt'), 'new');
    const rescanned = runCliJson(['rescan', p.root]);
    await p.page.waitForFunction(async (scanId) => {
      const { store } = await import('/lib/store.js');
      return store.scan.id === scanId && store.nodes.has('arrived.txt');
    }, rescanned.scan.id);

    await p.page.locator('.btn[data-theme-btn]').click();
    await selectRow(p.page, 'keep.txt');
    await p.settled();

    const inspected = runCliJson(['inspect', '--data-dir', join(p.root, '.reorg')]);
    const selected = inspected.projection.nodes.find((node) => node.id === 'keep.txt');
    assert.equal(inspected.plan.revision, 1);
    assert.equal(inspected.view.ui.theme, 'dark');
    assert.equal(inspected.view.selectedId, 'keep.txt');
    assert.deepEqual(inspected.view.side, { mode: 'preview', targetId: 'keep.txt' });
    assert.equal(selected.currentPath, 'docs/keep.txt');
    assert.equal(selected.presentation.selected, true);
    assert.equal(selected.visible, true);
    assert.ok(existsSync(join(p.root, 'keep.txt')));
    assert.equal(existsSync(join(p.root, 'docs/keep.txt')), false);

    await p.page.reload();
    await p.page.waitForSelector('pre.head');
    assert.equal(await p.page.locator('.btn[data-theme-btn]').textContent(), 'theme: dark');
    assert.equal(await p.page.locator('#sideTitle').textContent(), 'preview');
    assert.equal(
      await p.page.locator('[role="treeitem"][aria-selected="true"]').getAttribute('data-id'),
      'keep.txt'
    );
  } finally {
    await p.close();
  }
});

/* ---------------------------------------------------------------- apply gate */

test('the browser cannot apply filesystem changes, and points to the CLI', async () => {
  const p = await planner(TREE);
  try {
    await dragRow(p.page, 'keep.txt', 'docs', 'into');
    const res = await p.page.evaluate(async () => {
      const { api } = await import('/lib/api.js');
      try {
        await api.post('/api/apply', { dryRun: false });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: String(e.message || e) };
      }
    });
    assert.equal(res.ok, false);
    assert.match(res.message, /reorg apply --yes/);
  } finally {
    await p.close();
  }
});

test('a safety check keeps the reviewed operations and next actions visible', async () => {
  const p = await planner(TREE);
  try {
    await dragRow(p.page, 'keep.txt', 'docs', 'into');
    await p.page.getByRole('button', { name: 'review plan', exact: true }).click();
    await p.page.waitForSelector('#sideBody .op');
    await p.page.getByRole('button', { name: 'run safety check', exact: true }).click();
    await p.page.waitForSelector('text=Safety check passed');

    assert.ok(await p.page.locator('#sideBody .op').count(), 'the operation list remains');
    assert.equal(await p.page.getByRole('button', { name: 'run safety check', exact: true }).count(), 1);
    assert.equal(await p.page.getByRole('button', { name: 'apply to disk unavailable', exact: true }).count(), 1);
  } finally {
    await p.close();
  }
});

/* ---------------------------------------------------------------- theme */

test('the theme button cycles auto, dark, light and persists', async () => {
  const p = await planner(TREE, { colorScheme: 'light' });
  try {
    const btn = p.page.locator('.btn[data-theme-btn]');
    assert.equal(await btn.textContent(), 'theme: system');
    // Following a light OS, so the page should be light before any override.
    assert.equal(await p.page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(251, 250, 247)');

    await btn.click();
    assert.equal(await btn.textContent(), 'theme: dark');
    assert.equal(await p.page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(15, 16, 18)');
    assert.equal(await p.page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');

    await p.settled();
    await p.page.reload();
    await p.page.waitForSelector('.row');
    assert.equal(
      await p.page.locator('.btn[data-theme-btn]').textContent(),
      'theme: dark',
      'the override outlives a reload'
    );
  } finally {
    await p.close();
  }
});

/* ---------------------------------------------------------------- escaping */

test('a filename that looks like markup is rendered as text, not parsed', async () => {
  // Every string in the tree is untrusted input. app.js builds DOM with
  // textContent rather than innerHTML for exactly this; the test pins it.
  const p = await planner({ '<img src=x onerror=alert(1)>.txt': 'x', 'safe.txt': 'y' });
  try {
    const rendered = await p.page.locator('.row .name').first().textContent();
    assert.match(rendered, /<img/, 'the angle brackets survive as literal text');
    assert.equal(await p.page.locator('img').count(), 0, 'no element was created from the name');
    assert.deepEqual(p.errors, []);
  } finally {
    await p.close();
  }
});

test('the narrow layout keeps every toolbar action onscreen and uses one readable pane', async () => {
  const p = await planner(TREE, { viewport: { width: 320, height: 800 } });
  try {
    const overflow = await p.page.$$eval('#toolbar button', (buttons) =>
      buttons
        .map((button) => button.getBoundingClientRect())
        .filter((box) => box.left < 0 || box.right > window.innerWidth)
        .map((box) => ({ left: box.left, right: box.right }))
    );
    assert.deepEqual(overflow, []);

    await p.page.getByRole('button', { name: 'cleanup', exact: true }).click();
    await p.page.waitForSelector('#sidePane:not([hidden])');
    const layout = await p.page.evaluate(() => ({
      treeVisible: getComputedStyle(document.querySelector('.tree-pane')).display !== 'none',
      sideWidth: document.querySelector('#sidePane').getBoundingClientRect().width,
    }));
    assert.equal(layout.treeVisible, false);
    assert.ok(layout.sideWidth >= 310, `side pane should use the viewport, got ${layout.sideWidth}px`);
  } finally {
    await p.close();
  }
});
