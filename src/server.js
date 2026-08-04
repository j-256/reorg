// The local server: static files from web/ and a JSON API over shared workspace state
//
// Deliberately stdlib-only (node:http). It binds to loopback and carries a
// per-run token because it exposes file reads and planning-state mutations, a
// capability worth fencing even on localhost

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, extname, resolve as resolvePath, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { scan, readGitignore } from './scan.js';
import {
  acquireServerLease,
  ensureWorkspace,
  loadPlan,
  loadScan,
  loadTransactions,
  loadView,
  listUndoScripts,
  saveScan,
  stateDir,
  WORKSPACE_BUSY_CODE,
  withWorkspaceLock,
} from './state.js';
import { resolve as resolvePlan, describeOp } from './plan.js';
import { apply } from './apply.js';
import { summarize } from './summarize.js';
import { looksTextual } from './text.js';
import { analyze, ranked } from './signals.js';
import { COMMAND_ERROR_CODE, CommandError, transactPlan } from './commands.js';
import { materializeView, transactView } from './view.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const INVALID_JSON_CODE = 'invalid-json';

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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CommandError('Request body is not valid JSON', { code: INVALID_JSON_CODE });
  }
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

export function listenOnAvailablePort(server, port, host = '127.0.0.1', retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (candidate, remaining) => {
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(candidate);
      };
      const onError = (error) => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE' && remaining > 0) {
          attempt(candidate + 1, remaining - 1);
        } else {
          reject(error);
        }
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, host);
    };
    attempt(port, retries);
  });
}

export function createReorgServer({
  root,
  dataDir = null,
  scanOptions = {},
  token = randomBytes(24).toString('hex'),
}) {
  // Keep one in-memory scan for normal requests and adopt a newer persisted scan
  // after an explicit external refresh
  let current = { scan: null, gitignore: '' };
  let releaseLease;
  const workspace = withWorkspaceLock(root, dataDir, () => {
    const opened = ensureWorkspace(root, dataDir);
    if (resolvePath(opened.root) !== resolvePath(root)) {
      throw new Error(`Workspace is bound to ${opened.root}; rebind it before serving ${root}`);
    }
    current.scan = loadScan(root, dataDir);
    releaseLease = acquireServerLease(root, dataDir);
    return opened;
  });

  const rescan = (opts = {}) => {
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new CommandError('Rescan options must be an object');
    }
    return withWorkspaceLock(root, dataDir, () => {
      const requested = Object.fromEntries(
        Object.entries({ ...scanOptions, ...opts }).filter(([, value]) => value !== undefined)
      );
      const options = { ...(current.scan?.options || {}), ...requested };
      current.scan = scan(root, options);
      current.gitignore = readGitignore(root);
      saveScan(root, current.scan, dataDir);
      return current.scan;
    });
  };
  try {
    if (!current.scan || Object.keys(scanOptions).length) rescan();
    else current.gitignore = readGitignore(root);
  } catch (error) {
    releaseLease();
    throw error;
  }

  const syncScan = () => {
    const persisted = loadScan(root, dataDir);
    if (persisted && persisted.id !== current.scan?.id) {
      current.scan = persisted;
      current.gitignore = readGitignore(root);
    }
    return current.scan;
  };

  const readState = (reader) =>
    withWorkspaceLock(root, dataDir, () => {
      const frozen = syncScan();
      const plan = loadPlan(root, dataDir);
      const view = loadView(root, dataDir, plan.ui);
      return reader({ scan: frozen, plan, view });
    });

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
        const analysis = readState(({ scan: frozen }) => analyze(frozen));
        return sendJson(res, 200, {
          candidates: ranked(analysis, 200),
          total: analysis.size,
        });
      }

      if (req.method === 'GET' && path === '/api/tree') {
        const snapshot = readState(({ scan: frozen, plan, view }) => ({
          scan: frozen,
          plan,
          view: materializeView(frozen, plan, view).view,
        }));
        return sendJson(res, 200, {
          workspace,
          ...snapshot,
          gitignore: current.gitignore,
          undoScripts: listUndoScripts(root),
        });
      }

      if (req.method === 'POST' && path === '/api/rescan') {
        const body = await readBody(req);
        rescan(body.options || {});
        const snapshot = readState(({ scan: frozen, plan, view }) => ({
          scan: frozen,
          plan,
          view: materializeView(frozen, plan, view).view,
        }));
        return sendJson(res, 200, {
          ...snapshot,
          gitignore: current.gitignore,
        });
      }

      if (req.method === 'GET' && path === '/api/revisions') {
        const revisions = readState(({ scan: frozen, plan, view }) => ({
          scanId: frozen.id,
          planRevision: plan.revision,
          viewRevision: view.revision,
        }));
        return sendJson(res, 200, {
          ...revisions,
        });
      }

      if (req.method === 'GET' && path === '/api/inspect') {
        const snapshot = readState(({ scan: frozen, plan, view }) => {
          const projection = materializeView(frozen, plan, view);
          return {
            scan: frozen,
            plan,
            transactions: loadTransactions(root, dataDir),
            view: projection.view,
            projection,
            resolved: resolvePlan(frozen, plan),
          };
        });
        return sendJson(res, 200, {
          workspace,
          ...snapshot,
        });
      }

      if (req.method === 'POST' && path === '/api/transactions') {
        const body = await readBody(req);
        const result = transactPlan({
          root,
          dataDir,
          scan: current.scan,
          commands: body.commands,
          expectedRevision: body.expectedRevision,
          transactionId: body.transactionId,
          actor: body.actor ?? 'browser',
        });
        return sendJson(res, 200, result);
      }

      if (req.method === 'PUT' && path === '/api/view') {
        const body = await readBody(req);
        const result = transactView({
          root,
          dataDir,
          expectedRevision: body.expectedRevision,
          patch: body.patch,
        });
        return sendJson(res, 200, result);
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
        await readBody(req);
        const { ops, problems, stats } = readState(({ scan: frozen, plan }) =>
          resolvePlan(frozen, plan)
        );
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
        if (!dryRun) {
          return sendJson(res, 403, {
            error: 'Filesystem changes are only available through `reorg apply --yes` in the terminal.',
          });
        }
        const { result, log } = readState(({ scan: frozen, plan }) => {
          const { ops, problems } = resolvePlan(frozen, plan);
          if (problems.length) return { result: { problems }, log: [] };
          const lines = [];
          return {
            result: apply(root, ops, { dryRun: true, onLog: (line) => lines.push(line) }),
            log: lines,
          };
        });
        if (result.problems.length) return sendJson(res, 409, { problems: result.problems });
        return sendJson(res, result.problems.length ? 409 : 200, {
          ...result,
          log,
        });
      }

      if (req.method === 'POST' && path === '/api/summarize') {
        const body = await readBody(req);
        const out = await summarize({
          root,
          paths: body.paths || [],
          model: body.model,
          force: !!body.force,
          dataDir,
        });
        return sendJson(res, 200, out);
      }

      return sendJson(res, 404, { error: 'no such endpoint' });
    } catch (e) {
      const conflict = e instanceof CommandError && e.code === COMMAND_ERROR_CODE.REVISION_CONFLICT;
      const busy = e.code === WORKSPACE_BUSY_CODE;
      const status = busy ? 503 : conflict ? 409 : e instanceof CommandError ? 400 : 500;
      return sendJson(res, status, {
        error: e.message,
        ...(e.code ? { code: e.code } : {}),
        ...(e.details || {}),
      });
    }
  });
  server.once('close', releaseLease);

  return { server, token, workspace, rescan, get scan() { return current.scan; } };
}

export { stateDir };
