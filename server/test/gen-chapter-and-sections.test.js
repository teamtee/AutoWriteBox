import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import * as store from '../store.js';
import { mountBookRoutes } from '../routes/books.js';
import { mountGenRoutes, writeSseEventWithBackpressure } from '../routes/gen.js';
import {
  MAX_LLM_INPUT_CHARS, MAX_SECTION_PROMPT_SUMMARY_CHARS,
  MAX_STORED_CHARACTERS, MAX_VERSION_TEXT_CHARS, MAX_WHIP_CHARS,
} from '../limits.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';
import {
  WORLD_APPEAL_SCENE_FIELDS, WORLD_APPEAL_SCENE_LABELS,
  WORLD_BIBLE_SECTION_LABELS, WORLD_KNOWLEDGE_BOUNDARY_LABELS,
  WORLD_REVEAL_STAGE_FIELDS, WORLD_REVEAL_STAGE_LABELS,
} from '../world-bible.js';
import { STYLE_BIBLE_SECTION_LABELS } from '../style-bible.js';
import { validSectionPlanFixture, validWorldBibleFixture } from './section-plan-fixture.js';
import { validChapterPlanFixture } from './chapter-plan-fixture.js';

// 假 llm：章节正文固定，digest 返回合法 JSON，审稿返回 review JSON
const fakeDeps = {
  async *streamChat() { yield '这是'; yield '正文'; },
  async nonStreamChat({ messages }) {
    const prompt = messages?.[0]?.content ?? '';
    if (prompt.includes('只输出书名')) return '《雾城追凶》';
    if (prompt.includes('审阅第')) {
      return JSON.stringify({
        score: 78,
        verdict: '冲突成立，中段推进偏松',
        issues: [{ title: '冲突弱', detail: '缺少导火索' }],
        suggestions: [{ label: '强化冲突', instruction: '把争吵写清楚' }],
      });
    }
    if (prompt.includes('以下是正文')) {
      assert.match(prompt, /"characters"/);
      assert.match(prompt, /包括已有角色/);
    }
    return JSON.stringify({
      chapterTitle: '第1章 · 夜雨来客',
      sectionTitle: '第一部：暗潮初现',
      summary: '小结A',
      progress: '下一步B',
      characters: [{ name: '陈默', role: '主角', desc: '本章末负伤' }],
    });
  },
};

let base;
let root;
beforeEach(() => { root = makeTestTempDir('novelbox-'); store.setDataRoot(root); });
afterEach(cleanupTestTempDirs);
function appWithGen(deps = fakeDeps) {
  const app = express();
  app.use(express.json());
  mountBookRoutes(app);
  mountGenRoutes(app, { allowLegacyNextForTests: true, ...deps });
  return app;
}
async function withServer(fn, deps) {
  const started = await startTestServer(appWithGen(deps));
  base = started.base;
  try { await fn(); } finally { await stopTestServer(started.server); }
}
const j = (r) => r.json();
const rawPost = (p, body) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});
const post = async (p, b) => {
  let body = b || {};
  const sectionRoute = p.match(/^\/api\/books\/([^/]+)\/sections$/);
  const chapterRoute = p.match(/^\/api\/books\/([^/]+)\/sections\/([^/]+)\/chapters$/);
  if (sectionRoute
    && !Object.prototype.hasOwnProperty.call(body, 'expectedLastSectionId')) {
    const book = await store.readBook(sectionRoute[1]);
    body = {
      ...body,
      expectedLastSectionId: book.sections.length
        ? book.sections[book.sections.length - 1]
        : null,
    };
  } else if (chapterRoute
    && !Object.prototype.hasOwnProperty.call(body, 'expectedLastChapterId')) {
    const section = await store.readSection(chapterRoute[1], chapterRoute[2]);
    body = {
      ...body,
      expectedLastChapterId: section.chapters.length
        ? section.chapters[section.chapters.length - 1]
        : null,
    };
  }
  const rewriteRoute = p.match(/^\/api\/books\/([^/]+)\/version\/rewrite$/);
  if (rewriteRoute
    && !Object.prototype.hasOwnProperty.call(body, 'expectedRevision')) {
    try {
      const parsed = store.parseVersionPath(body.path);
      if (parsed.type !== 'chapter') {
        const book = await store.readBook(rewriteRoute[1]);
        const target = parsed.type === 'outline'
          ? book.outline
          : book.settings.core[parsed.field];
        body = { ...body, expectedRevision: store.versionRevision(target) };
      }
    } catch { /* 非法路径由真实路由返回稳定错误。 */ }
  }
  if (p === '/api/gen/chapter' && ['rewrite', 'whip'].includes(body.mode)
    && !Object.prototype.hasOwnProperty.call(body, 'expectedRevision')) {
    const chapter = await store.readChapter(body.bookId, body.sectionId, body.chapterId);
    body = { ...body, expectedRevision: store.versionRevision(chapter.body) };
  }
  if (p === '/api/gen/sections'
    && !Object.prototype.hasOwnProperty.call(body, 'expectedContextRevision')) {
    const book = await store.readBook(body.bookId);
    body = {
      ...body,
      expectedContextRevision: store.sectionPlanContextRevision(book),
    };
  }
  // 正常客户端的 next 请求总会携带它当前看到的末章；多数用例只关心
  // 其它生成语义，由测试请求助手补上最新锚点以保持意图清晰。
  if (p === '/api/gen/chapter' && body.mode === 'next'
    && !Object.prototype.hasOwnProperty.call(body, 'expectedLastChapterId')) {
    const section = await store.readSection(body.bookId, body.sectionId);
    body = {
      ...body,
      expectedLastChapterId: section.chapters.length
        ? section.chapters[section.chapters.length - 1]
        : null,
    };
  }
  return rawPost(p, body);
};

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

async function waitForInvariant(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await check(); }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw lastError || new Error('INVARIANT_TIMEOUT');
}

function pausedStreamDeps(output) {
  let notifyStarted;
  let releaseStream;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const canFinish = new Promise((resolve) => { releaseStream = resolve; });
  return {
    started,
    release: () => releaseStream(),
    deps: {
      async *streamChat() {
        notifyStarted();
        await canFinish;
        yield output;
      },
      async nonStreamChat() { return ''; },
    },
  };
}

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

