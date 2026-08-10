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
  mountGenRoutes(app, deps);
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

test('大纲、标题、正文、摘要和审稿分别使用显式分工模型', async () => {
  await store.writeConfig({
    baseUrl: 'https://default.example/v1', model: 'default-model', apiKey: 'sk-default',
  });
  let library = await store.readApiProfiles();
  const profile = await store.saveApiProfile({
    name: '模型分工', baseUrl: 'https://roles.example/v1', apiKey: 'sk-roles',
    models: ['outline-model', 'title-model', 'chapter-model', 'digest-model', 'review-model'],
    selectedModel: 'chapter-model', note: '',
  }, { expectedRevision: library.revision });
  library = await store.readApiProfiles();
  await store.saveApiTaskRoutes({
    outline: { profileId: profile.profile.id, model: 'outline-model' },
    title: { profileId: profile.profile.id, model: 'title-model' },
    chapter: { profileId: profile.profile.id, model: 'chapter-model' },
    digest: { profileId: profile.profile.id, model: 'digest-model' },
    review: { profileId: profile.profile.id, model: 'review-model' },
  }, { expectedRevision: library.revision });
  const calls = [];
  const deps = {
    async *streamChat({ config }) {
      calls.push(['stream', config.model]);
      yield config.model === 'outline-model' ? '分工后的大纲' : '分工后的正文';
    },
    async nonStreamChat({ config, messages }) {
      const prompt = messages?.[0]?.content ?? '';
      if (prompt.includes('只输出书名')) {
        calls.push(['title', config.model]);
        return '《分工之书》';
      }
      if (prompt.includes('审阅第')) {
        calls.push(['review', config.model]);
        return JSON.stringify({
          score: 88, verdict: '可读',
          issues: [{ title: '节奏', detail: '可再紧凑' }],
          suggestions: [{ label: '收紧', instruction: '删减重复句' }],
        });
      }
      if (prompt.includes('拟纯标题')) {
        calls.push(['chapter-title', config.model]);
        return JSON.stringify({ chapterTitle: '标题模型章', sectionTitle: '标题模型部' });
      }
      calls.push(['digest', config.model]);
      return JSON.stringify({
        chapterTitle: '分工章', sectionTitle: '分工部',
        summary: '分工摘要', progress: '分工进展', characters: [],
      });
    },
  };
  const book = await store.createBook({ premise: '测试模型分工' });

  await withServer(async () => {
    const outlineResponse = await post(`/api/books/${book.id}/version/rewrite`, {
      path: 'outline',
    });
    assert.match(await outlineResponse.text(), /"done":true/);
    const section = await store.addSection(book.id, {});
    const chapterResponse = await rawPost('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, mode: 'next', expectedLastChapterId: null,
    });
    assert.match(await chapterResponse.text(), /"done":true/);
  }, deps);

  assert.deepEqual(calls, [
    ['stream', 'outline-model'], ['title', 'title-model'],
    ['stream', 'chapter-model'], ['digest', 'digest-model'],
    ['chapter-title', 'title-model'], ['review', 'review-model'],
  ]);
});

test('显式标题模型失败时不沿用 digest 模型生成的标题', async () => {
  await store.writeConfig({
    baseUrl: 'https://default.example/v1', model: 'default-model', apiKey: 'sk-default',
  });
  let library = await store.readApiProfiles();
  const profile = await store.saveApiProfile({
    name: '标题服务', baseUrl: 'https://title.example/v1', apiKey: 'sk-title',
    models: ['title-model'], selectedModel: 'title-model', note: '',
  }, { expectedRevision: library.revision });
  library = await store.readApiProfiles();
  await store.saveApiTaskRoutes({
    chapter: null, outline: null, digest: null, review: null,
    title: { profileId: profile.profile.id, model: 'title-model' },
  }, { expectedRevision: library.revision });
  let titleModelSeen = false;
  const deps = {
    async *streamChat() { yield '正文'; },
    async nonStreamChat({ config, messages }) {
      const prompt = messages?.[0]?.content ?? '';
      if (prompt.includes('拟纯标题')) {
        titleModelSeen = config.model === 'title-model';
        throw new Error('LLM_HTTP_503');
      }
      if (prompt.includes('审阅第')) {
        return JSON.stringify({
          score: 80, verdict: '可读',
          issues: [{ title: '无', detail: '暂无大问题' }],
          suggestions: [{ label: '精修', instruction: '保持节奏' }],
        });
      }
      return JSON.stringify({
        chapterTitle: '不应回退的章名', sectionTitle: '不应回退的部名',
        summary: '摘要', progress: '进展', characters: [],
      });
    },
  };
  const book = await store.createBook({ premise: '标题不回退' });
  const section = await store.addSection(book.id, {});

  await withServer(async () => {
    const response = await rawPost('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, mode: 'next', expectedLastChapterId: null,
    });
    const sse = await response.text();
    assert.match(sse, /"postprocessWarnings":\["title"\]/);
  }, deps);

  const storedSection = await store.readSection(book.id, section.id);
  const chapter = await store.readChapter(book.id, section.id, storedSection.chapters[0]);
  assert.equal(titleModelSeen, true);
  assert.equal(chapter.title, '');
  assert.equal(storedSection.title, '');
});

