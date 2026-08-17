import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChapterReviewCard, planComparisonRepairInstruction } from './ChapterReviewCard';
import type { ChapterReview } from '../types';

const review: ChapterReview = {
  score: 82,
  verdict: '冲突成立',
  webFictionSignals: {
    chapterFunction: '阶段兑现',
    conflictType: '身份对抗',
    emotionTone: '压迫后释放',
    payoffType: '揭示真相',
    dominantMode: '行动与对话',
    rhythmFingerprint: {
      pressurePattern: 'false-relief', resolutionMethod: 'wit', payoffScale: 'stage',
      hookMechanism: 'world-opening', costType: 'identity',
    },
  },
  webFictionChecks: [
    { id: 'goldenChapter', status: 'pass', detail: '第一章完成机制首次展示。', goldenEvidence: {
      setupQuote: '欠债人当众撕毁契约。',
      fulfillmentQuote: '她从契约灰烬里还原出幕后债主。',
    } },
    { id: 'premisePromise', status: 'pass', detail: '核心机制产生相关回报。', premiseEvidence: {
      promiseQuote: '账页浮出一条可核验的银线。',
      deliveryQuote: '她循线找出藏在仓底的失踪货物。',
    } },
    { id: 'chapterGoal', status: 'pass', detail: '目标明确。', goalEvidence: {
      goalQuote: '她必须在换岗前找到证人。', attemptQuote: '她沿血迹逐间敲开仓库门。',
    } },
    { id: 'obstacleEscalation', status: 'pass', detail: '阻碍升级。', obstacleEvidence: {
      baseQuote: '守卫扣住通行证。', escalatedQuote: '守卫随后封锁整节货厢。',
    } },
    { id: 'characterChoice', status: 'pass', detail: '人物主动选择。', choiceEvidence: {
      pressureQuote: '救证人会暴露盟友。', choiceQuote: '她把唯一的通行牌交给孩子。',
    }, costEvidence: {
      choiceQuote: '她把唯一的通行牌交给孩子。', consequenceQuote: '她从此失去离城资格。',
    } },
    { id: 'sceneExecution', status: 'pass', detail: '关键冲突在场景中完成。', sceneEvidence: {
      actionQuote: '她把账本拍在桌上。', reactionQuote: '证人看见签名后立刻后退。',
      turnQuote: '守卫因此锁住唯一出口。',
    } },
    { id: 'effectiveIncrement', status: 'pass', detail: '关系发生变化。', incrementEvidence: {
      triggerQuote: '她公开了账本证据。', stateQuote: '原本沉默的证人成为公开盟友。',
    } },
    { id: 'payoff', status: 'pass', detail: '前文铺垫兑现。', payoffEvidence: {
      actionQuote: '主角撕掉伪造通行证。', resultQuote: '失踪证人从货厢走出。',
    } },
    { id: 'endingHook', status: 'pass', detail: '章尾由既有信息自然推出。', hookEvidence: {
      setupQuote: '账本反复出现港口编号。', hookQuote: '门外的人报出了那个编号。',
    } },
    { id: 'tensionDynamics', status: 'pass', detail: '压力由行动产生变化与反制。', tensionEvidence: {
      pressureQuote: '守卫开始逐箱搜查。', shiftQuote: '她打翻油灯暂时引开守卫。',
      aftermathQuote: '烟雾触发警铃，整座站台封锁。',
    } },
    { id: 'foreshadowingExecution', status: 'pass', detail: '旧车票既误导追兵也推进旧案线。' },
    { id: 'worldExpansion', status: 'pass', detail: '城外印章以可核验物证打开一层边界。' },
    { id: 'proseHumanity', status: 'risk', detail: '连续短段和总结句呈现同构节奏。', evidence: '不是因为害怕，而是因为所有人都沉默了。' },
    { id: 'expressionBalance', status: 'pass', detail: '表达比例自然。' },
    { id: 'repetitionRisk', status: 'na', detail: '上下文不足。' },
    { id: 'longArcProgress', status: 'pass', detail: '主线形成可持续进展。', longArcEvidence: {
      threadQuote: '名单再次出现父亲的三角印记。',
      progressQuote: '她锁定下一艘入港船并约定登船核查。',
    } },
    { id: 'styleConsistency', status: 'pass', detail: '叙事距离与所选文风一致。' },
    { id: 'packagingPromise', status: 'risk', detail: '简介强调的经营卖点尚未在开篇兑现。' },
    { id: 'contentRisk', status: 'pass', detail: '未见明显风险线索；仍需按平台最新规则人工确认。' },
  ],
  issues: [{ title: '节奏偏慢', detail: '中段对话过长，应压缩。' }],
  suggestions: [{ label: '压缩对话', instruction: '删减重复对话' }],
  planComparison: {
    overall: 'partial', summary: '目标落地，但章末兑现延后。',
    items: [
      { target: 'goal', outcome: 'fulfilled', evidence: '主角已当面拿回账本。' },
      { target: 'payoff', outcome: 'missed', evidence: '账本密码仍未解开。' },
      { target: 'scene-1', outcome: 'adapted', evidence: '桥上对峙改成雨中追车，但保留了主动选择。' },
    ],
    carryovers: [{
      sourceTarget: 'payoff', text: '解开账本密码',
      reason: '本章已拿回账本但还没有产生信息兑现。', suggestedField: 'goal',
    }],
  },
  sourceCursor: 1,
  sourceFingerprint: 'fingerprint',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

describe('ChapterReviewCard', () => {
  it('直接展示问题详情，不依赖鼠标悬停', () => {
    const html = renderToStaticMarkup(
      <ChapterReviewCard review={review} stale={false} reviewing={false}
        onReview={vi.fn()} onUseSuggestion={vi.fn()} />,
    );
    expect(html).toContain('节奏偏慢');
    expect(html).toContain('中段对话过长，应压缩。');
    expect(html).toContain('网文章法检查');
    expect(html).toContain('有效增量');
    expect(html).toContain('场景化与转折');
    expect(html).toContain('关键冲突在场景中完成。');
    expect(html).toContain('场景行动：');
    expect(html).toContain('她把账本拍在桌上。');
    expect(html).toContain('即时反应：');
    expect(html).toContain('证人看见签名后立刻后退。');
    expect(html).toContain('局势转折：');
    expect(html).toContain('守卫因此锁住唯一出口。');
    expect(html).toContain('关系发生变化。');
    expect(html).toContain('<summary>查看通过证据</summary>');
    expect(html).toContain('<summary>正文证据</summary>');
    expect(html).toContain('open=""');
    expect(html).toContain('黄金章起点：');
    expect(html).toContain('欠债人当众撕毁契约。');
    expect(html).toContain('职责兑现：');
    expect(html).toContain('她从契约灰烬里还原出幕后债主。');
    expect(html).toContain('卖点运转：');
    expect(html).toContain('账页浮出一条可核验的银线。');
    expect(html).toContain('相关回报：');
    expect(html).toContain('她循线找出藏在仓底的失踪货物。');
    expect(html).toContain('当下目标：');
    expect(html).toContain('她必须在换岗前找到证人。');
    expect(html).toContain('目标尝试：');
    expect(html).toContain('她沿血迹逐间敲开仓库门。');
    expect(html).toContain('前置阻碍：');
    expect(html).toContain('守卫扣住通行证。');
    expect(html).toContain('升级局面：');
    expect(html).toContain('守卫随后封锁整节货厢。');
    expect(html).toContain('推进触发：');
    expect(html).toContain('她公开了账本证据。');
    expect(html).toContain('新增状态：');
    expect(html).toContain('原本沉默的证人成为公开盟友。');
    expect(html).toContain('取舍压力：');
    expect(html).toContain('救证人会暴露盟友。');
    expect(html).toContain('主动选择：');
    expect(html).toContain('关键选择：');
    expect(html).toContain('她把唯一的通行牌交给孩子。');
    expect(html).toContain('实际代价：');
    expect(html).toContain('她从此失去离城资格。');
    expect(html).toContain('挣得动作：');
    expect(html).toContain('主角撕掉伪造通行证。');
    expect(html).toContain('兑现结果：');
    expect(html).toContain('失踪证人从货厢走出。');
    expect(html).toContain('钩子铺垫：');
    expect(html).toContain('账本反复出现港口编号。');
    expect(html).toContain('章尾牵引：');
    expect(html).toContain('门外的人报出了那个编号。');
    expect(html).toContain('触及长线：');
    expect(html).toContain('名单再次出现父亲的三角印记。');
    expect(html).toContain('长线进展：');
    expect(html).toContain('她锁定下一艘入港船并约定登船核查。');
    expect(html).toContain('压力轨迹：假缓解后反噬');
    expect(html).toContain('破局方式：计谋判断');
    expect(html).toContain('钩子机制：世界边界打开');
    expect(html).toContain('章末钩子');
    expect(html).toContain('张力起伏');
    expect(html).toContain('压力由行动产生变化与反制。');
    expect(html).toContain('压力局面：');
    expect(html).toContain('守卫开始逐箱搜查。');
    expect(html).toContain('局势变化：');
    expect(html).toContain('她打翻油灯暂时引开守卫。');
    expect(html).toContain('反制余波：');
    expect(html).toContain('烟雾触发警铃，整座站台封锁。');
    expect(html).toContain('埋点落地');
    expect(html).toContain('世界边界展开');
    expect(html).toContain('自然人感');
    expect(html).toContain('正文证据：不是因为害怕，而是因为所有人都沉默了。');
    expect(html).toContain('风险');
    expect(html).toContain('长线推进');
    expect(html).toContain('主线形成可持续进展。');
    expect(html).toContain('文风一致性');
    expect(html).toContain('叙事距离与所选文风一致。');
    expect(html).toContain('包装承诺一致性');
    expect(html).toContain('简介强调的经营卖点尚未在开篇兑现。');
    expect(html).toContain('内容风险线索');
    expect(html).toContain('仍需按平台最新规则人工确认。');
    expect(html).toContain('本章节奏记录');
    expect(html).toContain('功能：阶段兑现');
    expect(html).toContain('情绪：压迫后释放');
    expect(html).toContain('策划—成稿差异');
    expect(html).toContain('部分落地');
    expect(html).toContain('账本密码仍未解开');
    expect(html).toContain('场景 1');
    expect(html).toContain('建议下章处理（待作者选择）');
    expect(html).toContain('解开账本密码');
    expect(html).toContain('定向修复本项');
    expect(planComparisonRepairInstruction(review.planComparison!.items[1]))
      .toContain('只定向修复策划—成稿差异中的「兑现 / 爽点」');
    expect(planComparisonRepairInstruction(review.planComparison!.items[2]))
      .toContain('保留本章其它已落地的情节');
  });

  it('其它章节操作进行时禁用审稿和建议按钮', () => {
    const html = renderToStaticMarkup(
      <ChapterReviewCard review={review} stale={false} reviewing={false} disabled
        onReview={vi.fn()} onUseSuggestion={vi.fn()} />,
    );
    expect((html.match(/disabled=""/g) || []).length).toBe(3);
  });

  it('空章节提示先写正文且不提供审稿按钮', () => {
    const html = renderToStaticMarkup(
      <ChapterReviewCard stale={false} reviewing={false} empty
        onReview={vi.fn()} onUseSuggestion={vi.fn()} />,
    );
    expect(html).toContain('章节正文为空');
    expect(html).toContain('写入正文后才能审稿');
    expect(html).not.toContain('审稿本章');
  });

  it('审稿中提供明确的停止入口', () => {
    const html = renderToStaticMarkup(
      <ChapterReviewCard stale={false} reviewing
        onReview={vi.fn()} onStopReview={vi.fn()} onUseSuggestion={vi.fn()} />,
    );
    expect(html).toContain('审稿中');
    expect(html).toContain('停止审稿');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('type="button"');
  });

  it('过期审稿同时说明可能对应旧正文或旧故事设定', () => {
    const html = renderToStaticMarkup(
      <ChapterReviewCard review={review} stale reviewing={false}
        onReview={vi.fn()} onUseSuggestion={vi.fn()} />,
    );
    expect(html).toContain('旧正文或旧故事设定');
    expect(html).toContain('重新审稿');
  });
});
