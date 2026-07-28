import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, ranked } from './signals.js';
import { looksTextual } from './text.js';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = join(PROJECT_DIR, 'web');
const STATIC_PREVIEW_LINES = 100;
const STATIC_PREVIEW_FILE_MAX_BYTES = 256 * 1024;
const STATIC_PREVIEW_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const STATIC_FILE_MODE = 0o600;

const MODULES = Object.freeze([
  ['reorg:app', join(WEB_DIR, 'app.js')],
  ['reorg:api', join(WEB_DIR, 'lib', 'api.js')],
  ['reorg:dom', join(WEB_DIR, 'lib', 'dom.js')],
  ['reorg:plan-edit', join(WEB_DIR, 'lib', 'plan-edit.js')],
  ['reorg:plan-file', join(WEB_DIR, 'lib', 'plan-file.js')],
  ['reorg:side', join(WEB_DIR, 'lib', 'side.js')],
  ['reorg:static-api', join(WEB_DIR, 'lib', 'static-api.js')],
  ['reorg:store', join(WEB_DIR, 'lib', 'store.js')],
  ['reorg:tree', join(WEB_DIR, 'lib', 'tree.js')],
  ['reorg:plan', join(PROJECT_DIR, 'src', 'plan.js')],
]);

const MODULE_ID_BY_PATH = new Map(MODULES.map(([id, path]) => [resolvePath(path), id]));
const RELATIVE_MODULE_PATTERN = /(['"])(\.\.?\/[^'"]+\.js)\1/g;

function dataUrl(mime, content) {
  return `data:${mime};base64,${Buffer.from(content).toString('base64')}`;
}

function rewriteModule(source, sourcePath) {
  return source.replace(RELATIVE_MODULE_PATTERN, (match, quote, specifier) => {
    const target = resolvePath(dirname(sourcePath), specifier);
    const id = MODULE_ID_BY_PATH.get(target);
    if (!id) throw new Error(`Static bundle has no module for ${specifier} imported by ${sourcePath}`);
    return `${quote}${id}${quote}`;
  });
}

function moduleImportMap() {
  const imports = {};
  for (const [id, sourcePath] of MODULES) {
    const source = readFileSync(sourcePath, 'utf8');
    imports[id] = dataUrl('text/javascript', rewriteModule(source, sourcePath));
  }
  return { imports };
}

function readPreview(root, node, maxBytes) {
  const path = join(root, node.id);
  const size = Math.min(
    STATIC_PREVIEW_FILE_MAX_BYTES,
    maxBytes,
    Number.isFinite(node.bytes) ? node.bytes : STATIC_PREVIEW_FILE_MAX_BYTES
  );
  const buffer = Buffer.alloc(Math.max(0, size));
  let read = 0;
  const fd = openSync(path, 'r');
  try {
    if (buffer.length) read = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  const head = buffer.subarray(0, read);
  if (!looksTextual(head)) {
    return {
      bytesRead: read,
      preview: { path: node.id, binary: true, size: node.bytes, text: null },
    };
  }

  const all = head.toString('utf8').split('\n');
  const text = all.slice(0, STATIC_PREVIEW_LINES).join('\n');
  return {
    bytesRead: read,
    preview: {
      path: node.id,
      binary: false,
      size: node.bytes,
      mtime: node.mtime,
      truncated: all.length > STATIC_PREVIEW_LINES || (node.bytes || 0) > read,
      shown: Math.min(all.length, STATIC_PREVIEW_LINES),
      text,
    },
  };
}

function collectPreviews(root, scan) {
  const previews = Object.create(null);
  let bytes = 0;
  let included = 0;
  let omitted = 0;

  for (const node of scan.nodes) {
    if (node.kind !== 'file') continue;
    const remaining = STATIC_PREVIEW_TOTAL_MAX_BYTES - bytes;
    if (remaining <= 0) {
      omitted++;
      continue;
    }
    try {
      const result = readPreview(root, node, remaining);
      previews[node.id] = result.preview;
      bytes += result.bytesRead;
      included++;
    } catch {
      omitted++;
    }
  }
  return { previews, stats: { bytes, included, omitted } };
}

function staticBootstrap(encodedData) {
  return `
import { installStaticApi } from 'reorg:static-api';
import { resolve, describeOp } from 'reorg:plan';

const binary = atob('${encodedData}');
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
const data = JSON.parse(new TextDecoder().decode(bytes));
installStaticApi(data, { resolvePlan: resolve, describeOp });
await import('reorg:app');
`.trim();
}

export function buildStaticPlanner({ root, scan, plan, gitignore = '', undoScripts = [] }) {
  const previewResult = collectPreviews(root, scan);
  const analysis = analyze(scan);
  const data = {
    scan,
    plan,
    gitignore,
    undoScripts,
    triage: {
      candidates: ranked(analysis, 200),
      total: analysis.size,
    },
    previews: previewResult.previews,
  };

  const encodedData = Buffer.from(JSON.stringify(data)).toString('base64');
  const importMap = JSON.stringify(moduleImportMap());
  const favicon = dataUrl('image/svg+xml', readFileSync(join(WEB_DIR, 'favicon.svg')));
  const css = readFileSync(join(WEB_DIR, 'app.css'), 'utf8');
  const appScript = [
    `<script type="importmap">${importMap}</script>`,
    `<script type="module">${staticBootstrap(encodedData)}</script>`,
  ].join('\n');

  let html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
  html = html.replace(
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    `<link rel="icon" href="${favicon}" type="image/svg+xml">`
  );
  html = html.replace('<link rel="stylesheet" href="/app.css">', `<style>${css}</style>`);
  html = html.replace('<script src="/app.js" type="module"></script>', appScript);

  if (html.includes('href="/app.css"') || html.includes('src="/app.js"')) {
    throw new Error('Static planner template did not inline every web asset');
  }

  return {
    html,
    previewStats: previewResult.stats,
  };
}

export function writeStaticPlanner(outputPath, options) {
  if (existsSync(outputPath)) {
    throw new Error(`${outputPath} already exists; choose another --output path`);
  }
  const result = buildStaticPlanner(options);
  writeFileSync(outputPath, result.html, { flag: 'wx', mode: STATIC_FILE_MODE });
  return result;
}