test('gen/chapter rewrite 把当前章原文交给 LLM 参考', async () => {
  let capturedInstruction = '';
  const rewriteDeps = {
    async *streamChat({ messages }) {
      capturedInstruction = messages?.[0]?.content ?? '';
      yield '换一种写法后的正文';
    },
    async nonStreamChat() { return '{}'; },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});
    await store.versionSet(
      book.id,
      `section:${section.id}:chapter:${chapter.id}`,
      '旧稿中的关键线索与人物关系。',
    );

    const response = await post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: section.id,
      chapterId: chapter.id,
      mode: 'rewrite',
    });
    const sse = await readSSE(response);

    assert.match(sse, /"done":true/);
    assert.match(capturedInstruction, /【当前章原文】/);
    assert.match(capturedInstruction, /旧稿中的关键线索与人物关系。/);
  }, rewriteDeps);
});

test('gen/chapter 把已保存章节策划卡交给生成模型', async () => {
  let capturedInstruction = '';
  const deps = {
    async *streamChat({ messages }) {
      capturedInstruction = messages?.[0]?.content ?? '';
      yield '按策划写出的正文';
    },
    async nonStreamChat() { return '{}'; },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: '策划生成' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});
    await store.saveChapterPlan(book.id, section.id, chapter.id, validChapterPlanFixture({
      goal: '追回账册', obstacle: '旧友拦路', choice: '主角说出旧案真相',
      payoff: '旧友让路', hook: '账册最后一页被撕走',
      scenes: [{
        title: '桥上拦截', trigger: '承接账册被抢后的追赶',
        desire: '主角要越过石桥', obstacle: '旧友拔刀拦路',
        action: '主角公开旧案证据', turn: '旧友收刀让路', cost: '证据来源暴露',
      }],
    }), { expectedRevision: store.chapterPlanView(chapter.plan).revision });

    const response = await post('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, chapterId: chapter.id, mode: 'rewrite',
    });
    assert.match(await readSSE(response), /"done":true/);
    assert.match(capturedInstruction, /本章策划卡（作者意图）/);
    assert.match(capturedInstruction, /本章目标：追回账册/);
    assert.match(capturedInstruction, /章末钩子：账册最后一页被撕走/);
    assert.match(capturedInstruction, /场景1 · 桥上拦截/);
    assert.match(capturedInstruction, /转折=旧友收刀让路/);
  }, deps);
});

test('gen/chapter 为新分部首章跳过尾部空章并传入最后有效前情', async () => {
  let capturedInstruction = '';
  const captureDeps = {
    async *streamChat({ messages }) {
      capturedInstruction = messages?.[0]?.content ?? '';
      yield '承接上一部的新正文';
    },
    async nonStreamChat() { return '{}'; },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const previousSection = await store.addSection(book.id, {});
    const previous = await store.addChapter(book.id, previousSection.id, {});
    await store.versionSet(
      book.id,
      `section:${previousSection.id}:chapter:${previous.id}`,
      '上一部结尾：风暴中的灯塔突然熄灭。',
    );
    const savedPrevious = await store.readChapter(
      book.id, previousSection.id, previous.id,
    );
    await store.applyChapterDigest(book.id, previousSection.id, previous.id, {
      progress: '前往灯塔地下室寻找熄灭原因',
      newCharacters: [{ name: '老守灯人', role: '证人', desc: '隐瞒灯塔的旧秘密' }],
    }, { expectedBodyFingerprint: savedPrevious.bodyFingerprint });
    await store.addChapter(book.id, previousSection.id, {});
    const emptySection = await store.addSection(book.id, {});
    await store.addChapter(book.id, emptySection.id, {});
    const targetSection = await store.addSection(book.id, {});
    const target = await store.addChapter(book.id, targetSection.id, {});
    await store.saveChapterPlan(book.id, targetSection.id, target.id,
      validChapterPlanFixture(),
      { expectedRevision: store.chapterPlanView(target.plan).revision });

    const response = await post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: targetSection.id,
      chapterId: target.id,
      mode: 'rewrite',
    });
    const sse = await readSSE(response);

    assert.match(sse, /"saved":true/);
    assert.match(capturedInstruction, /【上一章结尾】上一部结尾：风暴中的灯塔突然熄灭。/);
    assert.match(capturedInstruction, /【上一章摘要 API 给出的后续走向建议（不是事实或已确认计划）】前往灯塔地下室寻找熄灭原因/);
    assert.match(capturedInstruction, /老守灯人（证人）：隐瞒灯塔的旧秘密/);
  }, captureDeps);
});

test('gen/chapter whip 拒绝空指令且不调用 LLM', async () => {
  let streamCalls = 0;
  const deps = {
    async *streamChat() { streamCalls += 1; yield '不应生成'; },
    async nonStreamChat() { return '{}'; },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const s = await store.addSection(book.id, {});
    const c = await store.addChapter(book.id, s.id, {});
    await store.versionSet(book.id, `section:${s.id}:chapter:${c.id}`, '原正文');

    const res = await post('/api/gen/chapter', {
      bookId: book.id, sectionId: s.id, chapterId: c.id, mode: 'whip', whip: '   ',
    });
    const sse = await readSSE(res);

    assert.match(sse, /BAD_WHIP/);
    assert.equal(streamCalls, 0);
    assert.equal(store.currentText((await store.readChapter(book.id, s.id, c.id)).body), '原正文');
  }, deps);
});

test('gen/chapter 任意模式都拒绝非字符串 whip，不误报内部错误或新建空章', async () => {
  let streamCalls = 0;
  const deps = {
    async *streamChat() { streamCalls += 1; yield '不应生成'; },
    async nonStreamChat() { return '{}'; },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});

    const response = await post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: section.id,
      mode: 'next',
      expectedLastChapterId: null,
      whip: { unexpected: true },
    });
    const sse = await readSSE(response);

    assert.match(sse, /BAD_WHIP/);
    assert.doesNotMatch(sse, /INTERNAL_ERROR/);
    assert.equal(streamCalls, 0);
    assert.deepEqual((await store.readSection(book.id, section.id)).chapters, []);
  }, deps);
});

