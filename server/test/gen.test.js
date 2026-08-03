import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import * as store from '../store.js';
import { mountBookRoutes } from '../routes/books.js';
import { mountGenRoutes } from '../routes/gen.js';

// 假 llm：章节正文固定，digest 返回合法 JSON
const fakeDeps = {
  async *streamChat() { yield '这是'; yield '正文'; },
  async nonStreamChat({ messages }) {
    const prompt = messages?.[0]?.content ?? '';
    if (prompt.includes('只输出书名')) return '《雾城追凶》';
    return JSON.stringify({
      chapterTitle: '第1章 · 夜雨来客',
      sectionTitle: '第一部：暗潮初现',
      summary: '小结A',
      progress: '下一步B',
      newCharacters: [{ name: '龙套甲', role: '路人', desc: 'x' }],
    });
  },
};

let base;
let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'novelbox-')); store.setDataRoot(root); });
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

async function readUntilText(res, expected) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  while (!out.includes(expected)) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return { reader, out };
}

async function readRest(reader) {
  const dec = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
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
    assert.equal(ch.title, '夜雨来客');
    assert.equal(ch.titleSource, 'ai');
    assert.equal(sec.title, '暗潮初现');
    assert.equal(sec.titleSource, 'ai');
    assert.equal(ch.characters[0].name, '龙套甲');
    // 冒泡
    assert.match(sec.progress, /下一步B/);
    const bk = await store.readBook(book.id);
    assert.match(bk.progress, /下一步B/);
  });
});

test('gen/chapter 在 digest 返回前已落盘正文', async () => {
  let releaseDigest;
  let digestStartedResolve;
  const digestStarted = new Promise((resolve) => { digestStartedResolve = resolve; });
  const digestResult = new Promise((resolve) => { releaseDigest = resolve; });
  const hangingDigestDeps = {
    async *streamChat() { yield '这是'; yield '正文'; },
    async nonStreamChat() {
      digestStartedResolve();
      return digestResult;
    },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const s = await store.addSection(book.id, {});
    const res = await post('/api/gen/chapter', { bookId: book.id, sectionId: s.id, mode: 'next' });
    const { reader, out } = await readUntilText(res, '正文');
    assert.match(out, /正文/);
    await digestStarted;

    try {
      const sec = await store.readSection(book.id, s.id);
      assert.equal(sec.chapters.length, 1);
      const ch = await store.readChapter(book.id, s.id, sec.chapters[0]);
      assert.equal(store.currentText(ch.body), '这是正文');
      assert.equal(ch.content, '这是正文');
    } finally {
      releaseDigest(JSON.stringify({
        chapterTitle: '夜雨来客',
        sectionTitle: '暗潮初现',
        summary: '小结A',
        progress: '下一步B',
        newCharacters: [],
      }));
      await readRest(reader);
    }
  }, hangingDigestDeps);
});

test('gen/chapter digest 迟到不覆盖期间保存的章节新版', async () => {
  let releaseDigest;
  let digestStartedResolve;
  const digestStarted = new Promise((resolve) => { digestStartedResolve = resolve; });
  const digestResult = new Promise((resolve) => { releaseDigest = resolve; });
  const hangingDigestDeps = {
    async *streamChat() { yield '这是'; yield '正文'; },
    async nonStreamChat() {
      digestStartedResolve();
      return digestResult;
    },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const s = await store.addSection(book.id, {});
    const res = await post('/api/gen/chapter', { bookId: book.id, sectionId: s.id, mode: 'next' });
    const { reader } = await readUntilText(res, '正文');
    await digestStarted;

    const sec = await store.readSection(book.id, s.id);
    const chapterId = sec.chapters[0];
    await store.versionSet(book.id, `section:${s.id}:chapter:${chapterId}`, '用户手动修订正文');

    releaseDigest(JSON.stringify({
      chapterTitle: '夜雨来客',
      sectionTitle: '暗潮初现',
      summary: '小结A',
      progress: '下一步B',
      newCharacters: [],
    }));
    await readRest(reader);

    const ch = await store.readChapter(book.id, s.id, chapterId);
    assert.deepEqual(ch.body.versions, ['', '这是正文', '用户手动修订正文']);
    assert.equal(store.currentText(ch.body), '用户手动修订正文');
    assert.equal(ch.summary, '小结A');
  }, hangingDigestDeps);
});

test('gen/chapter next 客户端停止后不继续落盘新章', async () => {
  let releaseStream;
  let streamSettledResolve;
  const allowStreamToContinue = new Promise((resolve) => { releaseStream = resolve; });
  const streamSettled = new Promise((resolve) => { streamSettledResolve = resolve; });
  const slowDeps = {
    async *streamChat() {
      try {
        yield '开头';
        await allowStreamToContinue;
        yield '后续';
      } finally {
        streamSettledResolve();
      }
    },
    async nonStreamChat() {
      return JSON.stringify({ summary: '小结A', progress: '下一步B', newCharacters: [] });
    },
  };

  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const ctrl = new AbortController();
    const res = await fetch(base + '/api/gen/chapter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: book.id, sectionId: s.id, mode: 'next' }),
      signal: ctrl.signal,
    });
    const { out } = await readUntilText(res, '开头');
    assert.match(out, /开头/);

    ctrl.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseStream();
    await streamSettled;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sec = await store.readSection(book.id, s.id);
    assert.equal(sec.chapters.length, 0);
    assert.equal(existsSync(join(root, 'books', book.id, s.id, 'chapter-01.json')), false);
  }, slowDeps);
});

