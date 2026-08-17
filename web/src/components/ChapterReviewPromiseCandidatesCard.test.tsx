import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChapterReviewPromiseCandidatesCard } from './ChapterReviewPromiseCandidatesCard';

describe('ChapterReviewPromiseCandidatesCard', () => {
  it('展示账本含义与正文证据，并明确需要作者确认', () => {
    const html = renderToStaticMarkup(<ChapterReviewPromiseCandidatesCard
      bookId="book" sectionId="section" chapterId="chapter"
      bodyFingerprint={'B'.repeat(43)} reviewRevision={'R'.repeat(43)}
      initialPromiseLedgerRevision={'L'.repeat(43)}
      candidates={[{
        entryId: `promise_${'a'.repeat(32)}`, action: 'advance',
        promise: '车票来自城外', summary: '蓝印证明车票离开过封锁区。',
        evidence: '车票背面多出一道蓝色检票印。',
        beat: 'reinterpret', readerBefore: '车票只在城内使用',
        readerAfter: '车票被城外线路重新检过',
        actionConsequence: '主角改查出城货车', worldLink: 'deepen-current',
        worldEffect: '深化当前层的跨区运输接口',
      }]} />);
    expect(html).toContain('API 只提供正文证据');
    expect(html).toContain('车票来自城外');
    expect(html).toContain('正文证据：车票背面多出一道蓝色检票印。');
    expect(html).toContain('变义');
    expect(html).toContain('车票只在城内使用');
    expect(html).toContain('确认记录推进');
  });
});