test('单书固定模型覆盖全局分工并在一次生成链中保持一致', async () => {
  await store.writeConfig({
    baseUrl: 'https://default.example/v1', model: 'default-model', apiKey: 'sk-default',
  });
  let library = await store.readApiProfiles();
  const profile = await store.saveApiProfile({
    name: '单书模型', baseUrl: 'https://book-model.example/v1', apiKey: 'sk-book',
    models: ['fixed-a', 'fixed-b', 'global-chapter', 'global-digest', 'global-review'],
    selectedModel: 'fixed-a', note: '',
  }, { expectedRevision: library.revision });
  library = await store.readApiProfiles();
  const routed = await store.saveApiTaskRoutes({
    chapter: { profileId: profile.profile.id, model: 'global-chapter' },
    outline: null,
    digest: { profileId: profile.profile.id, model: 'global-digest' },
    review: { profileId: profile.profile.id, model: 'global-review' },
    title: null,
  }, { expectedRevision: library.revision });
  const book = await store.createBook({ premise: '单书固定' });
  const section = await store.addSection(book.id, {});
  await store.saveApiBookBinding(book.id, {
    profileId: profile.profile.id, model: 'fixed-a',
  }, { expectedRevision: routed.revision });
  const calls = [];
  let switchedDuringBody = false;
  const deps = {
    async *streamChat({ config }) {
      calls.push(['chapter', config.model]);
      const latest = await store.readApiProfiles();
      await store.saveApiBookBinding(book.id, {
        profileId: profile.profile.id, model: 'fixed-b',
      }, { expectedRevision: latest.revision });
      switchedDuringBody = true;
      yield '固定模型正文';
    },
    async nonStreamChat({ config, messages }) {
      const prompt = messages?.[0]?.content ?? '';
      if (prompt.includes('审阅第')) {
        calls.push(['review', config.model]);
        return JSON.stringify({
          score: 85, verdict: '稳定',
          issues: [{ title: '节奏', detail: '小幅调整' }],
          suggestions: [{ label: '精修', instruction: '保持一致' }],
        });
      }
      calls.push(['digest', config.model]);
      return JSON.stringify({
        chapterTitle: '固定章', sectionTitle: '固定部',
        summary: '固定摘要', progress: '固定进展', characters: [],
      });
    },
  };

  await withServer(async () => {
    const response = await rawPost('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, mode: 'next', expectedLastChapterId: null,
    });
    assert.match(await response.text(), /"done":true/);
  }, deps);

  assert.equal(switchedDuringBody, true);
  assert.deepEqual(calls, [
    ['chapter', 'fixed-a'], ['digest', 'fixed-a'], ['review', 'fixed-a'],
  ]);
  assert.equal(
    (await store.readConfigForTask('chapter', { bookId: book.id })).model,
    'fixed-b',
  );
});

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

