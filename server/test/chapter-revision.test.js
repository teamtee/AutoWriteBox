import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as store from '../store.js';
import {
  CHAPTER_REVISION_STAGES, chapterRevisionImprovement, chapterRevisionStage,
  chapterRevisionStyleMetrics, normalizeChapterRevisionCandidate,
} from '../chapter-revision-schema.js';
import { MAX_VERSION_TEXT_CHARS } from '../limits.js';
import {
  buildChapterRevisionInstruction, CHAPTER_REVISION_SYSTEM_APPENDIX,
} from '../chapter-revision-prompt.js';
import { mountBookRoutes } from '../routes/books.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => { root = makeTestTempDir('chapter-revision-'); store.setDataRoot(root); });
afterEach(cleanupTestTempDirs);

async function setupChapter() {
  const book = await store.createBook({ premise: '少年经营一间试炼场', title: '试炼场' });
  const section = await store.addSection(book.id, { expectedLastSectionId: null });
  const chapter = await store.addChapter(book.id, section.id, { expectedLastChapterId: null });
  const source = '他走进空荡荡的试炼场。众人进行了激烈的争论。最后，他决定接下这间铺子。'.repeat(20);
  await store.versionSet(book.id, `section:${section.id}:chapter:${chapter.id}`, source, {
    expectedRevision: store.versionRevision(chapter.body),
  });
  return { book, section, chapter, source };
}

async function withServer(nonStreamChat, run) {
  const app = express();
  app.use(express.json());
  mountBookRoutes(app, { nonStreamChat });
  const started = await startTestServer(app);
  try { await run(started.base); } finally { await stopTestServer(started.server); }
}

test('六类修订阶段各自有明确焦点与护栏', () => {
  assert.equal(CHAPTER_REVISION_STAGES.length, 6);
  assert.equal(new Set(CHAPTER_REVISION_STAGES.map((stage) => stage.id)).size, 6);
  for (const stage of CHAPTER_REVISION_STAGES) {
    assert.equal(chapterRevisionStage(stage.id), stage);
    const prompt = buildChapterRevisionInstruction({
      stageId: stage.id, chapterIndex: 1, bookChapterIndex: 1,
      context: '人物与设定', content: '完整正文',
    });
    assert.match(prompt, new RegExp(stage.label));
    assert.match(prompt, /只改确有本阶段问题的段落/);
    assert.match(prompt, /保留原文事件顺序、事件结果、人物决定/);
    assert.match(prompt, /输出完整章节正文/);
  }
  assert.match(CHAPTER_REVISION_SYSTEM_APPENDIX, /不会自动保存|不会自动保存，将由作者/);
  assert.equal(chapterRevisionStage('unknown'), null);
});

test('候选规范化拒绝代码围栏、超限文本和把长章压成摘要', () => {
  const source = '原文'.repeat(300);
  assert.equal(normalizeChapterRevisionCandidate('  修订全文  ', '短文'), '修订全文');
  assert.equal(normalizeChapterRevisionCandidate('```\n修订全文\n```', '短文'), null);
  assert.equal(normalizeChapterRevisionCandidate('摘要', source), null);
  assert.equal(normalizeChapterRevisionCandidate(
    `正文泄漏 promise_${'a'.repeat(32)}`, source,
  ), null);
});

