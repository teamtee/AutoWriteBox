import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as store from '../store.js';
import {
  buildChapterReviewRevisionInstruction, chapterReviewRevisionTargets,
  chapterReviewRevision,
} from '../chapter-review-revision-prompt.js';
import {
  CHAPTER_REVIEW_CHECK_IDS, normalizeChapterReviewChecks, normalizeChapterReviewSignals,
} from '../chapter-review-schema.js';
import { normalizeChapterPlanComparison } from '../chapter-plan-review-schema.js';
import { extractChapterReview } from '../llm.js';
import { mountBookRoutes } from '../routes/books.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';
import { startTestServer, stopTestServer } from './http-test-server.js';

let root;
beforeEach(() => { root = makeTestTempDir('review-revision-'); store.setDataRoot(root); });
afterEach(cleanupTestTempDirs);

function candidateReviewPayload(candidate, riskId = null) {
  const first = '他亮出旧证件，守卫转身追向站台。';
  const second = '守卫离岗后，证人才从货厢探头，却仍不肯交出名单';
  assert.ok(candidate.includes(first));
  assert.ok(candidate.includes(second));
  const checks = CHAPTER_REVIEW_CHECK_IDS.map((id) => {
    if (id === 'goldenChapter' || id === 'premisePromise') {
      return { id, status: 'na', detail: '本章不适用该专项职责。' };
    }
    if (id === 'contentRisk') {
      return { id, status: 'risk', detail: '作者仍需另行核对平台风险。' };
    }
    if (id === riskId) {
      return { id, status: 'risk', detail: '候选后段突然转成说明体。', evidence: second };
    }
    const evidenceById = {
      chapterGoal: { goalEvidence: { goalQuote: first, attemptQuote: second } },
      obstacleEscalation: { obstacleEvidence: { baseQuote: first, escalatedQuote: second } },
      characterChoice: { choiceEvidence: { pressureQuote: first, choiceQuote: second } },
      sceneExecution: { sceneEvidence: {
        actionQuote: '他亮出旧证件', reactionQuote: '守卫转身追向站台。', turnQuote: second,
      } },
      effectiveIncrement: { incrementEvidence: { triggerQuote: first, stateQuote: second } },
      payoff: { payoffEvidence: { actionQuote: first, resultQuote: second } },
      tensionDynamics: { tensionEvidence: {
        pressureQuote: '他亮出旧证件', shiftQuote: '守卫转身追向站台。', aftermathQuote: second,
      } },
      longArcProgress: { longArcEvidence: { threadQuote: first, progressQuote: second } },
    };
    return { id, status: 'pass', detail: `${id} 复审通过。`, ...(evidenceById[id] ?? {}) };
  });
  return {
    score: riskId ? 70 : 90, verdict: riskId ? '仍有新风险' : '精修候选已通过复审',
    webFictionSignals: {
      chapterFunction: '推进', conflictType: '身份冲突', emotionTone: '紧张',
      payoffType: '信息兑现', dominantMode: '场景',
      rhythmFingerprint: {
        pressurePattern: 'steady-rise', resolutionMethod: 'wit', payoffScale: 'chapter',
        hookMechanism: 'none', costType: 'none',
      },
    },
    webFictionChecks: checks,
    planComparison: { overall: 'aligned', summary: '策划已落地。', items: [
      { target: 'scene-1', outcome: 'fulfilled', evidence: second },
    ], carryovers: [] },
    issues: [{ title: riskId ? '新风险' : '已复核', detail: riskId ? '候选仍需继续修订。' : '候选未见新增正文风险。' }],
    suggestions: [{ label: riskId ? '继续修' : '保持', instruction: riskId ? '处理复审发现的新风险。' : '采用前由作者通读确认。' }],
  };
}

