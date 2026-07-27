// The API summarize path, exercised against a stub server standing in for
// api.anthropic.com. This checks the wire shape we send (headers, model, system,
// batching) and how we handle what comes back -- including a refusal, which the
// API returns as a normal 200 and which naive code would treat as success.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarize, emitPrompts, ingestSummaries, DEFAULT_MODEL } from '../src/summarize.js';
import { loadPlan } from '../src/state.js';
import { looksTextual } from '../src/text.js';
import { sandbox, cleanup } from './helpers.js';

const boxes = [];
const box = (f) => {
  const r = sandbox(f);
  boxes.push(r);
  return r;
};
test.after(() => {
  for (const r of boxes) {
    try {
      cleanup(r);
    } catch {
      /* best effort */
    }
  }
});

/** Stand up a stub API. `handler(requestBody)` returns the JSON to reply with. */
async function stubApi(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ headers: req.headers, body: parsed, url: req.url });
      const reply = handler(parsed, seen.length);
      const status = reply.__status || 200;
      delete reply.__status;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { seen, url: `http://127.0.0.1:${port}/v1/messages`, close: () => server.close() };
}

function textReply(obj) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

// summarize() targets the real API URL, so point it at the stub by patching fetch.
async function withStub(stub, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => realFetch(stub.url, opts);
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    stub.close();
  }
}

test('sends the documented headers and writes summaries into the plan', async () => {
  const root = box({ 'a.sh': '#!/bin/bash\necho hi\n', 'b.csv': 'x,y\n1,2\n' });
  const stub = await stubApi(() => textReply({ 'a.sh': 'prints hi', 'b.csv': 'two-column sample' }));

  const res = await withStub(stub, () => summarize({ root, paths: ['a.sh', 'b.csv'] }));

  assert.equal(stub.seen.length, 1, 'both files fit in one batch');
  const { headers, body } = stub.seen[0];
  assert.equal(headers['x-api-key'], 'sk-ant-test-key');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(body.model, DEFAULT_MODEL);
  assert.ok(body.max_tokens > 0);
  assert.match(body.system, /ONE line/, 'the labeling rules ride in the system prompt');
  assert.equal(body.messages.length, 1);
  assert.match(body.messages[0].content, /a\.sh/);
  assert.match(body.messages[0].content, /echo hi/, 'file heads are included, not just names');

  assert.deepEqual(res.summaries, { 'a.sh': 'prints hi', 'b.csv': 'two-column sample' });
  assert.equal(res.usage.input_tokens, 100);
  assert.deepEqual(loadPlan(root).summaries, res.summaries, 'persisted to .reorg/plan.json');
});

test('a refusal is surfaced, not treated as a successful empty answer', async () => {
  // The API returns HTTP 200 with stop_reason: "refusal" and an empty content
  // array. Reading content[0] blindly would throw; ignoring stop_reason would
  // silently record zero summaries as success.
  const root = box({ 'a.txt': 'hello' });
  const stub = await stubApi(() => ({ stop_reason: 'refusal', content: [], usage: {} }));

  const res = await withStub(stub, () => summarize({ root, paths: ['a.txt'] }));
  assert.deepEqual(res.summaries, {});
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].why, /declined|unparseable/);
});

test('an HTTP error is reported with the API status', async () => {
  const root = box({ 'a.txt': 'hello' });
  const stub = await stubApi(() => ({ __status: 429, error: { message: 'rate limited' } }));

  await withStub(stub, async () => {
    await assert.rejects(() => summarize({ root, paths: ['a.txt'] }), /429/);
  });
});

test('a fenced JSON reply is still parsed', async () => {
  const root = box({ 'a.txt': 'hello' });
  const stub = await stubApi(() => ({
    content: [{ type: 'text', text: '```json\n{"a.txt": "a greeting"}\n```' }],
    usage: {},
  }));
  const res = await withStub(stub, () => summarize({ root, paths: ['a.txt'] }));
  assert.equal(res.summaries['a.txt'], 'a greeting');
});

test('an unparseable reply skips that batch instead of corrupting the plan', async () => {
  const root = box({ 'a.txt': 'hello' });
  const stub = await stubApi(() => ({ content: [{ type: 'text', text: 'I cannot do that' }], usage: {} }));
  const res = await withStub(stub, () => summarize({ root, paths: ['a.txt'] }));
  assert.deepEqual(res.summaries, {});
  assert.match(res.skipped[0].why, /unparseable/);
  assert.deepEqual(loadPlan(root).summaries, {}, 'nothing written');
});

