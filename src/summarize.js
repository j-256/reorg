// File summaries, two ways.
//
// The default path needs no API key and costs nothing: `reorg summarize` writes a
// prompt pack listing the files and the exact JSON shape to fill in, and your
// coding agent (Claude Code, or anything that can read and write files) fills it.
// The tool never has to be the one holding a credential.
//
// If ANTHROPIC_API_KEY is set, the same work can run here directly against the
// Messages API over stdlib fetch -- no SDK, no dependency. Summaries land in the
// plan's `summaries` map, keyed by node id, and render as one-liners in the tree.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ensureWorkspace,
  loadPlan,
  loadScan,
  saveScan,
  stateDir,
  withWorkspaceLock,
} from './state.js';
import { looksTextual } from './text.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { scan } from './scan.js';
import { COMMAND, RevisionConflictError, transactPlan } from './commands.js';

// Cheapest capable model for a one-line-per-file classification job. Overridable
// with --model; the API is the same shape for every current model.
export const DEFAULT_MODEL = 'claude-haiku-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

const HEAD_CHARS = 4000; // per file: enough to characterize, small enough to batch
const BATCH_FILES = 12;
const PROMPT_FILE = 'summarize.md';
const OUT_FILE = 'summaries.json';

function ownValue(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key) ? Reflect.get(record, key) : undefined;
}

