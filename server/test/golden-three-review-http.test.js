import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as store from '../store.js';
import { mountBookRoutes } from '../routes/books.js';
import { GOLDEN_THREE_CHECK_IDS } from '../golden-three-review-schema.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => { root = makeTestTempDir('golden-http-'); store.setDataRoot(root); });
afterEach(cleanupTestTempDirs);

const CHAPTER_TEXTS = ['接手试炼场', '招揽第一位客人', '客人通关并付费'];

const payload = () => ({
  score: 81, verdict: '三章形成了明确的经营启动闭环。',
  checks: GOLDEN_THREE_CHECK_IDS.map((id) => ({
    id, status: 'pass', summary: `${id} 已成立`,
    evidence: [{
      chapter: 3, quote: CHAPTER_TEXTS[2], analysis: '第三章给出可核对的局势变化。',
    }],
  })), 
  fixes: [{
    target: 'chapter-1', label: '强化代价', problem: '接手理由略轻。',
    instruction: '强化第一章接手试炼场的个人代价，保留已有异常事件。',
  }],
});

async function setupBook() {
  const book = await store.createBook({ premise: '经营试炼场', title: '试炼之城' });
  const section = await store.addSection(book.id, { expectedLastSectionId: null });
  for (const text of CHAPTER_TEXTS) {
    const state = await store.readSection(book.id, section.id);
    const chapter = await store.addChapter(book.id, section.id, {
      expectedLastChapterId: state.chapters.at(-1) ?? null,
    });
    await store.versionSet(book.id, `section:${section.id}:chapter:${chapter.id}`, text, {
      expectedRevision: store.versionRevision(chapter.body),
    });
  }
  return { book, section };
}

async function withServer(nonStreamChat, run) {
  const app = express();
  app.use(express.json());
  mountBookRoutes(app, { nonStreamChat });
  const started = await startTestServer(app);
  try { await run(started.base); } finally { await stopTestServer(started.server); }
}

test('联合审稿成功保存，并随第三章读取返回当前总检卡', async () => {
  const { book, section } = await setupBook();
  let instruction = '';
  await withServer(async ({ messages }) => {
    instruction = messages[0].content;
    return JSON.stringify(payload());
  }, async (base) => {
    const context = await store.readGoldenThreeReviewContext(book.id);
    const response = await fetch(`${base}/api/books/${book.id}/golden-three-review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedContextRevision: context.contextRevision }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).score, 81);
    assert.match(instruction, /接手试炼场/);
    const thirdId = (await store.readSection(book.id, section.id)).chapters[2];
    const chapterResponse = await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${thirdId}`,
    );
    const chapter = await chapterResponse.json();
    assert.equal(chapter.goldenThreeReviewState.ready, true);
    assert.equal(chapter.goldenThreeReviewState.isCurrent, true);
    assert.equal(chapter.goldenThreeReviewState.review.score, 81);
  });
});

test('正文不全时在模型调用前拒绝联合审稿', async () => {
  const book = await store.createBook({ premise: '未完成', title: '空章' });
  let calls = 0;
  await withServer(async () => { calls += 1; return JSON.stringify(payload()); }, async (base) => {
    const response = await fetch(`${base}/api/books/${book.id}/golden-three-review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedContextRevision: 'a'.repeat(43) }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'GOLDEN_THREE_INCOMPLETE' });
    assert.equal(calls, 0);
  });
});

test('模型返回前正文变化时拒绝保存旧联合审稿', async () => {
  const { book, section } = await setupBook();
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let entered;
  const startedModel = new Promise((resolve) => { entered = resolve; });
  await withServer(async () => {
    entered();
    await waiting;
    return JSON.stringify(payload());
  }, async (base) => {
    const context = await store.readGoldenThreeReviewContext(book.id);
    const pending = fetch(`${base}/api/books/${book.id}/golden-three-review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedContextRevision: context.contextRevision }),
    });
    await startedModel;
    const chapterId = (await store.readSection(book.id, section.id)).chapters[0];
    const chapter = await store.readChapter(book.id, section.id, chapterId);
    await store.versionSet(book.id, `section:${section.id}:chapter:${chapterId}`, '模型期间改稿', {
      expectedRevision: store.versionRevision(chapter.body),
    });
    release();
    const response = await pending;
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'GOLDEN_THREE_STALE' });
    assert.equal((await store.readBook(book.id)).settings.goldenThreeReview, undefined);
  });
});