test('files are batched rather than sent one request each', async () => {
  const files = {};
  const paths = [];
  for (let i = 0; i < 30; i++) {
    files[`f${i}.txt`] = `contents ${i}\n`;
    paths.push(`f${i}.txt`);
  }
  const root = box(files);
  const stub = await stubApi((body) => {
    // Reply for exactly the paths this batch asked about.
    const out = {};
    for (const p of paths) if (body.messages[0].content.includes(`path="${p}"`)) out[p] = `file ${p}`;
    return textReply(out);
  });

  const res = await withStub(stub, () => summarize({ root, paths }));
  assert.equal(Object.keys(res.summaries).length, 30);
  assert.ok(stub.seen.length >= 2 && stub.seen.length <= 5, `expected a few batches, got ${stub.seen.length}`);
});

test('already-summarized files are skipped unless forced', async () => {
  const root = box({ 'a.txt': 'hello', 'b.txt': 'world' });
  const first = await stubApi(() => textReply({ 'a.txt': 'A', 'b.txt': 'B' }));
  await withStub(first, () => summarize({ root, paths: ['a.txt', 'b.txt'] }));

  const second = await stubApi(() => textReply({ 'b.txt': 'B2' }));
  const res = await withStub(second, () => summarize({ root, paths: ['a.txt', 'b.txt'] }));
  assert.equal(second.seen.length, 0, 'nothing left to do, so no request at all');
  assert.deepEqual(res.summaries, {});

  const third = await stubApi(() => textReply({ 'a.txt': 'A3', 'b.txt': 'B3' }));
  const forced = await withStub(third, () => summarize({ root, paths: ['a.txt', 'b.txt'], force: true }));
  assert.equal(forced.summaries['a.txt'], 'A3');
});

test('binary and empty files never reach the API', async () => {
  const root = box({ 'good.txt': 'readable', 'empty.txt': '' });
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 7, 0]));
  const stub = await stubApi((body) => {
    assert.ok(!body.messages[0].content.includes('blob.bin'), 'binary must not be sent');
    return textReply({ 'good.txt': 'readable text' });
  });
  const res = await withStub(stub, () =>
    summarize({ root, paths: ['good.txt', 'empty.txt', 'blob.bin'] })
  );
  assert.deepEqual(Object.keys(res.summaries), ['good.txt']);
  const why = Object.fromEntries(res.skipped.map((s) => [s.path, s.why]));
  assert.equal(why['blob.bin'], 'binary');
  assert.equal(why['empty.txt'], 'empty');
});

test('with no API key, summarize points at the agent path instead of failing', async () => {
  const root = box({ 'a.txt': 'hello' });
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const res = await summarize({ root, paths: ['a.txt'] });
    assert.match(res.error, /--emit-prompts/, 'tells you the no-key route');
    assert.deepEqual(res.summaries, {});
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('emit-prompts writes a fillable stub and ingest merges it back', async () => {
  const root = box({ 'a.txt': 'hello', 'sub/b.txt': 'world' });
  const out = await emitPrompts({ root, paths: ['a.txt', 'sub/b.txt'] });
  assert.equal(out.count, 2);

  const stub = JSON.parse(readFileSync(out.outPath, 'utf8'));
  assert.deepEqual(stub, { 'a.txt': '', 'sub/b.txt': '' }, 'keys are node ids, values blank');

  writeFileSync(out.outPath, JSON.stringify({ 'a.txt': 'a greeting', 'sub/b.txt': '' }));
  const merged = ingestSummaries(root);
  assert.equal(merged.added, 1, 'blank entries are not merged as empty summaries');
  assert.equal(loadPlan(root).summaries['a.txt'], 'a greeting');
});

test('looksTextual: null bytes and control-heavy data are binary, UTF-8 is not', () => {
  assert.equal(looksTextual(Buffer.from('plain text\n')), true);
  assert.equal(looksTextual(Buffer.from('café naïve 中文\n', 'utf8')), true, 'UTF-8 is text');
  assert.equal(looksTextual(Buffer.from('a\0b')), false, 'NUL is decisive');
  assert.equal(looksTextual(Buffer.alloc(0)), true, 'empty is trivially text');
  const noisy = Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 2 ? 1 : 65)));
  assert.equal(looksTextual(noisy), false, 'control-dense data is binary even without a NUL');
});