test('gen/chapter whip 拒绝超长指令且不调用 LLM', async () => {
  let streamCalls = 0;
  const deps = {
    async *streamChat() { streamCalls += 1; yield '不应生成'; },
    async nonStreamChat() { return '{}'; },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});
    await store.versionSet(book.id, `section:${section.id}:chapter:${chapter.id}`, '原正文');

    const response = await post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: section.id,
      chapterId: chapter.id,
      mode: 'whip',
      whip: 'x'.repeat(MAX_WHIP_CHARS + 1),
    });
    const sse = await readSSE(response);

    assert.match(sse, /WHIP_TOO_LARGE/);
    assert.equal(streamCalls, 0);
    assert.equal(
      store.currentText((await store.readChapter(book.id, section.id, chapter.id)).body),
      '原正文',
    );
  }, deps);
});

test('gen/chapter whip 拒绝空正文且不调用 LLM', async () => {
  let streamCalls = 0;
  const deps = {
    async *streamChat() { streamCalls += 1; yield '不应生成'; },
    async nonStreamChat() { return '{}'; },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const s = await store.addSection(book.id, {});
    const c = await store.addChapter(book.id, s.id, {});

    const res = await post('/api/gen/chapter', {
      bookId: book.id, sectionId: s.id, chapterId: c.id, mode: 'whip', whip: '增强冲突',
    });
    const sse = await readSSE(res);

    assert.match(sse, /CHAPTER_EMPTY/);
    assert.equal(streamCalls, 0);
    assert.deepEqual((await store.readChapter(book.id, s.id, c.id)).body.versions, ['']);
  }, deps);
});

test('gen/chapter 非法 mode 返回错误且不写入章节版本', async () => {
  const deps = {
    async *streamChat() { yield '非法生成正文'; },
    async nonStreamChat() {
      return JSON.stringify({ summary: '不应写入', progress: '不应写入', newCharacters: [] });
    },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const s = await store.addSection(book.id, {});
    const c = await store.addChapter(book.id, s.id, {});
    await store.versionSet(book.id, `section:${s.id}:chapter:${c.id}`, '原正文');

    const res = await post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: s.id,
      chapterId: c.id,
      mode: 'evil',
    });
    const sse = await readSSE(res);

    assert.match(sse, /"error"/);
    assert.match(sse, /BAD_MODE/);
    const ch = await store.readChapter(book.id, s.id, c.id);
    assert.deepEqual(ch.body.versions, ['', '原正文']);
    assert.equal(store.currentText(ch.body), '原正文');
    assert.equal(ch.summary, '');
  }, deps);
});

test('gen/chapter 在孤立分部上生成前失败，不消耗模型调用', async () => {
  let streamCalls = 0;
  const deps = {
    async *streamChat() { streamCalls += 1; yield '不应生成'; },
    async nonStreamChat() { return '{}'; },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    book.sections = [];
    await store.writeBook(book.id, book);

    const response = await post('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, mode: 'next',
    });
    const sse = await readSSE(response);

    assert.match(sse, /SECTION_NOT_FOUND/);
    assert.equal(streamCalls, 0);
    assert.deepEqual((await store.readSection(book.id, section.id)).chapters, []);
  }, deps);
});

test('gen/chapter 空请求体返回 SSE 错误且服务保持可用', async () => {
  await withServer(async () => {
    const response = await fetch(base + '/api/gen/chapter', { method: 'POST' });
    const sse = await readSSE(response);
    assert.match(sse, /"error"/);
    assert.match(sse, /BAD_MODE/);

    const books = await fetch(base + '/api/books');
    assert.equal(books.status, 200);
    assert.deepEqual(await books.json(), []);
  });
});

test('重写接口缺少版本修订号时在调用模型前拒绝', async () => {
  let streamCalls = 0;
  const deps = {
    ...fakeDeps,
    async *streamChat() { streamCalls += 1; yield '不应生成'; },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: '旧页面重写保护' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});

    const bookRewrite = await rawPost(`/api/books/${book.id}/version/rewrite`, {
      path: 'outline',
    });
    assert.match(await readSSE(bookRewrite), /BAD_VERSION_REVISION/);

    const chapterRewrite = await rawPost('/api/gen/chapter', {
      bookId: book.id,
      sectionId: section.id,
      chapterId: chapter.id,
      mode: 'rewrite',
    });
    assert.match(await readSSE(chapterRewrite), /BAD_VERSION_REVISION/);
    assert.equal(streamCalls, 0);
    assert.deepEqual((await store.readBook(book.id)).outline.versions, ['']);
    assert.deepEqual(
      (await store.readChapter(book.id, section.id, chapter.id)).body.versions,
      [''],
    );
  }, deps);
});

test('version/rewrite path=outline 流式生成后写入 book.outline（版本化）', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写侦探故事' }));
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'outline' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    assert.doesNotMatch(sse, /postprocessWarnings/);
    assert.doesNotMatch(sse, /"versions"|"cursor"/);
    const bk = await store.readBook(book.id);
    assert.equal(store.currentText(bk.outline), '这是正文');
    assert.equal(bk.title, '雾城追凶');
    assert.equal(bk.titleSource, 'ai');
  });
});