function reviewPayload() {
  return {
    score: 72, verdict: '场景承接断裂且中段同构',
    webFictionSignals: {
      chapterFunction: '推进', conflictType: '身份冲突', emotionTone: '紧张',
      payoffType: '信息兑现', dominantMode: '场景',
    },
    webFictionChecks: CHAPTER_REVIEW_CHECK_IDS.map((id) => ({
      id,
      status: id === 'sceneExecution' || id === 'proseHumanity' || id === 'repetitionRisk'
        || id === 'contentRisk'
        ? 'risk' : id === 'goldenChapter' || id === 'premisePromise' ? 'na' : 'pass',
      detail: id === 'sceneExecution' ? '第二场与第一场结果无关。'
        : id === 'proseHumanity' ? '中段连续同构短句。'
          : id === 'repetitionRisk' ? '站台广播反复出现。'
            : id === 'contentRisk' ? '作者需另行核对平台风险。' : `${id} 已通过。`,
      ...(id === 'proseHumanity'
        ? { evidence: '证人却在货厢里沉默' } : {}),
      ...(id === 'repetitionRisk'
        ? { evidence: '站台广播反复响起' } : {}),
      ...(id === 'chapterGoal' ? { goalEvidence: {
        goalQuote: '他亮出旧证件', attemptQuote: '守卫转身追向站台',
      } } : {}),
    })),
    planComparison: { overall: 'partial', summary: '一场未落地。', items: [
      { target: 'scene-1', outcome: 'missed', evidence: '正文只概述了冲突。' },
    ], carryovers: [] },
    issues: [{ title: '场景断链', detail: '后一场没有消费前场结果。' }],
    suggestions: [{ label: '补承接', instruction: '让后一场由身份暴露触发。' }],
  };
}

async function setupChapter() {
  const book = await store.createBook({ premise: '少年调查封锁区', title: '封锁线' });
  const section = await store.addSection(book.id, { expectedLastSectionId: null });
  const chapter = await store.addChapter(book.id, section.id, { expectedLastChapterId: null });
  const source = '他亮出旧证件，守卫转身追向站台。站台广播反复响起。证人却在货厢里沉默。';
  await store.versionSet(book.id, `section:${section.id}:chapter:${chapter.id}`, source, {
    expectedRevision: store.versionRevision(chapter.body),
  });
  await store.saveChapterPlan(book.id, section.id, chapter.id, { scenes: [{
    title: '站台追捕', trigger: '上一章收到限时求救', desire: '找到证人',
    obstacle: '守卫封锁站台', action: '亮出旧证件引开守卫',
    turn: '守卫离岗，货厢暴露', cost: '旧身份进入追捕名单',
  }] }, { expectedRevision: store.chapterPlanRevision(chapter.plan) });
  const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
  const saved = await store.saveChapterReview(book.id, section.id, chapter.id, reviewPayload(), {
    expectedBodyFingerprint: context.chapter.bodyFingerprint,
    expectedContextRevision: context.contextRevision,
  });
  return { book, section, chapter, source, review: saved.review };
}

async function withServer(nonStreamChat, run) {
  const app = express(); app.use(express.json());
  mountBookRoutes(app, { nonStreamChat });
  const started = await startTestServer(app);
  try { await run(started.base); } finally { await stopTestServer(started.server); }
}

test('审稿精修目标只选择正文风险和未落地策划，contentRisk 不自动改', () => {
  const targets = chapterReviewRevisionTargets(reviewPayload());
  assert.deepEqual(targets.risks.map((item) => item.id), [
    'sceneExecution', 'proseHumanity', 'repetitionRisk',
  ]);
  assert.equal(targets.planItems[0].target, 'scene-1');
  assert.ok(targets.protectedChecks.some((item) => item.id === 'chapterGoal'));
  assert.deepEqual(targets.issues, []);
  assert.deepEqual(targets.suggestions, []);
  const prompt = buildChapterReviewRevisionInstruction({
    chapterIndex: 4, context: '连续性', content: '正文', review: reviewPayload(),
    chapterPlan: {
      qualityProtocolVersion: 1,
      tensionArc: '压力来源：封站倒计时；变化链：闸机拒绝→主角出示证件→守卫离岗；选择高点：主角暴露身份；兑现与余波：货厢出现但主角被追捕',
    },
  });
  assert.match(prompt, /已通过保护项/);
  assert.match(prompt, /正文证据原句是确定性保护锚点/);
  assert.match(prompt, /同一句又被风险项明确引用/);
  assert.match(prompt, /场景断链/);
  assert.match(prompt, /contentRisk.*不在本次自动精修/s);
  assert.match(prompt, /只输出完整章节正文/);
  assert.match(prompt, /当前作者策划/);
  assert.match(prompt, /策划卡各字段想解决的问题/);
  assert.match(prompt, /不是需要在正文里出现的标签/);
});

test('审稿全通过时不启动无休止润色', () => {
  const clean = reviewPayload();
  clean.webFictionChecks = clean.webFictionChecks.map((item) => ({
    ...item, status: item.id === 'goldenChapter' || item.id === 'premisePromise' ? 'na' : 'pass',
  }));
  clean.planComparison.items[0].outcome = 'fulfilled';
  assert.equal(chapterReviewRevisionTargets(clean), null);
});