test('SSE 正文写入在缓冲区满时等待 drain，并在等待期间响应断连', async () => {
  class FakeResponse extends EventEmitter {
    constructor(signal) {
      super();
      this.locals = { abortSignal: signal };
      this.destroyed = false;
      this.writableEnded = false;
      this.frames = [];
    }

    write(frame) {
      this.frames.push(frame);
      return false;
    }
  }

  const firstAbort = new AbortController();
  const first = new FakeResponse(firstAbort.signal);
  let drained = false;
  const waiting = writeSseEventWithBackpressure(first, { delta: '正文' })
    .then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  first.emit('drain');
  await waiting;
  assert.equal(drained, true);
  assert.match(first.frames[0], /正文/);

  const secondAbort = new AbortController();
  const second = new FakeResponse(secondAbort.signal);
  const cancelled = writeSseEventWithBackpressure(second, { delta: '迟到正文' });
  secondAbort.abort();
  await assert.rejects(cancelled, /CLIENT_ABORTED/);

  const thirdAbort = new AbortController();
  const third = new FakeResponse(thirdAbort.signal);
  third.destroy = function destroy() { this.destroyed = true; };
  await assert.rejects(
    () => writeSseEventWithBackpressure(
      third, { delta: '无人读取' }, { drainTimeoutMs: 5 },
    ),
    /RESPONSE_BACKPRESSURE_TIMEOUT/,
  );
  assert.equal(third.destroyed, true);
  assert.equal(third.listenerCount('drain'), 0);
  assert.equal(third.listenerCount('close'), 0);
  assert.equal(third.listenerCount('error'), 0);
});

// gen/chapter 正文写入 chapter.body（版本化），content 由 writeChapter 从 body 派生
test('gen/chapter next 生成正文并落盘 + digest 冒泡', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const res = await post('/api/gen/chapter', { bookId: book.id, sectionId: s.id, mode: 'next' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const sse = await readSSE(res);
    assert.match(sse, /这是/);
    assert.match(sse, /正文/);
    assert.match(sse, /"done":true/);
    assert.match(sse, /"saved":true/);
    assert.doesNotMatch(sse, /postprocessWarnings/);

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
    assert.deepEqual(ch.characters, [
      { name: '陈默', role: '主角', desc: '本章末负伤' },
    ]);
    // 冒泡
    assert.match(sec.progress, /下一步B/);
    const bk = await store.readBook(book.id);
    assert.match(bk.progress, /下一步B/);
  });
});

test('gen/chapter 合并快速微小 delta，仍向页面流式发送并完整保存正文', async () => {
  const generated = '字'.repeat(10_000);
  const deps = {
    ...fakeDeps,
    async *streamChat() {
      for (const character of generated) yield character;
    },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: '微小事件' });
    const section = await store.addSection(book.id, {});
    const sse = await readSSE(await post('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, mode: 'next',
    }));
    const events = sse.split(/\n\n/u)
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)));
    const deltas = events.filter((event) => typeof event.delta === 'string');

    assert.equal(deltas.map((event) => event.delta).join(''), generated);
    assert.ok(deltas.length < 20, `期望合并微小事件，实际收到 ${deltas.length} 个 delta`);
    assert.ok(deltas.length > 1, '首个 token 应立即到达，后续内容再批量发送');
    assert.ok(events.some((event) => event.saved === true));
    assert.ok(events.some((event) => event.done === true));
    const savedSection = await store.readSection(book.id, section.id);
    const saved = await store.readChapter(book.id, section.id, savedSection.chapters[0]);
    assert.equal(store.currentText(saved.body), generated);
  }, deps);
});