test('version/rewrite 客户端在提交锁等待期间停止后不迟到落盘', async () => {
  await withServer(async () => {
    const book = await store.createBook({ premise: '写侦探故事' });
    const expectedRevision = store.versionRevision(book.outline);
    let releaseBookLock;
    let markBookLockHeld;
    const bookLockHeld = new Promise((resolve) => { markBookLockHeld = resolve; });
    const blocker = store.withStoreLock(`book:${book.id}:book-json`, async () => {
      markBookLockHeld();
      await new Promise((resolve) => { releaseBookLock = resolve; });
    });
    await bookLockHeld;

    const ctrl = new AbortController();
    const response = await fetch(`${base}/api/books/${book.id}/version/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'outline', expectedRevision }),
      signal: ctrl.signal,
    });
    const { reader, out } = await readUntilText(response, '正文');
    assert.match(out, /正文/);
    // 给路由一次事件循环机会进入被占用的作品锁，再模拟用户点击停止。
    await new Promise((resolve) => setTimeout(resolve, 30));
    ctrl.abort();
    await new Promise((resolve) => setImmediate(resolve));
    const afterRoute = store.withStoreLock(`book:${book.id}:book-json`, async () => {});

    releaseBookLock();
    await blocker;
    await afterRoute;
    await reader.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual((await store.readBook(book.id)).outline.versions, ['']);
  });
});

test('version/rewrite outline 自动书名阶段客户端停止后不继续写入书名', async () => {
  let titleStartedResolve;
  let releaseTitle;
  let titleFinishedResolve;
  const titleStarted = new Promise((resolve) => { titleStartedResolve = resolve; });
  const titleCanReturn = new Promise((resolve) => { releaseTitle = resolve; });
  const titleFinished = new Promise((resolve) => { titleFinishedResolve = resolve; });
  const titleDeps = {
    async *streamChat() { yield '新'; yield '大纲'; },
    async nonStreamChat() {
      titleStartedResolve();
      await titleCanReturn;
      titleFinishedResolve();
      return '《雾城追凶》';
    },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: '写侦探故事' });
    const expectedRevision = store.versionRevision((await store.readBook(book.id)).outline);
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/books/${book.id}/version/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'outline', expectedRevision }),
      signal: ctrl.signal,
    });
    await readUntilText(res, '大纲');
    await titleStarted;

    ctrl.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseTitle();
    await titleFinished;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const bk = await store.readBook(book.id);
    assert.equal(store.currentText(bk.outline), '新大纲');
    assert.equal(bk.title, '写侦探故事');
    assert.equal(bk.titleSource, 'default');
  }, titleDeps);
});

test('version/rewrite outline 自动书名清洗后客户端停止不继续写入书名', async () => {
  let ctrl;
  let notifyTitleCleaned;
  const titleCleaned = new Promise((resolve) => { notifyTitleCleaned = resolve; });
  const titleDeps = {
    async *streamChat() { yield '新'; yield '大纲'; },
    async nonStreamChat() {
      return {
        toString() {
          notifyTitleCleaned();
          ctrl.abort();
          return '《雾城追凶》';
        },
      };
    },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: '写侦探故事' });
    const expectedRevision = store.versionRevision((await store.readBook(book.id)).outline);
    ctrl = new AbortController();
    const res = await fetch(`${base}/api/books/${book.id}/version/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'outline', expectedRevision }),
      signal: ctrl.signal,
    });
    await readUntilText(res, '大纲');
    await titleCleaned;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const bk = await store.readBook(book.id);
    assert.equal(store.currentText(bk.outline), '新大纲');
    assert.equal(bk.title, '写侦探故事');
    assert.equal(bk.titleSource, 'default');
  }, titleDeps);
});

test('version/rewrite outline 不写入基于已经过时大纲的自动书名', async () => {
  let notifyTitleStarted;
  let releaseTitle;
  const titleStarted = new Promise((resolve) => { notifyTitleStarted = resolve; });
  const titleCanFinish = new Promise((resolve) => { releaseTitle = resolve; });
  const deps = {
    async *streamChat() { yield 'AI 第一版大纲'; },
    async nonStreamChat() {
      notifyTitleStarted();
      await titleCanFinish;
      return '迟到旧书名';
    },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const response = await post(`/api/books/${book.id}/version/rewrite`, { path: 'outline' });
    const { reader, out } = await readUntilText(response, '"saved":true');
    assert.match(out, /"saved":true/);
    await titleStarted;
    try {
      await store.versionSet(book.id, 'outline', '另一页面的新大纲');
    } finally {
      releaseTitle();
    }
    const rest = await readRest(reader);
    assert.match(rest, /"done":true/);
    assert.match(rest, /"postprocessWarnings":\["title"\]/);

    const saved = await store.readBook(book.id);
    assert.equal(store.currentText(saved.outline), '另一页面的新大纲');
    assert.equal(saved.titleSource, 'default');
    assert.notEqual(saved.title, '迟到旧书名');
  }, deps);
});

test('manual 书名不被大纲生成覆盖', async () => {
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p', title: '人工书名' });
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'outline' });
    const sse = await readSSE(res);
    assert.doesNotMatch(sse, /postprocessWarnings/);
    const bk = await store.readBook(book.id);
    assert.equal(bk.title, '人工书名');
    assert.equal(bk.titleSource, 'manual');
  });
});

test('自动书名返回前发生人工改名时不覆盖也不误报降级', async () => {
  let notifyTitleStarted;
  let releaseTitle;
  const titleStarted = new Promise((resolve) => { notifyTitleStarted = resolve; });
  const titleCanFinish = new Promise((resolve) => { releaseTitle = resolve; });
  const deps = {
    async *streamChat() { yield '新大纲'; },
    async nonStreamChat() {
      notifyTitleStarted();
      await titleCanFinish;
      return '迟到自动书名';
    },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const response = await post(`/api/books/${book.id}/version/rewrite`, { path: 'outline' });
    const { reader } = await readUntilText(response, '"saved":true');
    await titleStarted;
    try {
      await store.renameBook(book.id, '人工书名', { expectedTitle: 'p' });
    } finally {
      releaseTitle();
    }
    const rest = await readRest(reader);
    assert.match(rest, /"done":true/);
    assert.doesNotMatch(rest, /postprocessWarnings/);
    const saved = await store.readBook(book.id);
    assert.equal(saved.title, '人工书名');
    assert.equal(saved.titleSource, 'manual');
  }, deps);
});

test('自动书名为空时大纲仍完成并报告后处理告警', async () => {
  const deps = {
    async *streamChat() { yield '新大纲'; },
    async nonStreamChat() { return '《 》'; },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'outline' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    assert.match(sse, /"postprocessWarnings":\["title"\]/);
    const saved = await store.readBook(book.id);
    assert.equal(saved.title, 'p');
    assert.equal(saved.titleSource, 'default');
  }, deps);
});

test('书名生成失败时大纲仍完成并报告后处理告警', async () => {
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
    assert.match(sse, /"postprocessWarnings":\["title"\]/);
    assert.equal(store.currentText((await store.readBook(book.id)).outline), '新大纲');
  }, deps);
});

