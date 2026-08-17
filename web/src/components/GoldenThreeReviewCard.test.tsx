import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { GoldenThreeReviewState } from '../types';
import { GoldenThreeReviewCard } from './GoldenThreeReviewCard';

const ids = [
  'premisePromise', 'protagonistAttachment', 'protagonistDrive', 'coreLoop',
  'centralConflict', 'differentiation', 'firstPayoff', 'threeChapterEscalation',
  'continuationPull',
] as const;
const state: GoldenThreeReviewState = {
  ready: true, reason: null, availableChapterCount: 3, completedChapterCount: 3,
  missingChapterIndexes: [], isCurrent: true, contextRevision: 'R'.repeat(43),
  sources: [1, 2, 3].map((index) => ({
    sectionId: 'section-1', chapterId: `chapter-${index}`,
    bookChapterIndex: index as 1 | 2 | 3, title: `章${index}`,
    bodyFingerprint: 'F'.repeat(43),
  })),
  review: {
    score: 78, verdict: '机制成立，但第一次兑现偏弱。',
    checks: ids.map((id, index) => ({
      id, status: index === 6 ? 'risk' : 'pass', summary: `${id} 结论`,
      evidence: [{
        chapter: ((index % 3) + 1) as 1 | 2 | 3,
        quote: '主角主动接下破败试炼场。', analysis: '这句证明人物主动进入核心困境。',
      }],
    })),
    fixes: [{
      target: 'chapter-2', label: '强化选择', problem: '主角旁观。',
      instruction: '让主角主动选择并承担代价。',
    }],
    sourceContextRevision: 'R'.repeat(43), sources: [],
    updatedAt: '2026-08-11T00:00:00.000Z',
  },
};

describe('GoldenThreeReviewCard', () => {
  it('展示九项跨章检查、章号证据和定向章节入口', () => {
    const html = renderToStaticMarkup(<GoldenThreeReviewCard state={state}
      reviewing={false} onReview={vi.fn()} onOpenChapter={vi.fn()} />);
    expect(html).toContain('黄金三章总检');
    expect(html).toContain('人物依恋');
    expect(html).toContain('核心循环');
    expect(html).toContain('第一次有效兑现');
    expect(html).toContain('第 2 章：');
    expect(html).toContain('主角主动接下破败试炼场。');
    expect(html).toContain('这句证明人物主动进入核心困境。');
    expect(html).toContain('打开第 2 章处理');
    expect(html).toContain('让主角主动选择并承担代价');
  });

  it('未完成、过期和审稿中都有明确状态', () => {
    const incomplete = renderToStaticMarkup(<GoldenThreeReviewCard
      state={{ ...state, ready: false, reason: 'body', completedChapterCount: 1,
        missingChapterIndexes: [2, 3], review: undefined, isCurrent: false }}
      reviewing={false} onReview={vi.fn()} />);
    expect(incomplete).toContain('已完成 1/3');
    expect(incomplete).toContain('第 2 章、第 3 章');
    const stale = renderToStaticMarkup(<GoldenThreeReviewCard
      state={{ ...state, isCurrent: false }} reviewing={false} onReview={vi.fn()} />);
    expect(stale).toContain('总检已过期');
    expect(stale).toContain('重新联合审稿');
    const busy = renderToStaticMarkup(<GoldenThreeReviewCard state={state} reviewing
      onReview={vi.fn()} onStopReview={vi.fn()} />);
    expect(busy).toContain('联合审稿中');
    expect(busy).toContain('停止联合审稿');
    expect(busy).toContain('aria-busy="true"');
  });
});
