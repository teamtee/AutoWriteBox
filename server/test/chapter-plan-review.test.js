import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chapterPlanReviewTargets, incomingChapterPlanCarryover,
  normalizeChapterPlanComparison,
} from '../chapter-plan-review-schema.js';
import { chapterPlanRevision, normalizeChapterPlan } from '../chapter-plan-schema.js';

const plan = normalizeChapterPlan({
  goal: '迫使证人开口', payoff: '证人交出账本',
  scenes: [{
    title: '废仓对质', desire: '主角要拿到账本', obstacle: '证人拒绝相信他',
    action: '主角当面烧掉一份假证', turn: '证人愿意开口', cost: '主角暴露调查路线',
  }],
});

const comparison = {
  overall: 'partial',
  summary: '证人已开口，但账本被另一人抢走。',
  items: [
    { target: 'goal', outcome: 'fulfilled', evidence: '证人在废仓说出了线索。' },
    { target: 'payoff', outcome: 'missed', evidence: '账本在交接前被蒙面人抢走。' },
    { target: 'scene-1', outcome: 'adapted', evidence: '对质改成了废仓追击，但仍由主角主动烧假证促成。' },
  ],
  carryovers: [{
    sourceTarget: 'payoff', text: '追回被抢走的账本',
    reason: '这是本章已建立但未兑现的行动结果。', suggestedField: 'goal',
  }],
};

test('策划差异目标只包含已填写的章级项和场景', () => {
  assert.deepEqual(chapterPlanReviewTargets(plan).map((item) => item.target), [
    'goal', 'payoff', 'scene-1',
  ]);
});

test('张力曲线、分层埋点和世界扩张都是可逐项审查与带入的策划目标', () => {
  const plan = {
    tensionArc: '封锁施压→短暂放行→旧友反制→公开身份换来突破',
    foreshadowing: '旧车票既误导追兵，也推进内鬼线',
    worldExpansion: '城外印章证明旧案跨区，暂不揭示组织结构',
  };
  assert.deepEqual(chapterPlanReviewTargets(plan).map((item) => item.target), [
    'tensionArc', 'foreshadowing', 'worldExpansion',
  ]);
  const normalized = normalizeChapterPlanComparison({
    overall: 'partial', summary: '张力已落地，世界边界尚未通过正文证据展开。',
    items: [
      { target: 'tensionArc', outcome: 'fulfilled', evidence: '旧友核验打破短暂放行。' },
      { target: 'foreshadowing', outcome: 'fulfilled', evidence: '车票被用于误导追兵。' },
      { target: 'worldExpansion', outcome: 'missed', evidence: '正文没有出现城外印章。' },
    ],
    carryovers: [{
      sourceTarget: 'worldExpansion', text: '让印章实际改变人物判断',
      reason: '不能靠策划卡声称世界已经展开。', suggestedField: 'worldExpansion',
    }],
  }, { chapterPlan: plan });
  assert.equal(normalized.carryovers[0].suggestedField, 'worldExpansion');
});

test('启用的写前节奏意图成为独立成稿核对目标', () => {
  const rhythmPlan = {
    rhythmIntentVersion: 1,
    rhythmIntent: {
      pressurePattern: 'false-relief', resolutionMethod: 'wit', payoffScale: 'chapter',
      hookMechanism: 'new-information', costType: 'identity',
    },
  };
  assert.deepEqual(chapterPlanReviewTargets(rhythmPlan), [{
    target: 'rhythmIntent', label: '写前节奏意图',
    planned: JSON.stringify(rhythmPlan.rhythmIntent),
  }]);
});

test('策划差异必须逐项覆盖，带入项不能声称已兑现', () => {
  assert.deepEqual(normalizeChapterPlanComparison(comparison, {
    chapterPlan: plan, requireForPlanned: true,
  }), comparison);
  assert.equal(normalizeChapterPlanComparison({
    ...comparison, items: comparison.items.slice(1),
  }, { chapterPlan: plan }), null);
  assert.equal(normalizeChapterPlanComparison({
    ...comparison,
    carryovers: [{ ...comparison.carryovers[0], sourceTarget: 'goal' }],
  }, { chapterPlan: plan }), null);
  assert.equal(normalizeChapterPlanComparison(undefined, {
    chapterPlan: plan, requireForPlanned: true,
  }), null);
});

test('下章只投影同时锚定当前正文和当前策划的未决项', () => {
  const chapter = {
    id: 'chapter_1', title: '废仓对质', bodyFingerprint: 'body-current', plan,
    review: {
      sourceFingerprint: 'body-current',
      sourcePlanRevision: chapterPlanRevision(plan),
      planComparison: comparison,
    },
  };
  const incoming = incomingChapterPlanCarryover(chapter);
  assert.equal(incoming.items[0].text, '追回被抢走的账本');
  assert.equal(incoming.sourceChapterTitle, '废仓对质');
  assert.equal(incomingChapterPlanCarryover({
    ...chapter, bodyFingerprint: 'body-new',
  }), null);
  assert.equal(incomingChapterPlanCarryover({
    ...chapter, plan: { ...plan, goal: '新目标' },
  }), null);
});