test('version/rewrite path=core:world 写入 settings.core.world（版本化）', async () => {
  let capturedSystem = '';
  let capturedInstruction = '';
  const worldBible = WORLD_BIBLE_SECTION_LABELS.map((label, index) => {
    const content = label === '持续看点与标志性场面'
      ? WORLD_APPEAL_SCENE_LABELS.map((scene, sceneIndex) =>
        `〔${scene}〕${WORLD_APPEAL_SCENE_FIELDS.map((field) =>
          `${field}：${sceneIndex + 1}号机制迫使人物采取现场行动`).join('；')}`).join('\n')
      : label === '秘密分层与认知边界'
        ? WORLD_KNOWLEDGE_BOUNDARY_LABELS.map((boundary, boundaryIndex) =>
          `〔${boundary}〕${boundaryIndex + 1}号信息只能凭对应阶段证据获知`).join('\n')
        : label === '分阶段揭示路线'
          ? WORLD_REVEAL_STAGE_LABELS.map((stage, stageIndex) =>
            `〔${stage}〕${WORLD_REVEAL_STAGE_FIELDS.map((field) =>
              `${field}：${stageIndex + 1}号证据迫使人物行动并承担实际代价`).join('；')}`).join('\n')
          : `${index + 1}号机制会改变普通人生计、势力利益和主角选择代价。`.repeat(8);
    return `【${label}】\n${content}`;
  })
    .join('\n');
  const deps = {
    async *streamChat({ system, messages }) {
      capturedSystem = system;
      capturedInstruction = messages[0].content;
      yield worldBible;
    },
    async nonStreamChat() { return '{}'; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写侦探故事' }));
    await store.versionSet(book.id, 'core:world', '旧世界观只是一句背景');
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'core:world' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    const bk = await store.readBook(book.id);
    assert.equal(store.currentText(bk.settings.core.world), worldBible);
    assert.doesNotMatch(capturedSystem, /旧世界观只是一句背景/);
    assert.match(capturedInstruction, /当前世界观草稿.*旧世界观只是一句背景/s);
    assert.match(capturedInstruction, /分阶段揭示路线/);
    assert.match(capturedInstruction, /进入下一层门槛/);
  }, deps);
});

test('过短或缺栏的世界观 API 结果仍会保存，由诊断告知作者', async () => {
  const thin = '世界很大，势力很多，主角会逐渐探索。';
  const deps = {
    async *streamChat() { yield thin; },
    async nonStreamChat() { return '{}'; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写宏大奇幻' }));
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'core:world' });
    const sse = await readSSE(res);
    // 版本链可回退：拒绝落盘只会让作者白付一次 API 且什么都拿不到。
    assert.match(sse, /"done":true/);
    assert.doesNotMatch(sse, /WORLD_BIBLE_FAILED/);
    assert.equal(store.currentText((await store.readBook(book.id)).settings.core.world), thin);
    const tree = await j(await fetch(`${base}/api/books/${book.id}/tree`));
    assert.equal(tree.book.settings.worldBibleDiagnostics.valid, false);
    assert.ok(tree.book.settings.worldBibleDiagnostics.issues.includes('too-short'));
  }, deps);
});

test('输出格式损坏的世界观 API 结果仍被拒绝落盘', async () => {
  const deps = {
    async *streamChat() { yield '```\n【独特机制】被代码围栏包住的结果\n```'; },
    async nonStreamChat() { return '{}'; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写宏大奇幻' }));
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'core:world' });
    const sse = await readSSE(res);
    assert.match(sse, /WORLD_BIBLE_FAILED/);
    assert.deepEqual((await store.readBook(book.id)).settings.core.world.versions, ['']);
  }, deps);
});

test('version/rewrite path=core:style 只保存满足结构门槛的文风圣经', async () => {
  let capturedSystem = '';
  let capturedInstruction = '';
  const styleBible = STYLE_BIBLE_SECTION_LABELS.map((label, index) =>
    `【${label}】\n${`${index + 1}号规则规定正向写法、场景变量和应避免的机械表达。`.repeat(6)}`)
    .join('\n');
  const deps = {
    async *streamChat({ system, messages }) {
      capturedSystem = system;
      capturedInstruction = messages[0].content;
      yield styleBible;
    },
    async nonStreamChat() { return '{}'; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写蒸汽悬疑' }));
    await store.versionSet(book.id, 'core:style', '细腻、紧凑、有代入感');
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'core:style' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    assert.equal(store.currentText((await store.readBook(book.id)).settings.core.style), styleBible);
    const tree = await j(await fetch(`${base}/api/books/${book.id}/tree`));
    assert.equal(tree.book.settings.styleBibleDiagnostics.valid, true);
    assert.equal(tree.book.settings.styleBibleDiagnostics.sectionCount, 10);
    assert.doesNotMatch(capturedSystem, /细腻、紧凑、有代入感/);
    assert.match(capturedInstruction, /当前文风基调草稿.*细腻、紧凑、有代入感/s);
    assert.match(capturedInstruction, /稳定锚点、可变范围与禁止表达/);
  }, deps);
});

test('version/rewrite path=core:style 读取绑定资产且拒绝资产变化后的迟到结果', async () => {
  const styleBible = STYLE_BIBLE_SECTION_LABELS.map((label, index) =>
    `【${label}】\n${`${index + 1}号规则规定正向写法、变化范围和禁用模式。`.repeat(7)}`)
    .join('\n');
  let capturedInstruction = '';
  let notifyStarted;
  let releaseStream;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const canFinish = new Promise((resolve) => { releaseStream = resolve; });
  const deps = {
    async *streamChat({ messages }) {
      capturedInstruction = messages[0].content;
      notifyStarted();
      await canFinish;
      yield styleBible;
    },
    async nonStreamChat() { return '{}'; },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: '写潜入悬疑' });
    const analysis = {
      style: {
        summary: '有限视角冷硬叙事', narrative: '贴近人物即时判断',
        prompt: '用受限视角和影响行动的细节推进，避免旁白总结。',
        avoid: ['空泛总结'],
      },
      story: { summary: '通过信息差升级冲突', evidenceLevel: 'medium' },
    };
    const asset = await store.addWritingAsset({
      name: '自有文风', sourceName: '本人旧作', sourceKind: 'self',
      sourceText: '人物根据手边证据作出错误判断，随后承担后果。', analysis,
    });
    const library = await store.readWritingAssets();
    const bound = await store.saveWritingAssetBookBinding(book.id, {
      primaryAssetId: asset.asset.id, auxiliaryAssetIds: [],
      sceneAssetIds: {}, chapterScenes: {},
    }, { expectedRevision: library.revision });
    const pending = post(`/api/books/${book.id}/version/rewrite`, { path: 'core:style' });
    await started;
    try {
      await store.saveWritingAssetBookBinding(book.id, {
        ...bound.binding, primaryAssetId: null, auxiliaryAssetIds: [asset.asset.id],
      }, { expectedRevision: bound.revision });
    } finally {
      releaseStream();
    }
    const sse = await readSSE(await pending);
    assert.match(capturedInstruction, /用受限视角和影响行动的细节推进/);
    assert.match(capturedInstruction, /综合成适合本书的统一规则/);
    assert.match(sse, /GENERATION_CONTEXT_CONFLICT/);
    assert.doesNotMatch(sse, /"saved":true/);
    assert.deepEqual((await store.readBook(book.id)).settings.core.style.versions, ['']);
  }, deps);
});