function setOwn(record, key, value) {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
const SUMMARY_MERGE_RETRIES = 3;

const SYSTEM = [
  'You label files for a directory-reorganization tool.',
  '',
  'For each file you are given, write ONE line describing what it actually is and',
  'what it is for -- the thing a person would need to know when deciding where it',
  'belongs or whether to keep it. Be concrete and specific.',
  '',
  'Rules:',
  '- Maximum 90 characters per summary. No trailing period.',
  '- Describe content and purpose, not syntax: "nightly S3 backup cron script",',
  '  not "a shell script with a for loop".',
  '- Never restate the filename. "config.json: config file" is useless.',
  '- If it looks generated, vendored, obsolete, or like scratch output, say so --',
  '  that is exactly what the user is trying to find.',
  '- If the content is too little to judge, say "unclear: <what you can tell>".',
].join('\n');

async function readHead(abs) {
  const buf = await readFile(abs);
  if (!looksTextual(buf)) return null;
  return buf.toString('utf8').slice(0, HEAD_CHARS);
}

/** Build the payload the model sees for one batch: path + head, clearly delimited. */
function renderBatch(entries) {
  const parts = entries.map(
    (e, i) => `<file index="${i + 1}" path="${e.path}" bytes="${e.bytes}">\n${e.head}\n</file>`
  );
  return [
    `Summarize these ${entries.length} file(s).`,
    '',
    parts.join('\n\n'),
    '',
    'Reply with JSON only: an object mapping each path exactly as given to its',
    'one-line summary string. No prose, no code fence.',
  ].join('\n');
}

function parseJsonish(text) {
  // Structured outputs would make this unnecessary, but a plain object reply is
  // reliable for a task this shaped, and keeps the request minimal. Strip a code
  // fence if the model adds one anyway.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

async function callApi({ apiKey, model, prompt }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 400)}`);
  }
  const json = await res.json();

  // Safety classifiers can decline with a normal 200 and an empty content array,
  // so reading content[0] blindly would throw. A refusal is reported per batch
  // rather than thrown: one declined batch should not discard the summaries
  // already gathered for every other file.
  const refused = json.stop_reason === 'refusal';
  const text = (json.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, usage: json.usage || {}, refused };
}

/**
 * Gather the head of each candidate file. Skips directories, binaries, and
 * anything already summarized unless `force`.
 */
export async function collect({ root, paths, existing = {}, force = false }) {
  const entries = [];
  const skipped = [];
  for (const p of paths) {
    if (!force && existing[p]) continue;
    const abs = join(root, p);
    let st;
    try {
      st = await stat(abs);
    } catch {
      skipped.push({ path: p, why: 'missing' });
      continue;
    }
    if (st.isDirectory()) {
      skipped.push({ path: p, why: 'directory' });
      continue;
    }
    if (st.size === 0) {
      skipped.push({ path: p, why: 'empty' });
      continue;
    }
    const head = await readHead(abs);
    if (head === null) {
      skipped.push({ path: p, why: 'binary' });
      continue;
    }
    entries.push({ path: p, bytes: st.size, head });
  }
  return { entries, skipped };
}

/**
 * Summarize via the API. Requires ANTHROPIC_API_KEY.
 * Returns { summaries, skipped, usage, batches }.
 */
function mergeSummaries({ root, dataDir, summaries, actor }) {
  const frozen = withWorkspaceLock(root, dataDir, () => {
    ensureWorkspace(root, dataDir);
    const existing = loadScan(root, dataDir);
    if (existing) return existing;
    const created = scan(root);
    saveScan(root, created, dataDir);
    return created;
  });
  for (let attempt = 0; attempt < SUMMARY_MERGE_RETRIES; attempt++) {
    const plan = loadPlan(root, dataDir);
    try {
      return transactPlan({
        root,
        dataDir,
        scan: frozen,
        expectedRevision: plan.revision,
        actor,
        commands: [{ type: COMMAND.MERGE_SUMMARIES, summaries }],
      });
    } catch (error) {
      if (!(error instanceof RevisionConflictError) || attempt === SUMMARY_MERGE_RETRIES - 1) {
        throw error;
      }
    }
  }
  throw new Error('Could not merge summaries');
}

export async function summarize({
  root,
  dataDir = null,
  paths,
  model = DEFAULT_MODEL,
  force = false,
  onProgress,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      error:
        'ANTHROPIC_API_KEY is not set. Either export it, or run `reorg summarize --emit-prompts` ' +
        'and let your coding agent fill in the workspace summaries.json file (no key needed).',
      summaries: {},
      skipped: [],
    };
  }

  const plan = loadPlan(root, dataDir);
  const { entries, skipped } = await collect({ root, paths, existing: plan.summaries, force });
  const summaries = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  let batches = 0;

  for (let i = 0; i < entries.length; i += BATCH_FILES) {
    const batch = entries.slice(i, i + BATCH_FILES);
    batches++;
    if (onProgress) onProgress({ done: i, total: entries.length });
    const { text, usage: u, refused } = await callApi({ apiKey, model, prompt: renderBatch(batch) });
    usage.input_tokens += u.input_tokens || 0;
    usage.output_tokens += u.output_tokens || 0;
    if (refused) {
      for (const e of batch) skipped.push({ path: e.path, why: 'the model declined this batch' });
      continue;
    }
    const parsed = parseJsonish(text);
    if (!parsed) {
      for (const e of batch) skipped.push({ path: e.path, why: 'unparseable model reply' });
      continue;
    }
    for (const e of batch) {
      const v = ownValue(parsed, e.path);
      if (typeof v === 'string' && v.trim()) setOwn(summaries, e.path, v.trim().slice(0, 200));
      else skipped.push({ path: e.path, why: 'not in model reply' });
    }
  }

  if (Object.keys(summaries).length) {
    mergeSummaries({ root, dataDir, summaries, actor: 'summarize-api' });
  }
  if (onProgress) onProgress({ done: entries.length, total: entries.length });
  return { summaries, skipped, usage, batches, model };
}

/**
 * The no-key path: write a prompt pack an agent can act on, plus a stub output
 * file it fills in. Returns { promptPath, outPath, count }.
 */
export async function emitPrompts({ root, dataDir = null, paths, force = false }) {
  const plan = loadPlan(root, dataDir);
  const { entries, skipped } = await collect({ root, paths, existing: plan.summaries, force });
  const dir = stateDir(root, dataDir);
  const outPath = join(dir, OUT_FILE);
  const promptPath = join(dir, PROMPT_FILE);

  const stub = {};
  for (const e of entries) stub[e.path] = '';

  const doc = [
    '# Summarize these files for Reorg',
    '',
    'A one-line summary per file, so the Reorg planner can show what each file',
    'actually is while its owner decides where it belongs.',
    '',
    '## What to do',
    '',
    `1. Read each path listed below (they are relative to \`${root}\`).`,
    `2. Fill in every empty string in \`${OUT_FILE}\` (same directory as this file).`,
    '3. Keep the keys exactly as they are -- they are node ids the planner matches on.',
    '4. Reload the Reorg page; summaries appear inline in the tree.',
    '',
    '## Rules for each summary',
    '',
    SYSTEM.split('\n').slice(2).join('\n'),
    '',
    `## Files (${entries.length})`,
    '',
    ...entries.map((e) => `- \`${e.path}\` (${e.bytes} bytes)`),
    '',
  ];
  if (skipped.length) {
    doc.push(
      '## Skipped',
      '',
      'Not worth summarizing (binary, empty, missing, or already done):',
      '',
      ...skipped.map((s) => `- \`${s.path}\` -- ${s.why}`),
      ''
    );
  }
  withWorkspaceLock(root, dataDir, () => {
    ensureWorkspace(root, dataDir);
    writeFileSync(outPath, JSON.stringify(stub, null, 2) + '\n');
    writeFileSync(promptPath, doc.join('\n'));
  });
  return { promptPath, outPath, count: entries.length, skipped };
}

/** Merge an agent-filled summaries.json back into the plan. */
export function ingestSummaries(root, dataDir = null) {
  const p = join(stateDir(root, dataDir), OUT_FILE);
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`could not read ${p}: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${p} must contain an object mapping node ids to summaries`);
  }
  const plan = loadPlan(root, dataDir);
  const additions = {};
  let added = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.trim()) {
      const summary = v.trim().slice(0, 200);
      if (ownValue(plan.summaries, k) !== summary) added++;
      setOwn(additions, k, summary);
    }
  }
  const result = mergeSummaries({
    root,
    dataDir,
    summaries: additions,
    actor: 'summarize-ingest',
  });
  return { added, total: Object.keys(result.plan.summaries).length };
}
