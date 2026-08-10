import { describe, it, expect } from 'vitest';
import { firstSelectable, selectionExists } from './store';
import type { BookTree } from './types';

const tree = {
  book: { outline: { content: 'o' } },
  sections: [
    { id: 'section-01', chapters: [
      { id: 'chapter-01', hasContent: true }, { id: 'chapter-02', hasContent: true },
    ] },
  ],
} as unknown as BookTree;

describe('store 选中辅助', () => {
  it('selectionExists 只接受结构中存在的章节', () => {
    expect(selectionExists(tree, { kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-02' })).toBe(true);
    expect(selectionExists(tree, { kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-99' })).toBe(false);
    expect(selectionExists(tree, { kind: 'outline' })).toBe(true);
  });
  it('firstSelectable 有章时返回首章', () => {
    expect(firstSelectable(tree)).toEqual({ kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-01' });
  });
  it('firstSelectable 无章时返回 outline', () => {
    const empty = { book: {}, sections: [] } as unknown as BookTree;
    expect(firstSelectable(empty)).toEqual({ kind: 'outline' });
  });
});
