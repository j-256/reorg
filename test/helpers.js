// Shared test fixtures.
//
// Every suite here works against real temp directories rather than a mocked fs,
// for the reason stated in apply.test.js: a resolver that is correct on paper but
// wrong on disk is worthless. That makes a sandbox builder the one thing worth
// sharing, since each suite needs the same "lay out this tree, optionally as a
// git repo" primitive.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Materialize `layout` in a fresh temp directory and return its path.
 *
 * Keys ending in `/` become directories; everything else becomes a file whose
 * content is the mapped value, defaulting to its own path so each file is
 * distinguishable without the caller inventing content.
 *
 * opts.git      init a repo in the sandbox
 * opts.commit   with git, commit the layout (default true; false leaves it untracked)
 */
export function sandbox(layout, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reorg-test-'));
  for (const [p, content] of Object.entries(layout)) {
    const abs = join(root, p);
    if (p.endsWith('/')) {
      mkdirSync(abs, { recursive: true });
    } else {
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content ?? p);
    }
  }
  if (opts.git) {
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'config', 'user.name', 'test'], { stdio: 'ignore' });
    if (opts.commit !== false) {
      execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'commit', '-qm', 'init'], { stdio: 'ignore' });
    }
  }
  return root;
}

/** Remove a sandbox. Safe to call on an already-removed path. */
export function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

/** Build a layout of `n` files under `dir`, for exercising count-based limits. */
export function manyFiles(dir, n, prefix = 'f') {
  const layout = {};
  for (let i = 0; i < n; i++) layout[`${dir}/${prefix}${i}.txt`] = `file ${i}`;
  return layout;
}
