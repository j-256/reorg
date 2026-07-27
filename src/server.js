// The local server: static files from web/, a small JSON API over the plan.
//
// Deliberately stdlib-only (node:http). It binds to loopback and carries a
// per-run token, because it exposes file reads and (behind an explicit flag)
// filesystem mutations -- that is a capability worth fencing even on localhost,
// where any other process or a stray browser tab could otherwise reach it.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, extname, resolve as resolvePath, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { scan, readGitignore } from './scan.js';
import { loadPlan, savePlan, listUndoScripts, stateDir, clearAppliedPlan } from './state.js';
import { resolve as resolvePlan, describeOp } from './plan.js';
import { apply } from './apply.js';
import { summarize } from './summarize.js';
import { looksTextual } from './text.js';
import { analyze, ranked } from './signals.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const HEAD_MAX_BYTES = 256 * 1024; // enough for a 100-line preview of anything sane

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Length': buf.length,
    // This is a local tool with a live filesystem behind it; a cached API response
    // or stale bundle is always wrong.
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function tokenOk(expected, given) {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(given));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Confine a client-supplied relative path to `root`.
 * Returns the absolute path, or null if it escapes.
 */
function safeJoin(root, relPath) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  if (relPath.includes('\0')) return null;
  const abs = resolvePath(root, relPath);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || resolvePath(root, rel) !== abs) return null;
  return abs;
}

export function createReorgServer({ root, allowApply = false, token = randomBytes(24).toString('hex') }) {
  // Cached scan: rescans are explicit, so a plan is always diffed against a known
  // tree rather than a moving target.
  let current = { scan: null, gitignore: '' };

  const rescan = (opts = {}) => {
    current.scan = scan(root, opts);
    current.gitignore = readGitignore(root);
    return current.scan;
  };
  rescan();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    try {
      // ---- static ----------------------------------------------------------
      if (req.method === 'GET' && !path.startsWith('/api/')) {
        const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
        const abs = safeJoin(WEB_DIR, rel);
        if (!abs || !existsSync(abs)) return send(res, 404, 'Not found');
        const body = await readFile(abs);
        return send(res, 200, body, { 'Content-Type': MIME[extname(abs)] || 'application/octet-stream' });
      }

      // ---- API: token-gated ------------------------------------------------
      const given = url.searchParams.get('token') || req.headers['x-reorg-token'];
      if (!tokenOk(token, given)) return sendJson(res, 403, { error: 'bad or missing token' });

      // Ranked cleanup candidates. Name- and structure-based, never age-based --
      // see src/signals.js for the measurements behind that choice.
      if (req.method === 'GET' && path === '/api/triage') {
        const analysis = analyze(current.scan);
        return sendJson(res, 200, {
          candidates: ranked(analysis, 200),
          total: analysis.size,
        });
      }

      if (req.method === 'GET' && path === '/api/tree') {
        return sendJson(res, 200, {
          scan: current.scan,
          plan: loadPlan(root),
          gitignore: current.gitignore,
          allowApply,
          undoScripts: listUndoScripts(root),
        });
      }

      if (req.method === 'POST' && path === '/api/rescan') {
        const body = await readBody(req);
        const s = rescan(body.options || {});
        return sendJson(res, 200, { scan: s, gitignore: current.gitignore });
      }

      if (req.method === 'PUT' && path === '/api/plan') {
        const body = await readBody(req);
        const saved = savePlan(root, body.plan || {});
        return sendJson(res, 200, { savedAt: saved.savedAt });
      }

      // First N lines of a file, for the preview pane.
      if (req.method === 'GET' && path === '/api/head') {
        const p = url.searchParams.get('path');
        const lines = Math.min(Math.max(parseInt(url.searchParams.get('lines') || '100', 10) || 100, 1), 2000);
        const abs = safeJoin(root, p);
        if (!abs) return sendJson(res, 400, { error: 'path escapes the scan root' });
        let st;
        try {
          st = await stat(abs);
        } catch {
          return sendJson(res, 404, { error: 'no such file' });
        }
        if (st.isDirectory()) return sendJson(res, 400, { error: 'that is a directory' });

        // Read only the head, not the whole file: a multi-GB log must not be slurped.
        const chunks = [];
        let got = 0;
        await new Promise((done, fail) => {
          const rs = createReadStream(abs, { end: HEAD_MAX_BYTES - 1 });
          rs.on('data', (c) => {
            chunks.push(c);
            got += c.length;
          });
          rs.on('end', done);
          rs.on('error', fail);
        });
        const buf = Buffer.concat(chunks);
        if (!looksTextual(buf)) {
          return sendJson(res, 200, { path: p, binary: true, size: st.size, text: null });
        }
        const all = buf.toString('utf8').split('\n');
        const text = all.slice(0, lines).join('\n');
        return sendJson(res, 200, {
          path: p,
          binary: false,
          size: st.size,
          mtime: st.mtimeMs,
          truncated: all.length > lines || st.size > got,
          shown: Math.min(all.length, lines),
          text,
        });
      }

      // Resolve the plan into ops without touching disk. Powers the review panel.
      if (req.method === 'POST' && path === '/api/resolve') {
        const body = await readBody(req);
        const { ops, problems, stats } = resolvePlan(current.scan, body.plan || {});
        return sendJson(res, 200, {
          ops,
          problems,
          stats,
          script: ops.map(describeOp),
        });
      }

      if (req.method === 'POST' && path === '/api/apply') {
        const body = await readBody(req);
        const dryRun = body.dryRun !== false;
        if (!dryRun && !allowApply) {
          return sendJson(res, 403, {
            error:
              'This server was started without --allow-apply, so it can only dry-run. ' +
              'Restart with `reorg --allow-apply`, or run `reorg apply` from the terminal.',
          });
        }
        const { ops, problems } = resolvePlan(current.scan, body.plan || {});
        if (problems.length) return sendJson(res, 409, { problems });

        const log = [];
        const result = apply(root, ops, { dryRun, onLog: (l) => log.push(l) });
        if (!dryRun && !result.problems.length) {
          // Retire the plan server-side rather than trusting the client to do it:
          // if the browser's follow-up save never lands, a stale plan would make
          // the next resolve report phantom collisions against what it just made.
          clearAppliedPlan(root);
          rescan();
        }
        return sendJson(res, result.problems.length ? 409 : 200, {
          ...result,
          log,
          scan: dryRun ? undefined : current.scan,
        });
      }

      if (req.method === 'POST' && path === '/api/summarize') {
        const body = await readBody(req);
        const out = await summarize({
          root,
          paths: body.paths || [],
          model: body.model,
          force: !!body.force,
        });
        return sendJson(res, 200, out);
      }

      return sendJson(res, 404, { error: 'no such endpoint' });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  });

  return { server, token, rescan, get scan() { return current.scan; } };
}

export { stateDir };