test('空泛且过短的文风 API 结果仍会保存，由诊断告知作者', async () => {
  const thin = '语言细腻，节奏紧凑，要像人写的。';
  const deps = {
    async *streamChat() { yield thin; },
    async nonStreamChat() { return '{}'; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写都市悬疑' }));
    const res = await post(`/api/books/${book.id}/version/rewrite`, { path: 'core:style' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    assert.doesNotMatch(sse, /STYLE_BIBLE_FAILED/);
    assert.equal(store.currentText((await store.readBook(book.id)).settings.core.style), thin);
    const tree = await j(await fetch(`${base}/api/books/${book.id}/tree`));
    assert.equal(tree.book.settings.styleBibleDiagnostics.valid, false);
  }, deps);
});

test('version/rewrite 章节 path 报错，不走章节管线', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const res = await post(`/api/books/${book.id}/version/rewrite`, {
      path: 'section:section-01:chapter:chapter-01',
    });
    const sse = await readSSE(res);
    assert.match(sse, /"error"/);
    assert.match(sse, /BAD_VERSION_REWRITE_PATH/);
  });
});

test('gen/chapter 新正文的 digest 解析失败时不沿用无归属的旧派生状态', async () => {
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
    assert.match(sse, /"postprocessWarnings":\["digest","review"\]/);

    const sec = await store.readSection(book.id, s.id);
    assert.equal(sec.chapters.length, 1);
    const ch = await store.readChapter(book.id, s.id, sec.chapters[0]);
    // 正文已落盘（版本化 body）
    assert.equal(store.currentText(ch.body), '这是正文');
    assert.equal(ch.content, '这是正文');
    // 正文已经从空变为新内容，无法归属给其它已完成章节的旧聚合
    // 路标/摘要必须失效；否则下一章会把旧剧情当作新正文前情。
    const bk = await store.readBook(book.id);
    assert.equal(bk.progress, '');
    assert.equal(sec.progress, '');
    assert.equal(sec.summary, '');
  }, badDigestDeps);
});

test('gen/chapter 正文未变时 digest 解析失败仍保留有效派生状态', async () => {
  const badDigestDeps = {
    async *streamChat() { yield '相同正文'; },
    async nonStreamChat() { return '抱歉我不会'; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const section = await j(await post(`/api/books/${book.id}/sections`, {}));
    const chapter = await j(await post(
      `/api/books/${book.id}/sections/${section.id}/chapters`, {},
    ));
    const path = `section:${section.id}:chapter:${chapter.id}`;
    await store.versionSet(book.id, path, '相同正文');
    const saved = await store.readChapter(book.id, section.id, chapter.id);
    await store.applyChapterDigest(book.id, section.id, chapter.id, {
      summary: '有效摘要', progress: '有效路标',
      newCharacters: [{ name: '有效人物', role: '证人', desc: '正文中已经登场' }],
    }, { expectedBodyFingerprint: saved.bodyFingerprint });

    const response = await post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: section.id,
      chapterId: chapter.id,
      mode: 'rewrite',
    });
    const sse = await readSSE(response);

    assert.match(sse, /"done":true/);
    const [chapterBack, sectionBack, bookBack] = await Promise.all([
      store.readChapter(book.id, section.id, chapter.id),
      store.readSection(book.id, section.id),
      store.readBook(book.id),
    ]);
    assert.equal(chapterBack.summary, '有效摘要');
    assert.equal(chapterBack.progress, '有效路标');
    assert.deepEqual(chapterBack.characters, [
      { name: '有效人物', role: '证人', desc: '正文中已经登场' },
    ]);
    assert.equal(sectionBack.summary, '第1章：有效摘要');
    assert.equal(sectionBack.progress, '有效路标');
    assert.equal(bookBack.progress, '有效路标');
  }, badDigestDeps);
});

test('gen/chapter digest 缺少人物字段时不把同一正文的旧人物误清空', async () => {
  const missingCharactersDeps = {
    async *streamChat() { yield '相同正文'; },
    async nonStreamChat({ messages }) {
      if ((messages?.[0]?.content ?? '').includes('审阅第')) {
        return JSON.stringify({
          score: 80,
          verdict: '正文完整',
          issues: [{ title: '细节', detail: '可继续打磨' }],
          suggestions: [{ label: '润色', instruction: '润色细节' }],
        });
      }
      return JSON.stringify({ summary: '更新摘要', progress: '更新路标' });
    },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const section = await j(await post(`/api/books/${book.id}/sections`, {}));
    const chapter = await j(await post(
      `/api/books/${book.id}/sections/${section.id}/chapters`, {},
    ));
    await store.versionSet(
      book.id, `section:${section.id}:chapter:${chapter.id}`, '相同正文',
    );
    const saved = await store.readChapter(book.id, section.id, chapter.id);
    const existingCharacter = { name: '旧人物', role: '证人', desc: '已确认登场' };
    await store.applyChapterDigest(book.id, section.id, chapter.id, {
      summary: '旧摘要', progress: '旧路标', newCharacters: [existingCharacter],
    }, { expectedBodyFingerprint: saved.bodyFingerprint });

    const response = await post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: section.id,
      chapterId: chapter.id,
      mode: 'rewrite',
    });
    const sse = await readSSE(response);
    assert.match(sse, /"done":true/);
    assert.match(sse, /"postprocessWarnings":\["digest"\]/);
    assert.doesNotMatch(sse, /"review"/);

    const chapterBack = await store.readChapter(book.id, section.id, chapter.id);
    assert.equal(chapterBack.summary, '更新摘要');
    assert.deepEqual(chapterBack.characters, [existingCharacter]);
    assert.ok(chapterBack.review);
  }, missingCharactersDeps);
});

