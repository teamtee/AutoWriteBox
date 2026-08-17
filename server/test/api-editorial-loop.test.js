import test from 'node:test';
import assert from 'node:assert/strict';

import {
  API_EDITORIAL_REVIEW_CHECK_IDS, apiEditorialDraftMetrics,
  apiEditorialCandidatePasses,
  buildApiEditorialReviewerInstruction, buildApiEditorialWriterInstruction,
  selectBestApiEditorialCandidate,
  validateApiEditorialReview,
} from '../api-editorial-loop.js';

const spec = {
  bookTitle: '长夜', chapterIndex: 21, chapterTitle: '第二扇门',
  minCharacters: 100, maxCharacters: 1_000, maxShortParagraphRatio: 0.25,
};

function review(overrides = {}) {
  return {
    score: 88, verdict: '张力成立', mustRewrite: false,
    checks: Object.fromEntries(API_EDITORIAL_REVIEW_CHECK_IDS.map((id) => [id, {
      pass: true, evidence: `${id} 有正文证据`, issue: '',
    }])),
    rewriteInstructions: [],
    ...overrides,
  };
}

test('API 正文指令分层标记事实与作者参考，并注入张力、埋点和世界边界规则', () => {
  const instruction = buildApiEditorialWriterInstruction({
    spec, brief: '主角核对四项事实',
    plan: {
      qualityProtocolVersion: 1,
      tensionArc: '受阻→希望→反制→选择', foreshadowing: '旧票根推进内鬼线',
      worldExpansion: '城外印章证明旧案跨区', scenes: [],
    },
    previousChapter: '前章正文',
    contextEntries: [{ path: '承诺账本.md', text: '待兑现：第二通道' }],
  });
  assert.match(instruction, /上下文分层：材料的性质不同/);
  assert.match(instruction, /执行章级张力曲线/);
  assert.match(instruction, /场景不能并列复位/);
  assert.match(instruction, /伏笔作为物件、动作、矛盾或一个错误判断参与当前场景/);
  assert.match(instruction, /一层能被人物触碰、验证并为之付出代价的世界信息/);
  assert.match(instruction, /作者编辑参考（用于方向与阅读债务，不得冒充已发生事实）/);
  assert.match(instruction, /紧接的前一章全文：\n前章正文/);
  assert.match(instruction, /策划卡各字段想解决的问题/);
  assert.match(instruction, /不是需要在正文里出现的标签/);
});

test('确定性门槛记录字数、短段和可审计的模型腔信号', () => {
  const draft = Array.from({ length: 12 }, (_, index) => index < 4
    ? '太迟了。'
    : `这是一段足够长的现场动作与人物反应${index}，并非结论，而是实际发生的选择。`)
    .join('\n\n');
  const metrics = apiEditorialDraftMetrics(draft, spec);
  assert.equal(metrics.deterministicGatePassed, false);
  assert.ok(metrics.shortParagraphRatio > spec.maxShortParagraphRatio);
  assert.ok(metrics.aiStyleSignals.contrastFormulaCount > 0);
  assert.match(metrics.bodyFingerprint, /^[A-Za-z0-9_-]{43}$/u);
});

test('确定性门槛拒绝写作模型把编辑后台债务锚点混入正文', () => {
  const body = `${'林越沿着旧站台向前走，脚下每一步都压响积水。'.repeat(8)}\n\n`
    + `墙角却刻着 promise_${'a'.repeat(32)}，像是有人故意留下的记号。`;
  const metrics = apiEditorialDraftMetrics(body, spec);
  assert.equal(metrics.deterministicGatePassed, false);
  assert.ok(metrics.deterministicProblems.includes('正文混入编辑后台标记'));
});

test('API 审稿十项检查必须齐全，有风险时强制提供定向返修指令', () => {
  const parsed = validateApiEditorialReview(review());
  assert.equal(parsed.mustRewrite, false);
  const failed = review();
  failed.checks.proseHumanity = {
    pass: false, evidence: '中段连续六个同构短段', issue: '节奏机械',
  };
  assert.throws(() => validateApiEditorialReview(failed), /没有定向/);
  const repairable = validateApiEditorialReview({
    ...failed, rewriteInstructions: ['保留事件结果，合并中段同构短段并恢复人物动作。'],
  });
  assert.deepEqual(repairable.failedCheckIds, ['proseHumanity']);
  assert.equal(repairable.mustRewrite, true);
  assert.throws(() => validateApiEditorialReview({
    ...review(), checks: { ...review().checks, endingPull: undefined },
  }), /endingPull/);
});

test('API 审稿提示词要求用正文证据判断张力而非事故数量', () => {
  const instruction = buildApiEditorialReviewerInstruction({
    spec, brief: '任务书', plan: { qualityProtocolVersion: 1 }, previousChapter: '前章',
    draft: '本章正文', metrics: {},
  });
  assert.match(instruction, /张力不能只看事故数量或情绪音量/);
  assert.match(instruction, /必须执行删除测试/);
  assert.match(instruction, /tensionDynamics/);
  assert.match(instruction, /foreshadowLayers/);
  assert.match(instruction, /worldScale/);
  assert.match(instruction, /proseHumanity/);
  assert.match(instruction, /具体载体.*真的有用.*改变人物行动/s);
});

test('多轮返修优先选确定性过门且审稿风险更少的 API 候选', () => {
  const candidates = [
    {
      iteration: 1,
      metrics: {
        deterministicGatePassed: true, deterministicProblems: [],
        aiStyleSignals: { contrastFormulaCount: 2 },
      },
      review: validateApiEditorialReview(review({ score: 82 })),
    },
    {
      iteration: 2,
      metrics: {
        deterministicGatePassed: false, deterministicProblems: ['正文混入 Markdown 标记'],
        aiStyleSignals: { contrastFormulaCount: 0 },
      },
      review: validateApiEditorialReview(review({ score: 99 })),
    },
  ];
  const selected = selectBestApiEditorialCandidate(candidates);
  assert.equal(selected.iteration, 1);
  assert.equal(apiEditorialCandidatePasses(selected, { minimumReviewScore: 80 }), true);

  const riskier = review({ score: 96, rewriteInstructions: ['修复章末牵引。'] });
  riskier.checks.endingPull = { pass: false, evidence: '章末停滞', issue: '无牵引' };
  const withRisk = {
    iteration: 3,
    metrics: candidates[0].metrics,
    review: validateApiEditorialReview(riskier),
  };
  assert.equal(selectBestApiEditorialCandidate([withRisk, candidates[0]]).iteration, 1);

  const forcedRewrite = {
    iteration: 4,
    metrics: candidates[0].metrics,
    review: validateApiEditorialReview(review({
      score: 100, mustRewrite: true, rewriteInstructions: ['对有证据的问题定向修改。'],
    })),
  };
  assert.equal(selectBestApiEditorialCandidate([forcedRewrite, candidates[0]]).iteration, 1);
});