test('合法超长本部摘要不会阻断续写，模型只接收明确标记的最近前情', async () => {
  let chapterPrompt = '';
  let chapterSystem = '';
  const deps = {
    ...fakeDeps,
    async *streamChat({ system, messages }) {
      chapterSystem = system;
      chapterPrompt = messages?.[0]?.content ?? '';
      yield '长篇续写正文';
    },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: '万章长篇' });
    const section = await store.addSection(book.id, {});
    const characters = Array.from({ length: MAX_STORED_CHARACTERS }, (_, index) => ({
      name: `人物${index}`,
      role: '角色',
      desc: '状态'.repeat(250),
    }));
    const longVersion = (head, tail) =>
      head + '中'.repeat(MAX_VERSION_TEXT_CHARS - head.length - tail.length) + tail;
    const latestBook = await store.readBook(book.id);
    await store.writeBook(book.id, {
      ...latestBook,
      outline: { versions: [longVersion('全书开头', '全书结尾')], cursor: 0 },
      settings: { core: {
        world: { versions: [longVersion('世界开头', '世界结尾')], cursor: 0 },
        style: { versions: [longVersion('文风开头', '文风结尾')], cursor: 0 },
        constraints: { versions: [longVersion('禁忌开头', '禁忌结尾')], cursor: 0 },
        pacing: { versions: [longVersion('节奏开头', '节奏结尾')], cursor: 0 },
      } },
      characters,
    });
    const latest = '第10000章：主角终于找到出口';
    await store.writeSection(book.id, section.id, {
      ...section,
      outline: { content: longVersion('本部开头', '本部结尾'), history: [] },
      characters,
      summary: [
        '第1章：最早线索',
        '中期剧情'.repeat(MAX_SECTION_PROMPT_SUMMARY_CHARS),
        latest,
      ].join('\n'),
    });

    const response = await post('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, mode: 'next',
    });
    const sse = await readSSE(response);

    assert.match(sse, /"saved":true/);
    assert.match(sse, /"done":true/);
    assert.doesNotMatch(sse, /LLM_INPUT_TOO_LARGE/);
    assert.match(chapterPrompt, /较早的本部摘要已省略/);
    assert.match(chapterPrompt, /中间内容已省略/);
    assert.match(chapterSystem, /中间内容已省略/);
    assert.match(chapterSystem, /世界开头/);
    assert.match(chapterSystem, /世界结尾/);
    assert.match(chapterPrompt, /已省略中间人物/);
    assert.match(chapterPrompt, /人物0（角色）/);
    assert.match(chapterPrompt, /人物999（角色）/);
    assert.doesNotMatch(chapterPrompt, /人物500（角色）/);
    assert.match(chapterPrompt, new RegExp(latest));
    assert.doesNotMatch(chapterPrompt, /最早线索/);
    assert.ok(chapterSystem.length + chapterPrompt.length < MAX_LLM_INPUT_CHARS);
  }, deps);
});

test('SSE 在模型首个 token 前刷新响应头并禁用反向代理缓冲', async () => {
  const paused = pausedStreamDeps(
    '{"sections":[{"title":"起源","summary":"开端"},{"title":"终局","summary":"收束"}]}',
  );
  await withServer(async () => {
    const book = await store.createBook({ premise: '慢首 token' });
    const expectedContextRevision = store.sectionPlanContextRevision(
      await store.readBook(book.id),
    );
    const pending = fetch(`${base}/api/gen/sections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: book.id, expectedContextRevision }),
    });
    await paused.started;

    let timer;
    const firstResponse = await Promise.race([
      pending.then((response) => ({ response })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), 500);
      }),
    ]);
    clearTimeout(timer);
    paused.release();
    const response = await pending;
    await readSSE(response);

    assert.equal(firstResponse.timeout, undefined, '响应头不应等待模型首个 token');
    assert.equal(firstResponse.response, response);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  }, paused.deps);
});

test('SSE 静默等待模型时发送心跳并在正文到达后继续正常完成', async () => {
  const paused = pausedStreamDeps(
    '{"sections":[{"title":"起源","summary":"开端"},{"title":"终局","summary":"收束"}]}',
  );
  await withServer(async () => {
    const book = await store.createBook({ premise: '长时间静默模型' });
    const expectedContextRevision = store.sectionPlanContextRevision(
      await store.readBook(book.id),
    );
    const response = await fetch(`${base}/api/gen/sections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: book.id, expectedContextRevision }),
    });
    await paused.started;

    const heartbeatRead = readUntilText(response, ': keepalive');
    let timer;
    const heartbeat = await Promise.race([
      heartbeatRead.then(() => ({ received: true })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), 250);
      }),
    ]);
    clearTimeout(timer);
    paused.release();
    const { reader, out } = await heartbeatRead;
    const rest = await readRest(reader);

    assert.equal(heartbeat.timeout, undefined, '静默连接应定期发送 SSE 注释心跳');
    assert.match(out, /: keepalive/);
    assert.match(out + rest, /"done":true/);
  }, { ...paused.deps, sseHeartbeatMs: 20 });
});

