import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import * as store from '../store.js';
import {
  normalizeChapterReviewWorldGateCandidates,
} from '../chapter-review-world-schema.js';
import { chapterReviewRevision } from '../chapter-review-revision-prompt.js';
import { extractChapterReview, extractSectionsPlan } from '../llm.js';
import { buildChapterReviewInstruction, buildSectionsInstruction } from '../prompts.js';
import { mountBookRoutes } from '../routes/books.js';
import { worldRevealRoute } from '../world-bible.js';
import {
  invalidateWorldGateSources, worldProgressPlanningState, worldProgressRevision,
} from '../world-progress-schema.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import {
  validSectionPlanFixture, validWorldBibleFixture,
} from './section-plan-fixture.js';

const EVIDENCE = '他把两地盖章记录并排压在灯下，编号和签发时刻完全吻合。';
const GATE = '必须用正文行动完成第1层进入门槛';
const OUTLINE = [
  '【世界层级】当前生活圈',
  '【世界阶段承诺】第1层承诺通过人物选择兑现',
  '【可验证世界证据】第1层现场物证可被人物核验',
  '【人物行动】主角主动追查第1层现场物证',
  '【世界选择与代价】主角保住证据并失去第1层容身处',
  '【阶段认知增量】读者确认第1层规则的社会影响',
  '【本部保留未知】暂不揭示第1层幕后者真实身份',
  `【下一层门槛】${GATE}`,
  '【门槛结果】本部完成门槛，下部进入下一层',
  '【门槛证据进度】主角将用两地记录完成交叉核验',
].join('\n');

