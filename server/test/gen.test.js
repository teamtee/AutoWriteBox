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
function appWithGen(deps = fakeDeps) {
  const app = express();
  app.use(express.json());
  mountBookRoutes(app);
  mountGenRoutes(app, deps);
  return app;
}
async function withServer(fn, deps) {
  const server = appWithGen(deps).listen(0);
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

// gen/chapter 正文写入 chapter.body（版本化），content 由 writeChapter 从 body 派生
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
    // 正文进入版本化 body；content 仍等值（派生）
    assert.equal(store.currentText(ch.body), '这是正文');
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

test('version/rewrite path=outline 流式生成后写入 book.outline（版本化）', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写侦探故事' }));
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'outline' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    const bk = await store.readBook(book.id);
    assert.equal(store.currentText(bk.outline), '这是正文');
  });
});

test('version/rewrite path=core:world 写入 settings.core.world（版本化）', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写侦探故事' }));
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'core:world' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    const bk = await store.readBook(book.id);
    assert.equal(store.currentText(bk.settings.core.world), '这是正文');
  });
});

test('version/rewrite 章节 path 报错，不走章节管线', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const res = await post(`/api/books/${book.id}/version/rewrite`, {
      path: 'section:section-01:chapter:chapter-01',
    });
    const sse = await readSSE(res);
    assert.match(sse, /"error"/);
    assert.match(sse, /章节请用/);
  });
});

test('gen/chapter digest 解析失败时不覆盖已有 progress/summary（断片保护）', async () => {
  // 变体：正文正常，digest 返回不可解析的 JSON 文本
  const badDigestDeps = {
    async *streamChat() { yield '这是'; yield '正文'; },
    async nonStreamChat() { return '抱歉我不会'; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    // 预置已有进度路标
    const bk0 = await store.readBook(book.id);
    bk0.progress = '原路标';
    await store.writeBook(book.id, bk0);
    const sec0 = await store.readSection(book.id, s.id);
    sec0.progress = '原路标';
    sec0.summary = '原摘要';
    await store.writeSection(book.id, s.id, sec0);

    const res = await post('/api/gen/chapter', { bookId: book.id, sectionId: s.id, mode: 'next' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);

    const sec = await store.readSection(book.id, s.id);
    assert.equal(sec.chapters.length, 1);
    const ch = await store.readChapter(book.id, s.id, sec.chapters[0]);
    // 正文已落盘（版本化 body）
    assert.equal(store.currentText(ch.body), '这是正文');
    assert.equal(ch.content, '这是正文');
    // 已有 progress/summary 未被空值覆盖
    const bk = await store.readBook(book.id);
    assert.equal(bk.progress, '原路标');
    assert.equal(sec.progress, '原路标');
    assert.equal(sec.summary, '原摘要');
  }, badDigestDeps);
});

test('gen/sections 流式返回分部建议，不自动建部', async () => {
  const secDeps = {
    async *streamChat() { yield '第 1 部'; yield ' · 起源：xxx'; },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写侦探故事' }));
    // 先给 book.outline 塞点内容
    const bk = await store.readBook(book.id);
    bk.outline.content = '全书总大纲：...';
    await store.writeBook(book.id, bk);

    const res = await post('/api/gen/sections', { bookId: book.id });
    const sse = await readSSE(res);
    assert.match(sse, /第 1 部/);
    assert.match(sse, /"done":true/);
    assert.match(sse, /"sections":/);
    // 不自动建部
    const bk2 = await store.readBook(book.id);
    assert.deepEqual(bk2.sections, []);
  }, secDeps);
});

test('gen/chapter next 中途抛错时回滚空章，不残留', async () => {
  const failDeps = {
    async *streamChat() { throw new Error('BOOM'); },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const res = await post('/api/gen/chapter', { bookId: book.id, sectionId: s.id, mode: 'next' });
    const sse = await readSSE(res);
    assert.match(sse, /"error"/);
    const sec = await store.readSection(book.id, s.id);
    assert.equal(sec.chapters.length, 0);  // 已回滚，不残留
  }, failDeps);
});