test('审稿精修必须移除全部带引文风险并保留已通过证据原句', () => {
  const source = '她必须先找到证人。她沿着血迹推开仓门。守卫封锁了出口。';
  const review = { webFictionChecks: [
    { id: 'chapterGoal', status: 'pass', detail: '目标落地',
      evidence: '她沿着血迹推开仓门。', goalEvidence: {
        goalQuote: '她必须先找到证人。', attemptQuote: '她沿着血迹推开仓门。',
      } },
    { id: 'sceneExecution', status: 'risk', detail: '转折概述化' },
    { id: 'repetitionRisk', status: 'risk', detail: '重复解释',
      evidence: '守卫封锁了出口。' },
  ] };
  const unchanged = chapterRevisionImprovement(source, source, { review });
  assert.equal(unchanged.candidateChanged, false);
  assert.equal(unchanged.valid, false);
  const damaged = chapterRevisionImprovement(
    '她沿着血迹推开仓门。守卫封锁了出口。', source, { review },
  );
  assert.equal(damaged.protectedEvidenceRetained, false);
  assert.deepEqual(damaged.lostProtectedEvidence, ['她必须先找到证人。']);
  assert.equal(damaged.valid, false);
  const lostGeneric = chapterRevisionImprovement(
    '她必须先找到证人。守卫封锁了出口。', source, { review },
  );
  assert.deepEqual(lostGeneric.lostProtectedEvidence, ['她沿着血迹推开仓门。']);
  assert.equal(lostGeneric.valid, false);
  const partial = chapterRevisionImprovement(
    `${source}她把账本拍在桌上，证人抬头后，守卫转身锁门。`, source, { review },
  );
  assert.equal(partial.riskEvidenceCount, 1);
  assert.deepEqual(partial.remainingRiskEvidence, ['守卫封锁了出口。']);
  assert.equal(partial.valid, false);
  const improved = chapterRevisionImprovement(
    '她必须先找到证人。她沿着血迹推开仓门。她把账本拍在桌上，证人抬头后，守卫转身锁门。',
    source, { review },
  );
  assert.equal(improved.candidateChanged, true);
  assert.equal(improved.riskEvidenceRemoved, true);
  assert.equal(improved.protectedEvidenceCount, 2);
  assert.equal(improved.protectedEvidenceRetained, true);
  assert.equal(improved.valid, true);
});

test('风险引文与通过证据重叠时只解除冲突锚点而不形成无解门禁', () => {
  const source = '她必须先找到证人。她沿血迹推开仓门。';
  const review = { webFictionChecks: [
    { id: 'chapterGoal', status: 'pass', detail: '目标成立', goalEvidence: {
      goalQuote: '她必须先找到证人。', attemptQuote: '她沿血迹推开仓门。',
    } },
    { id: 'styleConsistency', status: 'risk', detail: '目标句语气跑调',
      evidence: '她必须先找到证人。' },
  ] };
  const improvement = chapterRevisionImprovement(
    '她得在换岗前找到证人。她沿血迹推开仓门。', source, { review },
  );
  assert.deepEqual(improvement.conflictedProtectedEvidence, ['她必须先找到证人。']);
  assert.equal(improvement.protectedEvidenceCount, 1);
  assert.equal(improvement.protectedEvidenceRetained, true);
  assert.equal(improvement.riskEvidenceRemoved, true);
  assert.equal(improvement.valid, true);
});

test('样式指标在空白、单段与未闭合对话边界保持有限', () => {
  for (const source of ['', '   \n\n ', '只有一段正文。', '“未闭合的对话']) {
    const metrics = chapterRevisionStyleMetrics(source);
    for (const [key, value] of Object.entries(metrics)) {
      assert.equal(Number.isFinite(value), true, `${key} 必须是有限数值`);
      assert.ok(value >= 0, `${key} 不能为负数`);
    }
  }
  assert.equal(chapterRevisionStyleMetrics('').maxConsecutiveSimilarParagraphs, 0);
  assert.equal(chapterRevisionStyleMetrics('只有一段正文。').maxConsecutiveSimilarParagraphs, 1);
  assert.equal(chapterRevisionStyleMetrics('“现在他知道了。”').authorVerdictCount, 0);
});

test('破折号风险使用每千字密度和段落集中度而非只看总数', () => {
  const sparse = chapterRevisionStyleMetrics(
    `${'普通叙述。'.repeat(100)}\n\n${'另一段叙述。'.repeat(100)}\n\n——一次转折。`,
  );
  const dense = chapterRevisionStyleMetrics('一句——停顿。\n\n二句——停顿。\n\n三句——停顿。');
  assert.equal(sparse.emDashCount, 1);
  assert.ok(sparse.emDashPerKChars < dense.emDashPerKChars);
  assert.ok(sparse.emDashParagraphRatio < dense.emDashParagraphRatio);
  const source = `${'普通叙述。'.repeat(300)}——一次转折。`;
  const compressed = '普通叙述。——一次转折。';
  const improvement = chapterRevisionImprovement(compressed, source, {
    stageId: 'scene-grounding',
  });
  assert.equal(improvement.noStyleRegression, false);
  assert.equal(improvement.valid, false);
});

