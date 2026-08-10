import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryCandidateCard } from './MemoryCandidateCard';
import type { MemoryCandidate } from '../types';

const candidate = (status: MemoryCandidate['status']): MemoryCandidate => ({
  id: `memory_${'a'.repeat(32)}`,
  kind: 'ability',
  subject: '林越',
  predicate: '回溯上限',
  object: '每天两次',
  evidence: '人物明确说明次数',
  importance: 5,
  details: { eventType: 'used', limitation: '每天两次', location: '北港钟楼' },
  sourceFingerprint: 'F'.repeat(43),
  extractedAt: '2026-08-10T00:00:00.000Z',
  status,
});

const renderCard = (initialCandidates: MemoryCandidate[]) => renderToStaticMarkup(
  <MemoryCandidateCard
    bookId="book-1"
    sectionId="section-1"
    chapterId="chapter-1"
    bodyFingerprint={'F'.repeat(43)}
    initialMemoryRevision={'R'.repeat(43)}
    initialCandidates={initialCandidates} />,
);

describe('MemoryCandidateCard', () => {
  it('明确说明 AI 候选需人工确认，并展示来源依据和操作', () => {
    const html = renderCard([candidate('pending')]);
    expect(html).toContain('AI 提取内容默认不是事实');
    expect(html).toContain('人物明确说明次数');
    expect(html).toContain('事件类型');
    expect(html).toContain('使用');
    expect(html).toContain('北港钟楼');
    expect(html).toContain('确认事实');
    expect(html).toContain('忽略候选');
  });

  it('已处理候选只展示状态，不允许重复决定', () => {
    const html = renderCard([candidate('accepted'), {
      ...candidate('stale'), id: `memory_${'b'.repeat(32)}`,
    }]);
    expect(html).toContain('已确认');
    expect(html).toContain('来源已失效');
    expect(html).not.toContain('确认事实');
    expect(html).not.toContain('忽略候选');
  });
});
