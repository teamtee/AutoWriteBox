import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChapterReviewWorldGateCard } from './ChapterReviewWorldGateCard';

describe('ChapterReviewWorldGateCard', () => {
  it('展示相邻层级、门槛和正文证据，并明确由作者确认', () => {
    const html = renderToStaticMarkup(<ChapterReviewWorldGateCard
      bookId="book" sectionId="section" chapterId="chapter"
      bodyFingerprint={'B'.repeat(43)} reviewRevision={'R'.repeat(43)}
      initialWorldProgressRevision={'W'.repeat(43)}
      candidate={{
        fromLayer: '当前生活圈', toLayer: '中期势力与地域',
        gateCondition: '取得一份可跨区核验的名单',
        summary: '两地记录证明名单真实有效。',
        evidence: '两份盖章记录的编号完全一致。',
      }} />);
    expect(html).toContain('世界层级解锁候选');
    expect(html).toContain('当前生活圈');
    expect(html).toContain('中期势力与地域');
    expect(html).toContain('正文证据：两份盖章记录的编号完全一致。');
    expect(html).toContain('确认进入下一层');
  });
});