test('gen/chapter 正文未变时 digest 明确返回空人物会清除旧人物', async () => {
  const emptyCharactersDeps = {
    async *streamChat() { yield '相同正文'; },
    async nonStreamChat() {
      return JSON.stringify({
        summary: '更新摘要', progress: '更新路标', newCharacters: [],
      });
    },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const section = await j(await post(`/api/books/${book.id}/sections`, {}));
    const chapter = await j(await post(
      `/api/books/${book.id}/sections/${section.id}/chapters`, {},
    ));
    await store.versionSet(
      book.id, `section:${section.id}:chapter:${chapter.id}`, '相同正文',
    );
    const saved = await store.readChapter(book.id, section.id, chapter.id);
    await store.applyChapterDigest(book.id, section.id, chapter.id, {
      summary: '旧摘要', progress: '旧路标',
      newCharacters: [{ name: '误识别人物', role: '路人', desc: '应被新快照移除' }],
    }, { expectedBodyFingerprint: saved.bodyFingerprint });

    const response = await post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: section.id,
      chapterId: chapter.id,
      mode: 'rewrite',
    });
    const sse = await readSSE(response);

    assert.match(sse, /"done":true/);
    const chapterBack = await store.readChapter(book.id, section.id, chapter.id);
    assert.equal(chapterBack.summary, '更新摘要');
    assert.equal(chapterBack.progress, '更新路标');
    assert.deepEqual(chapterBack.characters, []);
  }, emptyCharactersDeps);
});

test('gen/sections 流式返回分部建议，不自动建部', async () => {
  // 用闭包记录 fake LLM 收到的 instruction，验证版本化 outline 的当前文本真的被传入
  let capturedInstruction = '';
  const secDeps = {
    async *streamChat({ messages }) {
      capturedInstruction = messages?.[0]?.content ?? '';
      yield validSectionPlanFixture();
    },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写侦探故事' }));
    // 通过 versionSet 走版本化写路径（不能直接 book.outline.content = ...，那样迁移后读不到）
    await store.versionSet(book.id, 'outline', '我的全书大纲XYZ');
    await store.versionSet(book.id, 'core:world', validWorldBibleFixture());

    const res = await post('/api/gen/sections', { bookId: book.id });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    assert.match(sse, /"sections":/);
    assert.match(sse, /"parsedTitles":/);
    assert.match(sse, /"parsedSections":/);
    assert.match(sse, /"promise":/);
    assert.match(sse, /"stateChange":/);
    // 关键断言：outline 当前版本文本真的到了 LLM 指令里（迁移契约端到端）
    assert.match(capturedInstruction, /我的全书大纲XYZ/);
    // 不自动建部
    const bk2 = await store.readBook(book.id);
    assert.deepEqual(bk2.sections, []);
  }, secDeps);
});

test('gen/sections 在调用模型前及返回方案前核对规划上下文', async () => {
  const paused = pausedStreamDeps(
    validSectionPlanFixture(),
  );
  await withServer(async () => {
    const book = await store.createBook({ premise: '规划锚点' });
    await store.versionSet(book.id, 'core:world', validWorldBibleFixture());
    const initialRevision = store.sectionPlanContextRevision(await store.readBook(book.id));

    const missing = await rawPost('/api/gen/sections', { bookId: book.id });
    assert.match(await readSSE(missing), /BAD_GENERATION_CONTEXT_REVISION/);

    await store.versionSet(book.id, 'outline', '另一页面先更新的大纲');
    const stale = await rawPost('/api/gen/sections', {
      bookId: book.id, expectedContextRevision: initialRevision,
    });
    assert.match(await readSSE(stale), /GENERATION_CONTEXT_CONFLICT/);

    const currentRevision = store.sectionPlanContextRevision(await store.readBook(book.id));
    const pending = rawPost('/api/gen/sections', {
      bookId: book.id, expectedContextRevision: currentRevision,
    });
    await paused.started;
    await store.versionSet(book.id, 'core:style', '规划期间更新的文风');
    paused.release();

    const sse = await readSSE(await pending);
    assert.match(sse, /GENERATION_CONTEXT_CONFLICT/);
    assert.doesNotMatch(sse, /"done":true/);
    assert.doesNotMatch(sse, /"parsedTitles"/);
  }, paused.deps);
});

test('gen/sections AI 输出格式不符合时返回 parseError', async () => {
  const badDeps = {
    async *streamChat() { yield '抱歉，我不会规划分部'; },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    await store.versionSet(book.id, 'core:world', validWorldBibleFixture());
    const res = await post('/api/gen/sections', { bookId: book.id });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    assert.match(sse, /"parseError":true/);
  }, badDeps);
});

test('gen/sections 在调用模型前要求三层世界圣经', async () => {
  let calls = 0;
  const deps = {
    async *streamChat() { calls += 1; yield validSectionPlanFixture(); },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '尚无世界圣经' }));
    const res = await post('/api/gen/sections', { bookId: book.id });
    const sse = await readSSE(res);
    assert.match(sse, /SECTION_PLAN_WORLD_BIBLE_REQUIRED/);
    assert.equal(calls, 0);
  }, deps);
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

test('gen/chapter next 已收到部分文本后抛错仍回滚未落盘新章', async () => {
  const partialFailDeps = {
    async *streamChat() {
      yield '半章内容';
      throw new Error('LLM_STREAM_INCOMPLETE');
    },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const response = await post('/api/gen/chapter', { bookId: book.id, sectionId: s.id, mode: 'next' });
    const sse = await readSSE(response);
    assert.match(sse, /半章内容/);
    assert.match(sse, /LLM_STREAM_INCOMPLETE/);
    assert.deepEqual((await store.readSection(book.id, s.id)).chapters, []);
    assert.equal(existsSync(join(root, 'books', book.id, s.id, 'chapter-01.json')), false);
  }, partialFailDeps);
});