test('gen/chapter next 客户端停止会中止上游 streamChat', async () => {
  let finishStream;
  let upstreamAbortResolve;
  const streamCanFinish = new Promise((resolve) => { finishStream = resolve; });
  const upstreamAborted = new Promise((resolve) => { upstreamAbortResolve = resolve; });
  const abortableDeps = {
    async *streamChat({ signal }) {
      yield '开头';
      signal?.addEventListener('abort', () => upstreamAbortResolve('aborted'), { once: true });
      await streamCanFinish;
    },
    async nonStreamChat() {
      return JSON.stringify({ summary: '小结A', progress: '下一步B', newCharacters: [] });
    },
  };

  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const ctrl = new AbortController();
    const res = await fetch(base + '/api/gen/chapter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: book.id, sectionId: s.id, mode: 'next' }),
      signal: ctrl.signal,
    });
    const { out } = await readUntilText(res, '开头');
    assert.match(out, /开头/);

    ctrl.abort();
    const abortResult = await Promise.race([
      upstreamAborted,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);
    finishStream();
    assert.equal(abortResult, 'aborted');
  }, abortableDeps);
});

test('非首个完成章节不改部名，manual 标题不被覆盖', async () => {
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const s = await store.addSection(book.id, { title: '人工部名', titleSource: 'manual' });
    const c = await store.addChapter(book.id, s.id, { title: '人工章名' });

    const res = await post('/api/gen/chapter', {
      bookId: book.id, sectionId: s.id, chapterId: c.id, mode: 'rewrite',
    });
    await readSSE(res);

    const section = await store.readSection(book.id, s.id);
    const chapter = await store.readChapter(book.id, s.id, c.id);
    assert.equal(section.title, '人工部名');
    assert.equal(section.titleSource, 'manual');
    assert.equal(chapter.title, '人工章名');
    assert.equal(chapter.titleSource, 'manual');
  });
});

test('已有完成章节时不再为默认部名自动命名', async () => {
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const s = await store.addSection(book.id, {});
    const first = await store.addChapter(book.id, s.id, {});
    first.body = { versions: ['已有正文'], cursor: 0 };
    await store.writeChapter(book.id, s.id, first.id, first);
    const second = await store.addChapter(book.id, s.id, {});

    const res = await post('/api/gen/chapter', {
      bookId: book.id, sectionId: s.id, chapterId: second.id, mode: 'rewrite',
    });
    await readSSE(res);
    const section = await store.readSection(book.id, s.id);
    assert.equal(section.title, '');
    assert.equal(section.titleSource, 'default');
  });
});

test('gen/chapter whip 把当前章原文交给 LLM 参考', async () => {
  let capturedInstruction = '';
  const whipDeps = {
    async *streamChat({ messages }) {
      capturedInstruction = messages?.[0]?.content ?? '';
      yield '改后正文';
    },
    async nonStreamChat() {
      return JSON.stringify({ summary: '新小结', progress: '新进展', newCharacters: [] });
    },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const s = await store.addSection(book.id, {});
    const c = await store.addChapter(book.id, s.id, {});
    await store.versionSet(book.id, `section:${s.id}:chapter:${c.id}`, '原始正文，有一场太平淡的争吵。');

    const res = await post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: s.id,
      chapterId: c.id,
      mode: 'whip',
      whip: '把争吵写得更尖锐',
    });
    const sse = await readSSE(res);

    assert.match(sse, /"done":true/);
    assert.match(capturedInstruction, /把争吵写得更尖锐/);
    assert.match(capturedInstruction, /原始正文，有一场太平淡的争吵。/);
  }, whipDeps);
});

test('version/rewrite path=outline 流式生成后写入 book.outline（版本化）', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写侦探故事' }));
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'outline' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    const bk = await store.readBook(book.id);
    assert.equal(store.currentText(bk.outline), '这是正文');
    assert.equal(bk.title, '雾城追凶');
    assert.equal(bk.titleSource, 'ai');
  });
});

test('manual 书名不被大纲生成覆盖', async () => {
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p', title: '人工书名' });
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'outline' });
    await readSSE(res);
    const bk = await store.readBook(book.id);
    assert.equal(bk.title, '人工书名');
    assert.equal(bk.titleSource, 'manual');
  });
});

test('书名生成失败不影响大纲完成', async () => {
  const deps = {
    async *streamChat() { yield '新大纲'; },
    async nonStreamChat() { throw new Error('TITLE_FAIL'); },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'outline' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    assert.doesNotMatch(sse, /"error"/);
    assert.equal(store.currentText((await store.readBook(book.id)).outline), '新大纲');
  }, deps);
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
  // 用闭包记录 fake LLM 收到的 instruction，验证版本化 outline 的当前文本真的被传入
  let capturedInstruction = '';
  const secDeps = {
    async *streamChat({ messages }) {
      capturedInstruction = messages?.[0]?.content ?? '';
      yield '第 1 部'; yield ' · 起源：xxx';
    },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写侦探故事' }));
    // 通过 versionSet 走版本化写路径（不能直接 book.outline.content = ...，那样迁移后读不到）
    await store.versionSet(book.id, 'outline', '我的全书大纲XYZ');

    const res = await post('/api/gen/sections', { bookId: book.id });
    const sse = await readSSE(res);
    assert.match(sse, /第 1 部/);
    assert.match(sse, /"done":true/);
    assert.match(sse, /"sections":/);
    // 关键断言：outline 当前版本文本真的到了 LLM 指令里（迁移契约端到端）
    assert.match(capturedInstruction, /我的全书大纲XYZ/);
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
    assert.equal(existsSync(join(root, 'books', book.id, s.id, 'chapter-01.json')), false);
  }, failDeps);
});