let root;
beforeEach(() => {
  root = makeTestTempDir('world-progress-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

function reviewPayload() {
  return {
    score: 88,
    verdict: '人物行动用跨地证据完成了本层进入门槛',
    issues: [{ title: '余波略短', detail: '可以补一拍主角承担失去容身处的反应。' }],
    suggestions: [{ label: '补代价', instruction: '只补写主角得知住处被封后的即时选择。' }],
    worldGateCandidates: [{
      fromLayer: '当前生活圈',
      toLayer: '中期势力与地域',
      gateCondition: GATE,
      summary: '两地记录完成交叉核验，证明主角已取得进入相邻地域层的行动依据。',
      evidence: EVIDENCE,
    }],
  };
}

async function setup() {
  const book = await store.createBook({ premise: '追查跨区失踪案', title: '双城印记' });
  const stored = await store.readBook(book.id);
  await store.versionSet(book.id, 'core:world', validWorldBibleFixture(), {
    expectedRevision: store.versionRevision(stored.settings.core.world),
  });
  const section = await store.addSection(book.id, { title: '第一部', outline: OUTLINE });
  const chapter = await store.addChapter(book.id, section.id, { title: '双印' });
  const content = `他追到边站。${EVIDENCE}他决定携证据去邻区查签发人。`;
  await store.versionSet(book.id, `section:${section.id}:chapter:${chapter.id}`, content, {
    expectedRevision: store.versionRevision(chapter.body),
  });
  const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
  const saved = await store.saveChapterReview(
    book.id, section.id, chapter.id, reviewPayload(),
    {
      expectedBodyFingerprint: context.chapter.bodyFingerprint,
      expectedContextRevision: context.contextRevision,
    },
  );
  return { book, section, chapter, saved };
}

test('审稿世界门槛候选只接受当前分部合同与正文连续原句', () => {
  const valid = normalizeChapterReviewWorldGateCandidates(
    reviewPayload().worldGateCandidates,
    { sectionOutline: OUTLINE, chapterContent: `前文${EVIDENCE}后文` },
  );
  assert.equal(valid[0].gateCondition, GATE);
  assert.equal(normalizeChapterReviewWorldGateCandidates(
    [{ ...reviewPayload().worldGateCandidates[0], evidence: '模型概括，不是正文原句' }],
    { sectionOutline: OUTLINE, chapterContent: EVIDENCE },
  ), null);
  assert.equal(normalizeChapterReviewWorldGateCandidates(
    reviewPayload().worldGateCandidates,
    { sectionOutline: OUTLINE.replace('本部完成门槛，下部进入下一层', '本部不解锁下一层'), chapterContent: EVIDENCE },
  ), null);
});

test('有分部世界合同时审稿协议强制返回候选数组且不自动确认', () => {
  const payload = {
    score: 70, verdict: '正文尚未完成交叉核验',
    issues: [{ title: '证据未闭环', detail: '人物只有单地记录，不能完成跨地门槛。' }],
    suggestions: [{ label: '补核验', instruction: '让人物取得第二地原始记录并现场比对。' }],
  };
  assert.equal(extractChapterReview(JSON.stringify(payload), {
    sectionOutline: OUTLINE, chapterContent: '他只拿到一张记录。',
  }), null);
  const parsed = extractChapterReview(JSON.stringify({
    ...payload, worldGateCandidates: [],
  }), { sectionOutline: OUTLINE, chapterContent: '他只拿到一张记录。' });
  assert.deepEqual(parsed.worldGateCandidates, []);
  const instruction = buildChapterReviewInstruction({
    chapterIndex: 1, content: '正文', context: '上下文', sectionOutline: OUTLINE,
  });
  assert.match(instruction, /作者确认/);
  assert.match(instruction, /正文连续原文/);
  assert.match(instruction, /worldGateCandidates/);
});

test('作者确认后才推进世界层级，后续规划只能从已确认层开始', async () => {
  const { book, section, chapter, saved } = await setup();
  const before = await store.readBook(book.id);
  const initialRevision = worldProgressRevision(before.settings.worldProgressState);
  assert.equal(worldProgressPlanningState(
    before.settings.worldProgressState,
    store.currentText(before.settings.core.world),
  ).startLayer, '当前生活圈');
  const result = await store.applyChapterReviewWorldGateCandidate(
    book.id, section.id, chapter.id,
    {
      expectedBodyFingerprint: saved.review.sourceFingerprint,
      expectedReviewRevision: chapterReviewRevision(saved.review),
      expectedWorldProgressRevision: initialRevision,
    },
  );
  assert.equal(result.gate.status, 'active');
  assert.equal(result.gate.toLayer, '中期势力与地域');
  const after = await store.readBook(book.id);
  assert.equal(worldProgressPlanningState(
    after.settings.worldProgressState,
    store.currentText(after.settings.core.world),
  ).startLayer, '中期势力与地域');
  const route = worldRevealRoute(store.currentText(after.settings.core.world));
  const sections = JSON.parse(validSectionPlanFixture()).sections.slice(1);
  assert.ok(extractSectionsPlan(JSON.stringify({ sections }), {
    worldRoute: route, startLayer: '中期势力与地域',
  }));
  assert.equal(extractSectionsPlan(validSectionPlanFixture(), {
    worldRoute: route, startLayer: '中期势力与地域',
  }), null);
  assert.match(buildSectionsInstruction({
    outline: '全书大纲', worldRoute: route,
    occurredSummary: '第一部已完结', startLayer: '中期势力与地域',
  }), /已发生摘要只能说明剧情事实，不能自行解锁世界层/);
});

test('确认接口带正文、审稿和世界进度三重锚点', async () => {
  const { book, section, chapter, saved } = await setup();
  const stored = await store.readBook(book.id);
  const app = express(); app.use(express.json());
  mountBookRoutes(app, { nonStreamChat: async () => '' });
  const started = await startTestServer(app);
  try {
    const response = await fetch(`${started.base}/api/books/${book.id}/sections/${section.id}`
      + `/chapters/${chapter.id}/review-world-gate-candidate/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedBodyFingerprint: saved.review.sourceFingerprint,
        expectedReviewRevision: chapterReviewRevision(saved.review),
        expectedWorldProgressRevision: worldProgressRevision(stored.settings.worldProgressState),
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).gate.evidence, EVIDENCE);
  } finally {
    await stopTestServer(started.server);
  }
});

test('未发布证据正文被改写后自动使世界门槛失效', async () => {
  const { book, section, chapter, saved } = await setup();
  let stored = await store.readBook(book.id);
  await store.applyChapterReviewWorldGateCandidate(
    book.id, section.id, chapter.id,
    {
      expectedBodyFingerprint: saved.review.sourceFingerprint,
      expectedReviewRevision: chapterReviewRevision(saved.review),
      expectedWorldProgressRevision: worldProgressRevision(stored.settings.worldProgressState),
    },
  );
  const loaded = await store.readChapter(book.id, section.id, chapter.id);
  await store.versionSet(
    book.id, `section:${section.id}:chapter:${chapter.id}`, '他烧掉记录，决定留在城内。',
    { expectedRevision: store.versionRevision(loaded.body) },
  );
  stored = await store.readBook(book.id);
  assert.equal(stored.settings.worldProgressState.gates[0].status, 'stale');
  assert.equal(worldProgressPlanningState(
    stored.settings.worldProgressState,
    store.currentText(stored.settings.core.world),
  ).startLayer, '当前生活圈');
});

test('本地草稿保留旧发布门槛，但发布新版后旧证据门槛失效', async () => {
  const { book, section, chapter, saved } = await setup();
  let stored = await store.readBook(book.id);
  await store.applyChapterReviewWorldGateCandidate(
    book.id, section.id, chapter.id,
    {
      expectedBodyFingerprint: saved.review.sourceFingerprint,
      expectedReviewRevision: chapterReviewRevision(saved.review),
      expectedWorldProgressRevision: worldProgressRevision(stored.settings.worldProgressState),
    },
  );
  let loaded = await store.readChapter(book.id, section.id, chapter.id);
  stored = await store.readBook(book.id);
  await store.publishChapterVersion(book.id, section.id, chapter.id, {
    expectedBodyFingerprint: loaded.bodyFingerprint,
    expectedMemoryRevision: store.bookMemoryRevision(stored),
  });

  await store.versionSet(
    book.id, `section:${section.id}:chapter:${chapter.id}`,
    '新版中，他销毁两地记录，决定暂时留在城内继续调查。',
    { expectedRevision: store.versionRevision(loaded.body) },
  );
  stored = await store.readBook(book.id);
  assert.equal(stored.settings.worldProgressState.gates[0].status, 'active');

  loaded = await store.readChapter(book.id, section.id, chapter.id);
  await store.publishChapterVersion(book.id, section.id, chapter.id, {
    expectedBodyFingerprint: loaded.bodyFingerprint,
    expectedMemoryRevision: store.bookMemoryRevision(stored),
  });
  stored = await store.readBook(book.id);
  assert.equal(stored.settings.worldProgressState.gates[0].status, 'stale');
  assert.equal(worldProgressPlanningState(
    stored.settings.worldProgressState,
    store.currentText(stored.settings.core.world),
  ).startLayer, '当前生活圈');
});

test('上游门槛失效时一并撤销依赖它的后续活动层级', () => {
  const state = {
    gates: [
      {
        id: `world_gate_${'a'.repeat(32)}`,
        fromLayer: '当前生活圈', toLayer: '中期势力与地域',
        gateCondition: GATE, summary: '完成第一层门槛', evidence: EVIDENCE,
        source: { sectionId: 'section-01', chapterId: 'chapter-01', bodyFingerprint: 'A'.repeat(43) },
        status: 'active', confirmedAt: '2026-08-12T00:00:00.000Z',
      },
      {
        id: `world_gate_${'b'.repeat(32)}`,
        fromLayer: '中期势力与地域', toLayer: '长线文明与历史',
        gateCondition: '完成第二层进入门槛', summary: '完成第二层门槛', evidence: '后续证据',
        source: { sectionId: 'section-02', chapterId: 'chapter-02', bodyFingerprint: 'B'.repeat(43) },
        status: 'active', confirmedAt: '2026-08-12T01:00:00.000Z',
      },
    ],
  };
  const book = { settings: { worldProgressState: state } };
  assert.equal(invalidateWorldGateSources(book, {
    sectionId: 'section-01', chapterId: 'chapter-01', bodyFingerprint: 'A'.repeat(43),
  }), true);
  assert.deepEqual(book.settings.worldProgressState.gates.map((gate) => gate.status), [
    'stale', 'stale',
  ]);
});