test('gen/chapter 拒绝模型泄漏后台策划标记：重写不覆盖，续写不残留空章', async () => {
  const leak = `压力来源：封站。变化链：闸机关闭。promise_${'a'.repeat(32)}`;
  const leakDeps = {
    async *streamChat() { yield leak; },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const section = await j(await post(`/api/books/${book.id}/sections`, {}));
    const chapter = await j(await post(
      `/api/books/${book.id}/sections/${section.id}/chapters`, {},
    ));
    const source = '这是作者已经确认的原正文。';
    await store.versionSet(
      book.id, `section:${section.id}:chapter:${chapter.id}`, source,
      { expectedRevision: store.versionRevision(chapter.body) },
    );

    const rewrite = await post('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, chapterId: chapter.id, mode: 'rewrite',
    });
    const rewriteSse = await readSSE(rewrite);
    assert.match(rewriteSse, /CHAPTER_OUTPUT_LEAKED/);
    assert.equal(store.currentText(
      (await store.readChapter(book.id, section.id, chapter.id)).body,
    ), source);

    const next = await post('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, mode: 'next',
    });
    const nextSse = await readSSE(next);
    assert.match(nextSse, /CHAPTER_OUTPUT_LEAKED/);
    assert.deepEqual((await store.readSection(book.id, section.id)).chapters, [chapter.id]);
  }, leakDeps);
});

test('gen/chapter next 上游空响应时回滚空章', async () => {
  const emptyDeps = {
    async *streamChat() { yield '   '; },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const response = await post('/api/gen/chapter', { bookId: book.id, sectionId: s.id, mode: 'next' });
    const sse = await readSSE(response);
    assert.match(sse, /LLM_EMPTY_RESPONSE/);
    assert.deepEqual((await store.readSection(book.id, s.id)).chapters, []);
  }, emptyDeps);
});

test('gen/chapter next 成功后自动写入 review', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const res = await post('/api/gen/chapter', { bookId: book.id, sectionId: s.id, mode: 'next' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);

    const sec = await store.readSection(book.id, s.id);
    const ch = await store.readChapter(book.id, s.id, sec.chapters[0]);
    assert.ok(ch.review, 'review 应存在');
    assert.equal(ch.review.score, 78);
    assert.equal(ch.review.verdict, '冲突成立，中段推进偏松');
    assert.equal(ch.review.issues.length, 1);
    assert.equal(ch.review.suggestions.length, 1);
    assert.equal(ch.review.sourceCursor, ch.body.cursor);
    assert.equal(ch.review.sourceFingerprint, ch.bodyFingerprint);
    assert.ok(ch.review.updatedAt);
  });
});

test('gen/chapter next 审稿失败时正文仍完成并报告后处理告警', async () => {
  const failReviewDeps = {
    async *streamChat() { yield '正文'; },
    async nonStreamChat({ messages }) {
      const prompt = messages?.[0]?.content ?? '';
      if (prompt.includes('审阅第')) return '抱歉，我不会审稿';
      return JSON.stringify({
        chapterTitle: '', sectionTitle: '',
        summary: '本章小结', progress: '下一步剧情', characters: [],
      });
    },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const res = await post('/api/gen/chapter', { bookId: book.id, sectionId: s.id, mode: 'next' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    assert.match(sse, /"postprocessWarnings":\["review"\]/);
    assert.doesNotMatch(sse, /"digest"/);
    // 没有 review 字段
    const sec = await store.readSection(book.id, s.id);
    const ch = await store.readChapter(book.id, s.id, sec.chapters[0]);
    assert.equal(ch.review, undefined);
  }, failReviewDeps);
});

test('gen/chapter 自动审稿丢弃生成期间变化的故事上下文', async () => {
  let notifyReviewStarted;
  let releaseReview;
  const reviewStarted = new Promise((resolve) => { notifyReviewStarted = resolve; });
  const reviewCanFinish = new Promise((resolve) => { releaseReview = resolve; });
  const deps = {
    async *streamChat() { yield '已保存正文'; },
    async nonStreamChat({ messages }) {
      const prompt = messages?.[0]?.content ?? '';
      if (!prompt.includes('审阅第')) {
        return JSON.stringify({
          chapterTitle: '', sectionTitle: '',
          summary: '本章小结', progress: '下一步剧情', characters: [],
        });
      }
      notifyReviewStarted();
      await reviewCanFinish;
      return JSON.stringify({
        score: 80,
        verdict: '基于旧上下文的审稿',
        issues: [{ title: '旧问题', detail: '旧详情' }],
        suggestions: [{ label: '旧建议', instruction: '旧指令' }],
      });
    },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const pending = post('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, mode: 'next',
    });
    await reviewStarted;
    try {
      await store.versionSet(book.id, 'outline', '自动审稿期间更新的大纲');
    } finally {
      releaseReview();
    }

    const sse = await readSSE(await pending);
    assert.match(sse, /"done":true/);
    assert.match(sse, /"postprocessWarnings":\["review"\]/);
    const savedSection = await store.readSection(book.id, section.id);
    const saved = await store.readChapter(book.id, section.id, savedSection.chapters[0]);
    assert.equal(store.currentText(saved.body), '已保存正文');
    assert.equal(saved.review, undefined);
  }, deps);
});

test('gen/chapter whip 成功后 review 的 sourceCursor 指向新版 cursor', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const c = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, {}));
    // 先写入一版正文，方便 whip
    const path = `section:${s.id}:chapter:${c.id}`;
    await store.versionSet(book.id, path, '旧版正文');

    const res = await post('/api/gen/chapter', { bookId: book.id, sectionId: s.id, mode: 'whip', chapterId: c.id, whip: '加冲突' });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);

    const ch = await store.readChapter(book.id, s.id, c.id);
    assert.ok(ch.review);
    assert.equal(ch.review.sourceCursor, ch.body.cursor);
  });
});
