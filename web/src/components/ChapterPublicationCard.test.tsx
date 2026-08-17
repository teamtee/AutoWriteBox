import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Chapter } from '../types';
import { ChapterPublicationCard } from './ChapterPublicationCard';

const chapter = (published?: Chapter['published']): Chapter => ({
  id: 'chapter-1', index: 1, title: '第一章', titleSource: 'manual',
  body: { versions: ['当前正文'], cursor: 0, revision: 'R'.repeat(43) },
  content: '当前正文', bodyFingerprint: 'C'.repeat(43),
  plan: {
    qualityProtocolVersion: 2,
    designProtocolVersion: 0,
    rhythmIntentVersion: 0,
    rhythmIntent: {
      pressurePattern: '', resolutionMethod: '', payoffScale: '', hookMechanism: '', costType: '',
    },
    goal: '', obstacle: '', choice: '', payoff: '', hook: '',
    tensionArc: '', foreshadowing: '', worldExpansion: '',
    decisionChain: '', knowledgeDesign: '', notes: '',
    scenes: [],
    revision: 'P'.repeat(43), isEmpty: true,
  },
  characters: [], summary: '', progress: '', status: 'done', published,
});

describe('ChapterPublicationCard', () => {
  it('未锁定时说明只记录真实平台发布，不自动上传', () => {
    const html = renderToStaticMarkup(
      <ChapterPublicationCard bookId="book-1" sectionId="section-1"
        chapter={chapter()} onPublish={() => {}} />,
    );
    expect(html).toContain('尚未记录已发布正文');
    expect(html).toContain('锁定当前版为已发布');
    expect(html).toContain('不会自动上传');
  });

  it('未发布修改保留可查看的已发布快照并提示记忆仍锚定旧版', () => {
    const html = renderToStaticMarkup(<ChapterPublicationCard
      bookId="book-1" sectionId="section-1"
      chapter={chapter({
        content: '读者已看到的正文', bodyFingerprint: 'P'.repeat(43),
        publishedAt: '2026-08-10T00:00:00.000Z', publicationNumber: 1, isCurrent: false,
      })}
      onPublish={() => {}} />);
    expect(html).toContain('当前是未发布修改');
    expect(html).toContain('长期记忆仍以读者看到的旧发布版为准');
    expect(html).toContain('读者已看到的正文');
    expect(html).toContain('锁定当前修改为发布新版');
  });
});