test('gen/chapter next 缺少末章锚点时在调用模型前拒绝', async () => {
  let streamCalls = 0;
  const deps = {
    async *streamChat() { streamCalls += 1; yield '不应生成'; },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const response = await fetch(`${base}/api/gen/chapter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: book.id, sectionId: section.id, mode: 'next' }),
    });

    const sse = await readSSE(response);
    assert.match(sse, /BAD_NEXT_CHAPTER_ANCHOR/);
    assert.equal(streamCalls, 0);
    assert.deepEqual((await store.readSection(book.id, section.id)).chapters, []);
  }, deps);
});

test('两个标签页同时生成下一章时陈旧请求不新增章节也不调用模型', async () => {
  let streamCalls = 0;
  let notifyFirstStarted;
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { notifyFirstStarted = resolve; });
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
  const deps = {
    async *streamChat() {
      streamCalls += 1;
      notifyFirstStarted();
      await firstCanFinish;
      yield '唯一生成的下一章';
    },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const previous = await store.addChapter(book.id, section.id, {});
    const request = {
      bookId: book.id,
      sectionId: section.id,
      mode: 'next',
      expectedLastChapterId: previous.id,
    };
    const first = post('/api/gen/chapter', request);
    await firstStarted;
    try {
      const secondSse = await readSSE(await post('/api/gen/chapter', request));
      assert.match(secondSse, /NEXT_CHAPTER_CONFLICT/);
      assert.doesNotMatch(secondSse, /"saved":true/);
      assert.equal(streamCalls, 1);
    } finally {
      releaseFirst();
    }

    const firstSse = await readSSE(await first);
    assert.match(firstSse, /"done":true/);
    assert.equal(streamCalls, 1);
    const savedSection = await store.readSection(book.id, section.id);
    assert.deepEqual(savedSection.chapters, [previous.id, 'chapter-02']);
    const generated = await store.readChapter(book.id, section.id, 'chapter-02');
    assert.equal(store.currentText(generated.body), '唯一生成的下一章');
  }, deps);
});

test('version/rewrite 不覆盖生成期间由另一页面保存的大纲', async () => {
  const paused = pausedStreamDeps('AI 迟到大纲');
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p', title: 't' });
    const expectedRevision = store.versionRevision((await store.readBook(book.id)).outline);
    const pending = post(`/api/books/${book.id}/version/rewrite`, {
      path: 'outline', expectedRevision,
    });
    await paused.started;
    try {
      await store.versionSet(book.id, 'outline', '用户期间保存的大纲');
    } finally {
      paused.release();
    }

    const sse = await readSSE(await pending);
    assert.match(sse, /VERSION_CONFLICT/);
    assert.doesNotMatch(sse, /"saved":true/);
    assert.deepEqual((await store.readBook(book.id)).outline.versions, [
      '', '用户期间保存的大纲',
    ]);
  }, paused.deps);
});

test('version/rewrite 不保存基于其它旧核心设定的迟到结果', async () => {
  const paused = pausedStreamDeps('基于旧文风的世界观');
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const pending = post(`/api/books/${book.id}/version/rewrite`, {
      path: 'core:world',
    });
    await paused.started;
    try {
      await store.versionSet(book.id, 'core:style', '另一页面更新后的文风');
    } finally {
      paused.release();
    }

    const sse = await readSSE(await pending);
    assert.match(sse, /GENERATION_CONTEXT_CONFLICT/);
    assert.doesNotMatch(sse, /"saved":true/);
    const saved = await store.readBook(book.id);
    assert.deepEqual(saved.settings.core.world.versions, ['']);
    assert.equal(store.currentText(saved.settings.core.style), '另一页面更新后的文风');
  }, paused.deps);
});

test('gen/chapter rewrite 不覆盖生成期间由另一页面保存的正文', async () => {
  const paused = pausedStreamDeps('AI 迟到正文');
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});
    const path = `section:${section.id}:chapter:${chapter.id}`;
    await store.versionSet(book.id, path, '生成前正文');
    const expectedRevision = store.versionRevision(
      (await store.readChapter(book.id, section.id, chapter.id)).body,
    );
    const pending = post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: section.id,
      chapterId: chapter.id,
      mode: 'rewrite',
      expectedRevision,
    });
    await paused.started;
    try {
      await store.versionSet(book.id, path, '用户期间保存的正文');
    } finally {
      paused.release();
    }

    const sse = await readSSE(await pending);
    assert.match(sse, /VERSION_CONFLICT/);
    assert.doesNotMatch(sse, /"saved":true/);
    assert.deepEqual(
      (await store.readChapter(book.id, section.id, chapter.id)).body.versions,
      ['', '生成前正文', '用户期间保存的正文'],
    );
  }, paused.deps);
});

test('gen/chapter rewrite 不保存基于旧核心设定的迟到正文', async () => {
  const paused = pausedStreamDeps('基于旧设定的迟到正文');
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});
    const chapterPath = `section:${section.id}:chapter:${chapter.id}`;
    await store.versionSet(book.id, chapterPath, '原正文');
    const expectedRevision = store.versionRevision(
      (await store.readChapter(book.id, section.id, chapter.id)).body,
    );
    const pending = post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: section.id,
      chapterId: chapter.id,
      mode: 'rewrite',
      expectedRevision,
    });
    await paused.started;
    try {
      await store.versionSet(book.id, 'core:world', '另一页面更新后的世界观');
    } finally {
      paused.release();
    }

    const sse = await readSSE(await pending);
    assert.match(sse, /GENERATION_CONTEXT_CONFLICT/);
    assert.doesNotMatch(sse, /"saved":true/);
    assert.deepEqual(
      (await store.readChapter(book.id, section.id, chapter.id)).body.versions,
      ['', '原正文'],
    );
  }, paused.deps);
});

test('gen/chapter next 在上一章变化后丢弃旧前情结果并回滚空章', async () => {
  const paused = pausedStreamDeps('基于旧上一章的迟到正文');
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const previous = await store.addChapter(book.id, section.id, {});
    const previousPath = `section:${section.id}:chapter:${previous.id}`;
    await store.versionSet(book.id, previousPath, '旧上一章');
    const pending = post('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, mode: 'next',
    });
    await paused.started;
    try {
      await store.versionSet(book.id, previousPath, '另一页面改写后的上一章');
    } finally {
      paused.release();
    }

    const sse = await readSSE(await pending);
    assert.match(sse, /GENERATION_CONTEXT_CONFLICT/);
    assert.doesNotMatch(sse, /"saved":true/);
    assert.deepEqual(
      (await store.readSection(book.id, section.id)).chapters,
      [previous.id],
    );
    const savedPrevious = await store.readChapter(book.id, section.id, previous.id);
    assert.equal(store.currentText(savedPrevious.body), '另一页面改写后的上一章');
  }, paused.deps);
});

test('gen/chapter next 在生成期间又追加章节时不把旧结果插入中间', async () => {
  const paused = pausedStreamDeps('不应插入后续章之前的迟到正文');
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const previous = await store.addChapter(book.id, section.id, {});
    await store.versionSet(
      book.id,
      `section:${section.id}:chapter:${previous.id}`,
      '已完成的上一章',
    );

    const pending = post('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, mode: 'next',
    });
    await paused.started;
    const duringGeneration = await store.readSection(book.id, section.id);
    const generatedTargetId = duringGeneration.chapters.at(-1);
    assert.ok(generatedTargetId);

    let trailing;
    try {
      trailing = await store.addChapter(book.id, section.id, {
        expectedLastChapterId: generatedTargetId,
      });
      await store.versionSet(
        book.id,
        `section:${section.id}:chapter:${trailing.id}`,
        '另一页面已经写好的后续章',
      );
    } finally {
      paused.release();
    }

    const sse = await readSSE(await pending);
    assert.match(sse, /GENERATION_CONTEXT_CONFLICT/);
    assert.doesNotMatch(sse, /"saved":true/);
    assert.deepEqual(
      (await store.readSection(book.id, section.id)).chapters,
      [previous.id, trailing.id],
    );
    assert.equal(
      existsSync(join(root, 'books', book.id, section.id, `${generatedTargetId}.json`)),
      false,
    );
    const savedTrailing = await store.readChapter(book.id, section.id, trailing.id);
    assert.equal(store.currentText(savedTrailing.body), '另一页面已经写好的后续章');
  }, paused.deps);
});

test('gen/chapter next 冲突回滚不删除另一页面已编辑的新章', async () => {
  const paused = pausedStreamDeps('AI 迟到新章');
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const pending = post('/api/gen/chapter', {
      bookId: book.id, sectionId: section.id, mode: 'next',
    });
    await paused.started;
    const duringGeneration = await store.readSection(book.id, section.id);
    assert.equal(duringGeneration.chapters.length, 1);
    const chapterId = duringGeneration.chapters[0];
    try {
      await store.versionSet(
        book.id,
        `section:${section.id}:chapter:${chapterId}`,
        '用户在另一页面编辑的新章',
      );
    } finally {
      paused.release();
    }

    const sse = await readSSE(await pending);
    assert.match(sse, /VERSION_CONFLICT/);
    assert.doesNotMatch(sse, /"saved":true/);
    assert.deepEqual((await store.readSection(book.id, section.id)).chapters, [chapterId]);
    const saved = await store.readChapter(book.id, section.id, chapterId);
    assert.deepEqual(saved.body.versions, ['', '用户在另一页面编辑的新章']);
    assert.equal(store.currentText(saved.body), '用户在另一页面编辑的新章');
  }, paused.deps);
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
    // digest 基于旧正文，正文已被用户修订时应整体丢弃。
    assert.equal(ch.summary, '');
  }, hangingDigestDeps);
});

test('gen/chapter digest 阶段客户端停止后不继续写入摘要元数据或启动审稿', async () => {
  let releaseDigest;
  let digestStartedResolve;
  let digestFinishedResolve;
  let nonStreamCallCount = 0;
  const digestStarted = new Promise((resolve) => { digestStartedResolve = resolve; });
  const digestCanReturn = new Promise((resolve) => { releaseDigest = resolve; });
  const digestFinished = new Promise((resolve) => { digestFinishedResolve = resolve; });
  const hangingDigestDeps = {
    async *streamChat() { yield '这是'; yield '正文'; },
    async nonStreamChat() {
      nonStreamCallCount += 1;
      digestStartedResolve();
      await digestCanReturn;
      digestFinishedResolve();
      return JSON.stringify({
        chapterTitle: '夜雨来客',
        sectionTitle: '暗潮初现',
        summary: '小结A',
        progress: '下一步B',
        newCharacters: [{ name: '龙套甲', role: '路人', desc: 'x' }],
      });
    },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const s = await store.addSection(book.id, {});
    const ctrl = new AbortController();
    const res = await fetch(base + '/api/gen/chapter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: book.id, sectionId: s.id, mode: 'next', expectedLastChapterId: null,
      }),
      signal: ctrl.signal,
    });
    await readUntilText(res, '正文');
    await digestStarted;

    const secBeforeAbort = await store.readSection(book.id, s.id);
    const chapterId = secBeforeAbort.chapters[0];
    ctrl.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseDigest();
    await digestFinished;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sec = await store.readSection(book.id, s.id);
    const ch = await store.readChapter(book.id, s.id, chapterId);
    const bk = await store.readBook(book.id);
    assert.equal(store.currentText(ch.body), '这是正文');
    assert.equal(ch.summary, '');
    assert.equal(ch.progress, '');
    assert.equal(ch.title, '');
    assert.deepEqual(ch.characters, []);
    assert.equal(sec.summary, '');
    assert.equal(sec.progress, '');
    assert.equal(sec.title, '');
    assert.equal(bk.progress, '');
    assert.equal(nonStreamCallCount, 1, '断连后的摘要返回不能再触发自动审稿');
  }, hangingDigestDeps);
});

test('gen/chapter next 客户端停止后不继续落盘新章', async () => {
  let releaseStream;
  let streamSettledResolve;
  let upstreamAbortResolve;
  const allowStreamToContinue = new Promise((resolve) => { releaseStream = resolve; });
  const streamSettled = new Promise((resolve) => { streamSettledResolve = resolve; });
  const upstreamAborted = new Promise((resolve) => { upstreamAbortResolve = resolve; });
  const slowDeps = {
    async *streamChat({ signal }) {
      if (signal.aborted) upstreamAbortResolve();
      else signal.addEventListener('abort', upstreamAbortResolve, { once: true });
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
      body: JSON.stringify({
        bookId: book.id, sectionId: s.id, mode: 'next', expectedLastChapterId: null,
      }),
      signal: ctrl.signal,
    });
    const { out } = await readUntilText(res, '开头');
    assert.match(out, /开头/);

    ctrl.abort();
    let abortTimeout;
    const abortResult = await Promise.race([
      upstreamAborted.then(() => 'aborted'),
      new Promise((resolve) => { abortTimeout = setTimeout(() => resolve('timeout'), 1000); }),
    ]);
    clearTimeout(abortTimeout);
    assert.equal(abortResult, 'aborted');
    releaseStream();
    await streamSettled;
    await waitForInvariant(async () => {
      const sec = await store.readSection(book.id, s.id);
      assert.equal(sec.chapters.length, 0);
      assert.equal(existsSync(join(root, 'books', book.id, s.id, 'chapter-01.json')), false);
    });
  }, slowDeps);
});

test('gen/chapter next 在新章提交后、上下文读取前断连仍回滚空章', async () => {
  let releaseChapterLock;
  let markChapterLockHeld;
  let streamCallCount = 0;
  const chapterLockHeld = new Promise((resolve) => { markChapterLockHeld = resolve; });
  const keepChapterLock = new Promise((resolve) => { releaseChapterLock = resolve; });
  const deps = {
    async *streamChat() {
      streamCallCount += 1;
      yield '不应开始生成';
    },
    async nonStreamChat() { return ''; },
  };

  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const updatedAtBefore = (await store.readBook(book.id)).updatedAt;

    // addChapter 使用章节列表锁，生成上下文随后还会取得新章文件锁。
    // 单独占住后者，便可稳定命中“结构已提交、上下文尚未返回”的窗口。
    const held = store.withStoreLock(
      `book:${book.id}:section:${section.id}:chapter:chapter-01:file`,
      async () => {
        markChapterLockHeld();
        await keepChapterLock;
      },
    );
    await chapterLockHeld;

    const controller = new AbortController();
    const requestResult = fetch(base + '/api/gen/chapter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: book.id,
        sectionId: section.id,
        mode: 'next',
        expectedLastChapterId: null,
      }),
      signal: controller.signal,
    }).then(
      async (response) => {
        try { await readSSE(response); return null; }
        catch (error) { return error; }
      },
      (error) => error,
    );

    await waitForInvariant(async () => {
      assert.deepEqual((await store.readSection(book.id, section.id)).chapters, ['chapter-01']);
    });
    controller.abort();
    releaseChapterLock();
    await held;
    const requestError = await requestResult;
    assert.equal(requestError?.name, 'AbortError');

    await waitForInvariant(async () => {
      assert.deepEqual((await store.readSection(book.id, section.id)).chapters, []);
      assert.equal(
        existsSync(join(root, 'books', book.id, section.id, 'chapter-01.json')),
        false,
      );
      assert.equal((await store.readBook(book.id)).updatedAt, updatedAtBefore);
    });
    assert.equal(streamCallCount, 0);
  }, deps);
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
      body: JSON.stringify({
        bookId: book.id, sectionId: s.id, mode: 'next', expectedLastChapterId: null,
      }),
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

    const response = await post('/api/gen/chapter', {
      bookId: book.id,
      sectionId: targetSection.id,
      chapterId: target.id,
      mode: 'rewrite',
    });
    const sse = await readSSE(response);

    assert.match(sse, /"saved":true/);
    assert.match(capturedInstruction, /【上一章结尾】上一部结尾：风暴中的灯塔突然熄灭。/);
    assert.match(capturedInstruction, /【接下来要写】前往灯塔地下室寻找熄灭原因/);
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
  const titleDeps = {
    async *streamChat() { yield '新'; yield '大纲'; },
    async nonStreamChat() {
      return {
        toString() {
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
      yield '{"sections":[{"title":"起源","summary":"主角出身"},{"title":"冒险","summary":"踏上旅途"}]}';
    },
    async nonStreamChat() { return ''; },
  };
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '写侦探故事' }));
    // 通过 versionSet 走版本化写路径（不能直接 book.outline.content = ...，那样迁移后读不到）
    await store.versionSet(book.id, 'outline', '我的全书大纲XYZ');

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
    '{"sections":[{"title":"旧方案一","summary":"旧"},{"title":"旧方案二","summary":"旧"}]}',
  );
  await withServer(async () => {
    const book = await store.createBook({ premise: '规划锚点' });
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
    const res = await post('/api/gen/sections', { bookId: book.id });
    const sse = await readSSE(res);
    assert.match(sse, /"done":true/);
    assert.match(sse, /"parseError":true/);
  }, badDeps);
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