test('明喻风险使用每千字密度和段落集中度，不惩罚单个贴切比喻', () => {
  const sparse = chapterRevisionStyleMetrics(
    `${'普通叙述。'.repeat(100)}\n\n${'另一段叙述。'.repeat(100)}\n\n月光像是薄霜落在窗台。`,
  );
  const dense = chapterRevisionStyleMetrics('灯像是眼睛。\n\n门仿佛嘴。\n\n影子如同手。');
  assert.equal(sparse.simileMarkerCount, 1);
  assert.ok(sparse.similePerKChars < dense.similePerKChars);
  assert.ok(sparse.simileParagraphRatio < dense.simileParagraphRatio);
  const source = `${'普通叙述。'.repeat(300)}月光像是薄霜。`;
  const compressed = '月光像是薄霜。';
  const improvement = chapterRevisionImprovement(compressed, source, {
    stageId: 'scene-grounding',
  });
  assert.equal(improvement.noStyleRegression, false);
  assert.equal(improvement.valid, false);
});

test('连续短段风险区分正常散落短段和成片金句腔', () => {
  const scattered = chapterRevisionStyleMetrics('短句。\n\n这是一个足够长的正常叙述段落。\n\n再短。');
  const clustered = chapterRevisionStyleMetrics(
    '第一句。\n\n第二句。\n\n第三句。\n\n这是一个足够长的正常叙述段落。',
  );
  assert.equal(scattered.maxConsecutiveShortParagraphs, 1);
  assert.equal(scattered.shortParagraphClusterRatio, 0);
  assert.equal(clustered.maxConsecutiveShortParagraphs, 3);
  assert.ok(clustered.shortParagraphClusterRatio > scattered.shortParagraphClusterRatio);
  const source = '短句。\n\n这是一个足够长的正常叙述段落。\n\n再短。';
  const candidate = '短句。\n\n再短。\n\n又短。';
  const improvement = chapterRevisionImprovement(candidate, source, {
    stageId: 'scene-grounding',
  });
  assert.equal(improvement.noStyleRegression, false);
  assert.equal(improvement.valid, false);
});

test('同强度节奏专项必须打破六段以上连续同长度且不得靠短段回归', () => {
  const source = Array.from({ length: 7 }, (_, index) =>
    `第${index + 1}段保持几乎完全相同的长度和相同的叙述强度。`).join('\n\n');
  const sourceMetrics = chapterRevisionStyleMetrics(source);
  assert.ok(sourceMetrics.maxConsecutiveSimilarParagraphs >= 6);
  const improved = [
    '第一声警报响过后，走廊重新安静，他贴住门板等了一会儿，楼下始终没有脚步声。',
    '第二声警报拖得更长，门缝下的红光跟着闪烁。有人在楼下撞门，先是一记，停了两秒，又是两记。',
    '他把钥匙插进锁孔，却没有立即转动。掌心的汗沿着金属齿槽往下淌，直到第三声警报骤然停住，他才推门出去。',
  ].join('\n\n');
  const result = chapterRevisionImprovement(improved, source, { stageId: 'intensity-shape' });
  assert.equal(result.valid, true);
  assert.ok(result.candidateMetrics.maxConsecutiveSimilarParagraphs
    < sourceMetrics.maxConsecutiveSimilarParagraphs);
  const unchanged = chapterRevisionImprovement(
    source.replaceAll('叙述强度', '情绪力度'), source, { stageId: 'intensity-shape' },
  );
  assert.equal(unchanged.valid, false);
});

test('场景落地专项必须减少强概述壳句且不误伤必要信息概述', () => {
  const source = '众人进行了一番激烈的争论，最终决定接下这间铺子。';
  assert.equal(chapterRevisionStyleMetrics(source).sceneSummaryShellCount, 1);
  const improved = chapterRevisionImprovement(
    '掌柜把钥匙推到桌心，“要铺子，就替我守过今晚。”他按住钥匙，其他人的话音一下断了。',
    source, { stageId: 'scene-grounding' },
  );
  assert.equal(improved.valid, true);
  const renamed = chapterRevisionImprovement(
    '众人进行了一番激烈的讨论，最后决定接下这间铺子。',
    source, { stageId: 'scene-grounding' },
  );
  assert.equal(renamed.valid, false);
  assert.equal(chapterRevisionStyleMetrics('系统确认发生了入侵。').sceneSummaryShellCount, 0);
  assert.equal(chapterRevisionStyleMetrics('他进行了完整的意识上传。').sceneSummaryShellCount, 0);
});

