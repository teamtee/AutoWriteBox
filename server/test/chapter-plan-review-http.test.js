import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as store from '../store.js';
import { mountBookRoutes } from '../routes/books.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

beforeEach(() => store.setDataRoot(makeTestTempDir('novelbox-plan-review-http-')));
afterEach(cleanupTestTempDirs);

const reviewWithCarryover = async ({ messages }) => {
  if (!(messages?.[0]?.content ?? '').includes('审阅第')) return '{}';
  return JSON.stringify({
    score: 70, verdict: '目标尚未完成',
    issues: [{ title: '账本遗失', detail: '主角只拿到了封皮' }],
    suggestions: [{ label: '追账本', instruction: '下章根据封皮线索追查' }],
    planComparison: {
      overall: 'diverged', summary: '原定账本没有到手。',
      items: [{
        target: 'goal', outcome: 'missed', evidence: '正文结尾只留下账本封皮。',
      }],
      carryovers: [{
        sourceTarget: 'goal', text: '根据封皮找回账本',
        reason: '上章的主要行动仍在进行中。', suggestedField: 'goal',
      }],
    },
  });
};

test('章节接口把有效的上章未决项交给下章策划卡', async () => {
  const app = express();
  app.use(express.json());
  mountBookRoutes(app, { nonStreamChat: reviewWithCarryover });
  const started = await startTestServer(app);
  try {
    const book = await store.createBook({ premise: '追查账本', title: '暗账' });
    const section = await store.addSection(book.id, { title: '第一部' });
    const first = await store.addChapter(book.id, section.id, { title: '失手' });
    const second = await store.addChapter(book.id, section.id, { title: '追索' });
    await store.versionSet(
      book.id, `section:${section.id}:chapter:${first.id}`,
      '主角扑进火场，只抢出一片账本封皮。',
    );
    const storedFirst = await store.readChapter(book.id, section.id, first.id);
    await store.saveChapterPlan(book.id, section.id, first.id, {
      goal: '在火场中抢出完整账本',
    }, { expectedRevision: store.chapterPlanView(storedFirst.plan).revision });
    const context = await store.readChapterReviewContext(book.id, section.id, first.id);
    const path = `/api/books/${book.id}/sections/${section.id}/chapters`;
    const reviewed = await fetch(`${started.base}${path}/${first.id}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedBodyFingerprint: context.chapter.bodyFingerprint,
        expectedContextRevision: context.contextRevision,
      }),
    });
    assert.equal(reviewed.status, 200);

    const loadedNext = await (await fetch(`${started.base}${path}/${second.id}`)).json();
    assert.equal(loadedNext.incomingPlanCarryover.sourceChapterId, first.id);
    assert.equal(loadedNext.incomingPlanCarryover.items[0].text, '根据封皮找回账本');
    assert.equal(loadedNext.incomingPlanCarryover.items[0].suggestedField, 'goal');

    await store.versionSet(
      book.id, `section:${section.id}:chapter:${first.id}`,
      '主角返回火场，已经拿回完整账本。',
    );
    const afterRewrite = await (await fetch(`${started.base}${path}/${second.id}`)).json();
    assert.equal(afterRewrite.incomingPlanCarryover, null);
  } finally {
    await stopTestServer(started.server);
  }
});
