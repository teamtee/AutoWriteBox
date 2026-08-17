import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BookTree } from '../types';
import { localDateKey, serializationRows, SerializationPanel } from './SerializationPanel';

const versioned = { versions: [''], cursor: 0 };

function tree(): BookTree {
  return {
    book: {
      id: 'book-1', title: '连载书', titleSource: 'manual', outline: versioned,
    settings: {
      storyEngine: {
        readerExperience: '', protagonistAction: '', progression: '', cost: '', escalation: '',
        revision: 'E'.repeat(43), isEmpty: true,
      },
      core: {
          world: versioned, style: versioned, constraints: versioned, pacing: versioned,
        },
        history: [],
        serialization: { dailyWordGoal: 4000, revision: 'R'.repeat(43) },
      },
    },
    sections: [{
      id: 'section-01', index: 1, title: '开局', titleSource: 'manual',
      chapters: [{
        id: 'chapter-01', index: 1, title: '已发章', titleSource: 'manual',
        status: 'done', hasContent: true, characterCount: 2100,
        publicationStatus: 'published', publishedAt: new Date().toISOString(),
        publicationNumber: 1, publishedCharacterCount: 2100,
      }, {
        id: 'chapter-02', index: 2, title: '待发章', titleSource: 'manual',
        status: 'done', hasContent: true, characterCount: 1800,
        publicationStatus: 'unpublished',
      }, {
        id: 'chapter-03', index: 3, title: '改稿章', titleSource: 'manual',
        status: 'done', hasContent: true, characterCount: 1900,
        publicationStatus: 'modified', publishedAt: new Date().toISOString(),
        publicationNumber: 2, publishedCharacterCount: 1700,
      }],
    }],
  };
}

describe('SerializationPanel', () => {
  it('renders persisted goal, stash states, daily progress and publication records', () => {
    const html = renderToStaticMarkup(<SerializationPanel
      tree={tree()} onSaveDailyWordGoal={vi.fn()}
      onSavePlatformConfirmation={vi.fn()} onDeletePlatformConfirmation={vi.fn()}
      onOpenChapter={vi.fn()} />);

    expect(html).toContain('连载管理');
    expect(html).toContain('value="4000"');
    expect(html).toContain('存稿章节 · 3,700 字符');
    expect(html).toContain('待发章');
    expect(html).toContain('尚未发布');
    expect(html).toContain('改稿章');
    expect(html).toContain('发布后有修改');
    expect(html).toContain('第 2 次锁定');
  });

  it('keeps global chapter indexes across sections and uses local calendar dates', () => {
    const value = tree();
    value.sections.push({
      id: 'section-02', index: 2, title: '后续', titleSource: 'manual',
      chapters: [{
        id: 'chapter-04', index: 1, title: '跨部', titleSource: 'manual',
        status: 'done', hasContent: false, characterCount: 0,
        publicationStatus: 'unpublished',
      }],
    });
    expect(serializationRows(value).map((row) => row.globalIndex)).toEqual([1, 2, 3, 4]);
    expect(localDateKey(new Date(2026, 7, 10, 23, 30))).toBe('2026-08-10');
    expect(localDateKey('not-a-date')).toBeNull();
  });
});