test('抽象总结专项必须减少叙述中的作者代判且不误伤对话', () => {
  const source = '门后没有回应。\n\n这让他更恨。\n\n“你现在明白了吗？”她问。';
  const sourceMetrics = chapterRevisionStyleMetrics(source);
  assert.equal(sourceMetrics.authorVerdictCount, 1);
  const improved = chapterRevisionImprovement(
    '门后没有回应。\n\n他攥住门把，指节发白。\n\n“你现在明白了吗？”她问。',
    source, { stageId: 'abstract-summary' },
  );
  assert.equal(improved.valid, true);
  assert.equal(improved.candidateMetrics.authorVerdictCount, 0);
  const unchanged = chapterRevisionImprovement(
    '门后仍没有回应。\n\n这让他更恨。\n\n“你现在明白了吗？”她问。',
    source, { stageId: 'abstract-summary' },
  );
  assert.equal(unchanged.valid, false);
  const uncoveredSource = '他十分难过，整个人仿佛失去了意义。';
  const uncovered = chapterRevisionImprovement(
    '他把杯子放回桌上，水沿着杯壁淌到手背，他没有擦。',
    uncoveredSource, { stageId: 'abstract-summary' },
  );
  assert.equal(chapterRevisionStyleMetrics(uncoveredSource).authorVerdictCount, 0);
  assert.equal(uncovered.valid, true);
  const dialogue = chapterRevisionStyleMetrics('“现在他知道了吗？\n他明白了吗？”她问。');
  assert.equal(dialogue.authorVerdictCount, 0);
  const cornerQuotes = chapterRevisionStyleMetrics('「现在他知道了。」\n『她意识到了什么？』');
  assert.equal(cornerQuotes.authorVerdictCount, 0);
  const unclosedDialogue = chapterRevisionStyleMetrics('他推开门。\n“现在他知道了。');
  assert.equal(unclosedDialogue.authorVerdictCount, 0);
});

test('成片复句按三次非重叠长短语识别且返修不得增加聚类', () => {
  const source = [
    '终端提示剩余意识完整度:百分之七十。',
    '警报再次显示剩余意识完整度:百分之四十。',
    '最后一行仍是剩余意识完整度:百分之十。',
  ].join('\n\n');
  const sourceMetrics = chapterRevisionStyleMetrics(source);
  assert.ok(sourceMetrics.repeatedPhraseClusterCount > 0);
  assert.ok(sourceMetrics.repeatedPhraseExcessCount > 0);
  const improved = chapterRevisionImprovement(
    source.replace('最后一行仍是剩余意识完整度:', '最后一行只剩红色数字：'),
    source, { stageId: 'rhetoric-repetition' },
  );
  assert.equal(improved.valid, true);
  assert.ok(improved.candidateMetrics.repeatedPhraseClusterCount
    < sourceMetrics.repeatedPhraseClusterCount);
  const natural = chapterRevisionStyleMetrics('他回头看了一眼。\n\n她也回头看了一眼。');
  assert.equal(natural.repeatedPhraseClusterCount, 0);
  const patternedSingleSentence = chapterRevisionStyleMetrics(
    Array.from({ length: 300 }, (_, index) => String.fromCharCode(0x4e00 + index % 20)).join(''),
  );
  assert.equal(patternedSingleSentence.repeatedPhraseClusterCount, 0);
});

test('接近正文上限的复句聚类扫描保持有界', { timeout: 2000 }, () => {
  const source = '剩余意识完整度百分之七十。'.repeat(
    Math.ceil(MAX_VERSION_TEXT_CHARS / 13),
  ).slice(0, MAX_VERSION_TEXT_CHARS);
  const startedAt = performance.now();
  const metrics = chapterRevisionStyleMetrics(source);
  const elapsed = performance.now() - startedAt;
  assert.ok(metrics.repeatedPhraseClusterCount > 0);
  assert.ok(elapsed < 500, `复句聚类扫描耗时 ${elapsed.toFixed(1)}ms`);
});

