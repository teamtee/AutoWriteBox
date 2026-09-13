import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Chapter } from '../types';
import { ChapterContinuityCard, chapterContinuityHasContent } from './ChapterContinuityCard';

const emptyChapter = {
  id: 'chapter-1', index: 1, title: '', titleSource: 'default',
  body: { versions: [''], cursor: 0 }, content: '', bodyFingerprint: 'B'.repeat(43),
  plan: {
    qualityProtocolVersion: 0, designProtocolVersion: 0, rhythmIntentVersion: 0,
    rhythmIntent: {
      pressurePattern: '', resolutionMethod: '', payoffScale: '', hookMechanism: '', costType: '',
    },
    goal: '', obstacle: '', choice: '', payoff: '', hook: '', tensionArc: '',
    foreshadowing: '', worldExpansion: '', decisionChain: '', knowledgeDesign: '',
    notes: '', scenes: [], revision: 'R'.repeat(43), isEmpty: true,
  },
  characters: [], summary: '', progress: '', status: 'done',
} as Chapter;

describe('ChapterContinuityCard', () => {
  it('empty chapters still expose title, summary, characters and handoff slots', () => {
    expect(chapterContinuityHasContent(emptyChapter)).toBe(false);
    const html = renderToStaticMarkup(<ChapterContinuityCard chapter={emptyChapter} />);
    expect(html).toContain('本章摘要与交接');
    expect(html).toContain('尚未命名');
    expect(html).toContain('本章人物快照');
    expect(html).toContain('章末交接快照');
    expect(html).toContain('默认章名');
  });

  it('renders digest fields when the chapter has extracted continuity', () => {
    const chapter = {
      ...emptyChapter,
      title: '夜雨来客', titleSource: 'ai' as const,
      summary: '旧友在桥上拦路。', progress: '下一步要找撕走的账页。',
      characters: [{ name: '沈砚', role: '主角', desc: '身份即将暴露' }],
      handoff: {
        viewpoint: '沈砚', time: '雨夜', location: '城门桥',
        ongoingAction: '过桥', immediatePressure: '旧友拔刀',
        characterState: '沈砚衣湿但未受伤', resourceState: '账册在怀',
        knowledgeBoundary: '不知内鬼是谁', unresolvedCausality: '撕页去向不明',
      },
    };
    expect(chapterContinuityHasContent(chapter)).toBe(true);
    const html = renderToStaticMarkup(<ChapterContinuityCard chapter={chapter} />);
    expect(html).toContain('夜雨来客');
    expect(html).toContain('由正文摘要生成');
    expect(html).toContain('旧友在桥上拦路。');
    expect(html).toContain('沈砚');
    expect(html).toContain('撕页去向不明');
  });
});
