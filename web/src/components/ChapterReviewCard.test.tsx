import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChapterReviewCard } from './ChapterReviewCard';
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
  },
  webFictionChecks: [
    { id: 'goldenChapter', status: 'pass', detail: '第三章完成一次阶段兑现。' },
    { id: 'premisePromise', status: 'risk', detail: '差异化卖点仍不够明确。' },
    { id: 'chapterGoal', status: 'pass', detail: '目标明确。' },
    { id: 'obstacleEscalation', status: 'pass', detail: '阻碍升级。' },
    { id: 'characterChoice', status: 'pass', detail: '人物主动选择。' },
    { id: 'effectiveIncrement', status: 'pass', detail: '关系发生变化。' },
    { id: 'payoff', status: 'pass', detail: '前文铺垫兑现。' },
    { id: 'endingHook', status: 'risk', detail: '章尾依赖生硬断句。' },
    { id: 'expressionBalance', status: 'pass', detail: '表达比例自然。' },
    { id: 'repetitionRisk', status: 'na', detail: '上下文不足。' },
    { id: 'longArcProgress', status: 'risk', detail: '主线承诺已连续多章未推进。' },
    { id: 'styleConsistency', status: 'pass', detail: '叙事距离与所选文风一致。' },
    { id: 'packagingPromise', status: 'risk', detail: '简介强调的经营卖点尚未在开篇兑现。' },
    { id: 'contentRisk', status: 'pass', detail: '未见明显风险线索；仍需按平台最新规则人工确认。' },
  ],
  issues: [{ title: '节奏偏慢', detail: '中段对话过长，应压缩。' }],
  suggestions: [{ label: '压缩对话', instruction: '删减重复对话' }],
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
    expect(html).toContain('关系发生变化。');
    expect(html).toContain('章末钩子');
    expect(html).toContain('风险');
    expect(html).toContain('长线推进');
    expect(html).toContain('主线承诺已连续多章未推进。');
    expect(html).toContain('文风一致性');
    expect(html).toContain('叙事距离与所选文风一致。');
    expect(html).toContain('包装承诺一致性');
    expect(html).toContain('简介强调的经营卖点尚未在开篇兑现。');
    expect(html).toContain('内容风险线索');
    expect(html).toContain('仍需按平台最新规则人工确认。');
    expect(html).toContain('本章节奏记录');
    expect(html).toContain('功能：阶段兑现');
    expect(html).toContain('情绪：压迫后释放');
  });

  it('其它章节操作进行时禁用审稿和建议按钮', () => {
    const html = renderToStaticMarkup(
      <ChapterReviewCard review={review} stale={false} reviewing={false} disabled
        onReview={vi.fn()} onUseSuggestion={vi.fn()} />,
    );
    expect((html.match(/disabled=""/g) || []).length).toBe(2);
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
