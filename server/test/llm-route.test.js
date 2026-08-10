import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.js';
import { createApp } from '../index.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(async () => {
  root = makeTestTempDir('novelbox-llm-route-');
  store.setDataRoot(root);
  await store.writeConfig({ baseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'k' });
});
afterEach(cleanupTestTempDirs);

async function withPartialUpstream(fn, upstreamBody = (
  'data: {"choices":[{"delta":{"content":"半截内容"}}]}\n\n'
)) {
  const realFetch = globalThis.fetch;
  const started = await startTestServer(createApp());
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('https://model.test/')) {
      return new Response(
        upstreamBody,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    return realFetch(input, init);
  };
  try { await fn(started.base); }
  finally {
    globalThis.fetch = realFetch;
    await stopTestServer(started.server);
  }
}

test('真实重写路由不保存缺少终止标记的部分输出', async () => {
  const book = await store.createBook({ premise: 'p', title: 't' });
  await withPartialUpstream(async (base) => {
    const response = await fetch(`${base}/api/books/${book.id}/version/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'outline',
        expectedRevision: store.versionRevision(book.outline),
      }),
    });
    const sse = await response.text();
    assert.match(sse, /半截内容/);
    assert.match(sse, /LLM_STREAM_INCOMPLETE/);
    assert.doesNotMatch(sse, /"saved":true/);
    assert.equal(store.currentText((await store.readBook(book.id)).outline), '');
  });
});

test('真实下一章路由在部分输出断流后删除未落盘的新章', async () => {
  const book = await store.createBook({ premise: 'p', title: 't' });
  const section = await store.addSection(book.id, {});
  const updatedAtBeforeGeneration = (await store.readBook(book.id)).updatedAt;
  await withPartialUpstream(async (base) => {
    const response = await fetch(`${base}/api/gen/chapter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: book.id,
        sectionId: section.id,
        mode: 'next',
        expectedLastChapterId: null,
      }),
    });
    const sse = await response.text();
    assert.match(sse, /半截内容/);
    assert.match(sse, /LLM_STREAM_INCOMPLETE/);
    assert.deepEqual((await store.readSection(book.id, section.id)).chapters, []);
    assert.equal((await store.readBook(book.id)).updatedAt, updatedAtBeforeGeneration);
  });
});

test('真实重写路由不会让后续 stop 覆盖 length 并保存截断输出', async () => {
  const book = await store.createBook({ premise: 'p', title: 't' });
  const upstreamBody =
    'data: {"choices":[{"delta":{"content":"截断的大纲"}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
    + 'data: {"choices":[{"delta":{"content":"伪完整尾段"},"finish_reason":"stop"}]}\n\n'
    + 'data: [DONE]\n\n';

  await withPartialUpstream(async (base) => {
    const response = await fetch(`${base}/api/books/${book.id}/version/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'outline',
        expectedRevision: store.versionRevision(book.outline),
      }),
    });
    const sse = await response.text();

    assert.match(sse, /截断的大纲/);
    assert.doesNotMatch(sse, /伪完整尾段/);
    assert.match(sse, /LLM_FINISH_LENGTH/);
    assert.doesNotMatch(sse, /"saved":true/);
    assert.equal(store.currentText((await store.readBook(book.id)).outline), '');
  }, upstreamBody);
});

test('真实重写路由不保存含非法 UTF-8 的模型流', async () => {
  const book = await store.createBook({ premise: 'p', title: 't' });
  const upstreamBody = Buffer.from(
    'data: {"choices":[{"delta":{"content":"可信大纲"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  );
  const textOffset = upstreamBody.indexOf(Buffer.from('可信大纲'));
  assert.ok(textOffset >= 0);
  upstreamBody[textOffset] = 0xff;

  await withPartialUpstream(async (base) => {
    const response = await fetch(`${base}/api/books/${book.id}/version/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'outline',
        expectedRevision: store.versionRevision(book.outline),
      }),
    });
    const sse = await response.text();

    assert.match(sse, /LLM_SSE_INVALID_UTF8/);
    assert.doesNotMatch(sse, /"saved":true/);
    assert.equal(store.currentText((await store.readBook(book.id)).outline), '');
  }, upstreamBody);
});