test('重复修辞返修必须降低目标信号且不得制造其它 AI 表达回归', () => {
  const source = '他不是害怕，而是不肯认输。仿佛整座城都压在肩上。——他仍向前。';
  assert.equal(chapterRevisionImprovement(source, source, {
    stageId: 'rhetoric-repetition',
  }).valid, false);
  assert.equal(chapterRevisionImprovement(
    '他咬紧牙向前，像是背着城墙，如同踏进深海。——他仍向前。', source,
    { stageId: 'rhetoric-repetition' },
  ).valid, false);
  const improved = chapterRevisionImprovement(
    '他咬紧牙，肩头一沉，仍朝城门迈了一步。', source,
    { stageId: 'rhetoric-repetition' },
  );
  assert.equal(improved.valid, true);
  assert.equal(improved.candidateMetrics.contrastFormulaCount, 0);
});

test('修订接口只返回候选，不写入版本链，并使用完整事实保护提示词', async () => {
  const { book, section, chapter, source } = await setupChapter();
  const revised = source.replaceAll('进行了激烈的争论', '围着柜台争了起来');
  let instruction = '';
  await withServer(async ({ messages }) => {
    instruction = messages[0].content;
    return revised;
  }, async (base) => {
    const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
    const before = await store.readChapter(book.id, section.id, chapter.id);
    const response = await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/revision-candidate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        stage: 'scene-grounding', expectedBodyFingerprint: context.chapter.bodyFingerprint,
        expectedContextRevision: context.contextRevision,
      }) },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.candidate, revised);
    assert.equal(result.changed, true);
    assert.equal(result.improvement.valid, true);
    assert.match(instruction, /不能顺手执行其它五类修订/);
    assert.match(instruction, /【当前完整正文】/);
    const after = await store.readChapter(book.id, section.id, chapter.id);
    assert.deepEqual(after.body, before.body);
  });
});

test('非法阶段与不完整候选在写模型或返回页面前被稳定拒绝', async () => {
  const { book, section, chapter } = await setupChapter();
  let calls = 0;
  await withServer(async () => { calls += 1; return '太短'; }, async (base) => {
    const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
    const path = `${base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/revision-candidate`;
    const invalid = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        stage: 'all-at-once', expectedBodyFingerprint: context.chapter.bodyFingerprint,
        expectedContextRevision: context.contextRevision,
      }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0);
    const malformed = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        stage: 'low-value-paragraphs', expectedBodyFingerprint: context.chapter.bodyFingerprint,
        expectedContextRevision: context.contextRevision,
      }),
    });
    assert.equal(malformed.status, 502);
    assert.deepEqual(await malformed.json(), { error: 'CHAPTER_REVISION_CANDIDATE_FAILED' });
    assert.equal(calls, 1);
  });
});

test('精修接口拒绝混入后台债务编号的完整候选且不改原文', async () => {
  const { book, section, chapter, source } = await setupChapter();
  const leaked = source.replace(
    '空荡荡的试炼场', `promise_${'a'.repeat(32)} 标记过的试炼场`,
  );
  await withServer(async () => leaked, async (base) => {
    const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
    const response = await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/revision-candidate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        stage: 'scene-grounding', expectedBodyFingerprint: context.chapter.bodyFingerprint,
        expectedContextRevision: context.contextRevision,
      }) },
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'CHAPTER_REVISION_CANDIDATE_FAILED' });
    assert.equal(store.currentText(
      (await store.readChapter(book.id, section.id, chapter.id)).body,
    ), source);
  });
});

test('模型等待期间正文变化会丢弃迟到候选', async () => {
  const { book, section, chapter, source } = await setupChapter();
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const improved = source
    .replace('他走进空荡荡的试炼场。', '门轴刮过石地，他侧身挤进试炼场，靴底碾碎一片干泥。')
    .replace('众人进行了激烈的争论。', '掌柜把钥匙推到桌心，三个人同时伸手，又同时停住。');
  await withServer(async () => { entered(); await waiting; return improved; }, async (base) => {
    const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
    const pending = fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/revision-candidate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        stage: 'scene-grounding', expectedBodyFingerprint: context.chapter.bodyFingerprint,
        expectedContextRevision: context.contextRevision,
      }) },
    );
    await started;
    const latest = await store.readChapter(book.id, section.id, chapter.id);
    await store.versionSet(book.id, `section:${section.id}:chapter:${chapter.id}`,
      `${source}\n改稿`, { expectedRevision: store.versionRevision(latest.body) });
    release();
    const response = await pending;
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'CHAPTER_REVISION_CANDIDATE_STALE' });
  });
});
