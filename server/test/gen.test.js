import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import * as store from '../store.js';
import { mountBookRoutes } from '../routes/books.js';
import { mountGenRoutes } from '../routes/gen.js';

// 假 llm：章节正文固定，digest 返回合法 JSON
const fakeDeps = {
  async *streamChat() { yield '这是'; yield '正文'; },
  async nonStreamChat() {
    return '{"summary":"小结A","progress":"下一步B","newCharacters":[{"name":"龙套甲","role":"路人","desc":"x"}]}';
  },
};

let base;
beforeEach(() => { store.setDataRoot(mkdtempSync(join(tmpdir(), 'novelbox-'))); });
function appWithGen() {
  const app = express();
  app.use(express.json());
  mountBookRoutes(app);
  mountGenRoutes(app, fakeDeps);
  return app;
}
async function withServer(fn) {
  const server = appWithGen().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(); } finally { server.close(); }
}
const j = (r) => r.json();
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

// 读取整个 SSE 流为文本
async function readSSE(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  while (true) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value); }
  return out;
}

test('gen/chapter next 生成正文并落盘 + digest 冒泡', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const res = await post('/api/gen/chapter', { bookId: book.id, sectionId: s.id, mode: 'next' });
    const sse = await readSSE(res);
    assert.match(sse, /这是/);
    assert.match(sse, /正文/);
    assert.match(sse, /"done":true/);

    const sec = await store.readSection(book.id, s.id);
    assert.equal(sec.chapters.length, 1);
    const ch = await store.readChapter(book.id, s.id, sec.chapters[0]);
    assert.equal(ch.content, '这是正文');
    assert.equal(ch.summary, '小结A');
    assert.equal(ch.progress, '下一步B');
    assert.equal(ch.characters[0].name, '龙套甲');
    // 冒泡
    assert.match(sec.progress, /下一步B/);
    const bk = await store.readBook(book.id);
    assert.match(bk.progress, /下一步B/);
  });
});

test('gen/outline 生成后写入 book.outline', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写侦探故事' }));
    const res = await post('/api/gen/outline', { bookId: book.id });
    await readSSE(res);
    const bk = await store.readBook(book.id);
    assert.equal(bk.outline.content, '这是正文');
  });
});