test('章节接口返回当前整份审稿指纹供精修锚定', async () => {
  const { book, section, chapter } = await setupChapter();
  await withServer(async () => '', async (base) => {
    const response = await fetch(`${base}/api/books/${book.id}/sections/${section.id}`
      + `/chapters/${chapter.id}`);
    assert.equal(response.status, 200);
    const loaded = await response.json();
    assert.equal(loaded.reviewRevision, chapterReviewRevision(loaded.review));
  });
});

test('审稿精修接口只返回锚定候选，不写入版本链', async () => {
  const { book, section, chapter, source } = await setupChapter();
  const revised = source
    .replaceAll('站台广播反复响起', '广播只响了一次')
    .replaceAll('证人却在货厢里沉默', '守卫离岗后，证人才从货厢探头，却仍不肯交出名单');
  let instruction = '';
  await withServer(async ({ messages }) => { instruction = messages[0].content; return revised; },
    async (base) => {
      const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
      const reviewRevision = chapterReviewRevision(context.chapter.review);
      const before = await store.readChapter(book.id, section.id, chapter.id);
      const response = await fetch(`${base}/api/books/${book.id}/sections/${section.id}`
        + `/chapters/${chapter.id}/review-revision-candidate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedBodyFingerprint: context.chapter.bodyFingerprint,
          expectedContextRevision: context.contextRevision,
          expectedReviewRevision: reviewRevision,
        }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.candidate, revised);
      assert.equal(result.improvement.valid, true);
      assert.equal(result.improvement.targetEvidenceRemoved, true);
      assert.equal(result.improvement.riskEvidenceCount, 2);
      assert.deepEqual(result.improvement.remainingRiskEvidence, []);
      assert.equal(result.improvement.protectedEvidenceRetained, true);
      assert.equal(result.improvement.protectedEvidenceCount, 2);
      assert.equal(result.sourceReviewRevision, reviewRevision);
      assert.equal(result.candidateFingerprint, store.contentFingerprint(revised));
      assert.match(instruction, /不要自由重写整章/);
      assert.match(instruction, /后一场消费前一场/);
      assert.match(instruction, /当前作者策划/);
      assert.deepEqual((await store.readChapter(book.id, section.id, chapter.id)).body, before.body);
    });
});

test('精修候选必须重新审稿且复审结果不写入章节', async () => {
  const { book, section, chapter, source } = await setupChapter();
  const revised = source
    .replaceAll('站台广播反复响起', '广播只响了一次')
    .replaceAll('证人却在货厢里沉默', '守卫离岗后，证人才从货厢探头，却仍不肯交出名单');
  const cleanReview = candidateReviewPayload(revised);
  const savedPlan = (await store.readChapter(book.id, section.id, chapter.id)).plan;
  assert.ok(normalizeChapterReviewSignals(cleanReview.webFictionSignals, {
    truncate: true, requireRhythmFingerprint: true,
  }), '复审通过 fixture 的节奏信号必须合法');
  assert.ok(normalizeChapterReviewChecks(cleanReview.webFictionChecks, {
    truncate: true, chapterContent: revised,
    requireProseHumanityEvidence: true, requireStyleRiskEvidence: true,
    requirePayoffEvidence: true, requireGoldenEvidence: true, requirePremiseEvidence: true,
    requireGoalEvidence: true, requireObstacleEvidence: true, requireSceneEvidence: true,
    requireIncrementEvidence: true, requireChoiceEvidence: true,
    requireCostEvidence: false, requireHookEvidence: false,
    requireTensionEvidence: true, requireLongArcEvidence: true,
  }), '复审通过 fixture 的正文检查必须合法');
  assert.ok(normalizeChapterPlanComparison(cleanReview.planComparison, {
    truncate: true, chapterPlan: savedPlan, requireForPlanned: true,
  }), '复审通过 fixture 的策划比较必须合法');
  assert.ok(extractChapterReview(JSON.stringify(cleanReview), {
    chapterPlan: savedPlan, chapterContent: revised,
  }), '复审通过 fixture 必须满足当前审稿协议');
  let verificationInstruction = '';
  await withServer(async ({ messages }) => {
    verificationInstruction = messages[0].content;
    return JSON.stringify(cleanReview);
  }, async (base) => {
    const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
    const before = await store.readChapter(book.id, section.id, chapter.id);
    const response = await fetch(`${base}/api/books/${book.id}/sections/${section.id}`
      + `/chapters/${chapter.id}/review-revision-candidate/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidate: revised,
        expectedBodyFingerprint: context.chapter.bodyFingerprint,
        expectedContextRevision: context.contextRevision,
        expectedReviewRevision: chapterReviewRevision(context.chapter.review),
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.verified, true);
    assert.equal(result.remainingRiskCount, 0);
    assert.equal(result.remainingPlanRiskCount, 0);
    assert.equal(result.candidateFingerprint, store.contentFingerprint(revised));
    assert.match(verificationInstruction, /广播只响了一次/);
    assert.match(verificationInstruction, /守卫离岗后，证人才从货厢探头/);
    assert.doesNotMatch(verificationInstruction, /站台广播反复响起/);
    assert.doesNotMatch(verificationInstruction, /证人却在货厢里沉默/);
    const after = await store.readChapter(book.id, section.id, chapter.id);
    assert.deepEqual(after.body, before.body);
    assert.deepEqual(after.review, before.review);
  });
});

