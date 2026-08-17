import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-publication-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

const reviewCheckIds = [
  'goldenChapter', 'premisePromise', 'chapterGoal', 'obstacleEscalation',
  'characterChoice', 'sceneExecution', 'effectiveIncrement', 'payoff', 'endingHook',
  'tensionDynamics', 'foreshadowingExecution', 'worldExpansion', 'proseHumanity',
  'expressionBalance', 'repetitionRisk', 'longArcProgress', 'styleConsistency',
  'packagingPromise', 'contentRisk',
];

test('发布前检查逐字复核整书重复，并汇总当前审稿与人工平台确认', async () => {
  const book = await store.createBook({ premise: '镜像迷局', title: '镜城' });
  const section = await store.addSection(book.id, { title: '第一部' });
  const first = await store.addChapter(book.id, section.id, { title: '回声' });
  const second = await store.addChapter(book.id, section.id, { title: '复写' });
  const repeatedBody = '回声\n\n林越推开门。\n\n\n\n门后仍是同一条走廊。';
  await store.versionSet(
    book.id, `section:${section.id}:chapter:${first.id}`, repeatedBody,
  );
  await store.versionSet(
    book.id, `section:${section.id}:chapter:${second.id}`, repeatedBody,
  );

  const context = await store.readChapterReviewContext(book.id, section.id, first.id);
  const checks = reviewCheckIds.map((id) => ({
    id,
    status: id === 'effectiveIncrement' || id === 'contentRisk'
      ? 'risk'
      : id === 'styleConsistency' ? 'na' : 'pass',
    detail: id === 'effectiveIncrement'
      ? '本章状态没有真实变化。'
      : id === 'contentRisk'
        ? '出现现实人物影射，需要人工核对名誉风险。'
        : `${id} 未见风险。`,
  }));
  const saved = await store.saveChapterReview(book.id, section.id, first.id, {
    score: 70,
    verdict: '发布前仍需修改',
    webFictionSignals: {
      chapterFunction: '缓冲', conflictType: '环境困境', emotionTone: '压抑',
      payoffType: '无', dominantMode: '场景',
    },
    webFictionChecks: checks,
    issues: [{ title: '无增量', detail: '场景回到原点。' }],
    suggestions: [{ label: '增加变化', instruction: '让主角获得一条可验证线索。' }],
  }, {
    expectedBodyFingerprint: context.chapter.bodyFingerprint,
    expectedContextRevision: context.contextRevision,
  });
  assert.equal(saved.applied, true);

  const serialization = (await store.readBookStructure(book.id)).book.settings.serialization;
  await store.savePlatformConfirmation(book.id, {
    platform: '起点读书',
    rulesUrl: 'https://example.test/rules',
    aiPolicyUrl: 'https://example.test/ai-policy',
    contractReference: '已核对作者后台当前合同。',
    officialApiStatus: 'not-found', apiDocsUrl: '',
    confirmRules: true, confirmAiPolicy: true, confirmContract: true,
    confirmNoBypass: true,
  }, { expectedRevision: serialization.revision });

  const preflight = await store.readChapterPublicationPreflight(
    book.id, section.id, first.id,
    { expectedBodyFingerprint: context.chapter.bodyFingerprint },
  );
  assert.equal(preflight.status, 'risk');
  assert.equal(preflight.reviewCurrent, true);
  assert.equal(preflight.duplicateCount, 1);
  assert.deepEqual(preflight.duplicateMatches.map((item) => item.chapterId), [second.id]);
  assert.equal(preflight.checks.find((item) => item.id === 'format').status, 'risk');
  assert.match(preflight.checks.find((item) => item.id === 'format').detail, /重复章名|连续三行/);
  assert.equal(preflight.checks.find((item) => item.id === 'effectiveIncrement').status, 'risk');
  assert.equal(preflight.checks.find((item) => item.id === 'endingHook').status, 'pass');
  assert.equal(preflight.checks.find((item) => item.id === 'contentRisk').status, 'risk');
  assert.equal(preflight.checks.find((item) => item.id === 'platformRules').status, 'manual');
  // 体量与质感只报告可计算事实，短章标为待作者确认而不是风险，也不阻断发布。
  const prose = preflight.checks.find((item) => item.id === 'prose');
  assert.equal(prose.status, 'pending');
  assert.match(prose.detail, /正文 \d+ 字符；最长连续叙述块 \d+ 字符；身体与感官锚点 [\d.]+ 处\/千字。/);
  assert.match(prose.detail, /这些只是统计观察，是否需要调整由你判断。/);
  assert.equal(/不合格|未达标|不得发布/.test(prose.detail), false);
  assert.match(
    preflight.checks.find((item) => item.id === 'platformRules').detail,
    /起点读书.*不会标记为已合规/,
  );

  await store.versionSet(
    book.id, `section:${section.id}:chapter:${second.id}`, '另一章的独立正文。',
  );
  const withoutDuplicate = await store.readChapterPublicationPreflight(
    book.id, section.id, first.id,
    { expectedBodyFingerprint: context.chapter.bodyFingerprint },
  );
  assert.equal(withoutDuplicate.duplicateCount, 0);
  assert.equal(withoutDuplicate.checks.find((item) => item.id === 'duplicate').status, 'pass');

  await store.versionSet(
    book.id, `section:${section.id}:chapter:${first.id}`, '已经变化的目标正文。',
  );
  await assert.rejects(
    () => store.readChapterPublicationPreflight(
      book.id, section.id, first.id,
      { expectedBodyFingerprint: context.chapter.bodyFingerprint },
    ),
    /PUBLICATION_STALE/,
  );
});

test('没有当前有效审稿时发布前检查明确标记待检查而不冒充通过', async () => {
  const book = await store.createBook({ premise: '待审稿', title: '未审作品' });
  const section = await store.addSection(book.id, {});
  const chapter = await store.addChapter(book.id, section.id, { title: '起点' });
  await store.versionSet(
    book.id, `section:${section.id}:chapter:${chapter.id}`, '主角醒来，听见警报。',
  );
  const current = await store.readChapter(book.id, section.id, chapter.id);

  const preflight = await store.readChapterPublicationPreflight(
    book.id, section.id, chapter.id,
    { expectedBodyFingerprint: current.bodyFingerprint },
  );
  assert.equal(preflight.status, 'attention');
  assert.equal(preflight.reviewCurrent, false);
  for (const id of ['effectiveIncrement', 'endingHook', 'consistency', 'contentRisk']) {
    assert.equal(preflight.checks.find((item) => item.id === id).status, 'pending');
  }
});