test('候选复审发现新风险时明确阻止视为通过', async () => {
  const { book, section, chapter, source } = await setupChapter();
  const revised = source
    .replaceAll('站台广播反复响起', '广播只响了一次')
    .replaceAll('证人却在货厢里沉默', '守卫离岗后，证人才从货厢探头，却仍不肯交出名单');
  const riskyReview = candidateReviewPayload(revised, 'styleConsistency');
  assert.ok(extractChapterReview(JSON.stringify(riskyReview), {
    chapterPlan: (await store.readChapter(book.id, section.id, chapter.id)).plan,
    chapterContent: revised,
  }), '复审风险 fixture 必须满足当前审稿协议');
  await withServer(async () => JSON.stringify(riskyReview), async (base) => {
    const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
    const response = await fetch(`${base}/api/books/${book.id}/sections/${section.id}`
      + `/chapters/${chapter.id}/review-revision-candidate/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidate: revised,
        expectedBodyFingerprint: context.chapter.bodyFingerprint,
        expectedContextRevision: context.contextRevision,
        expectedReviewRevision: chapterReviewRevision(context.chapter.review),
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.verified, false);
    assert.equal(result.remainingRiskCount, 1);
  });
});

test('审稿精修删掉已通过正文证据时拒绝返回修一处毁一处候选', async () => {
  const { book, section, chapter, source } = await setupChapter();
  const damaged = source.replaceAll('他亮出旧证件', '他做了一个模糊动作')
    .replaceAll('站台广播反复响起', '广播只响了一次')
    .replaceAll('证人却在货厢里沉默', '守卫离岗后，证人才从货厢探头');
  await withServer(async () => damaged, async (base) => {
    const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
    const response = await fetch(`${base}/api/books/${book.id}/sections/${section.id}`
      + `/chapters/${chapter.id}/review-revision-candidate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedBodyFingerprint: context.chapter.bodyFingerprint,
        expectedContextRevision: context.contextRevision,
        expectedReviewRevision: chapterReviewRevision(context.chapter.review),
      }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: 'CHAPTER_REVIEW_REVISION_NOT_IMPROVED',
    });
  });
});

test('审稿精修仍保留风险原句时拒绝返回伪改善候选', async () => {
  const { book, section, chapter, source } = await setupChapter();
  await withServer(async () => source, async (base) => {
    const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
    const response = await fetch(`${base}/api/books/${book.id}/sections/${section.id}`
      + `/chapters/${chapter.id}/review-revision-candidate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedBodyFingerprint: context.chapter.bodyFingerprint,
        expectedContextRevision: context.contextRevision,
        expectedReviewRevision: chapterReviewRevision(context.chapter.review),
      }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: 'CHAPTER_REVIEW_REVISION_NOT_IMPROVED',
    });
  });
});

test('正文、上下文或审稿锚点过期时在调用模型前拒绝精修', async () => {
  const { book, section, chapter } = await setupChapter();
  let calls = 0;
  await withServer(async () => { calls += 1; return '不会调用'; }, async (base) => {
    const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
    const response = await fetch(`${base}/api/books/${book.id}/sections/${section.id}`
      + `/chapters/${chapter.id}/review-revision-candidate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedBodyFingerprint: context.chapter.bodyFingerprint,
        expectedContextRevision: context.contextRevision,
        expectedReviewRevision: 'R'.repeat(43),
      }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'CHAPTER_REVIEW_REVISION_CANDIDATE_STALE' });
    assert.equal(calls, 0);
  });
});
