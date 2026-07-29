import { describe, it, expect } from 'vitest';
import { findChapter, firstSelectable } from './store';
import type { BookTree } from './types';

const tree = {
  book: { outline: { content: 'o' } },
  sections: [
    { id: 'section-01', chapters: [
      { id: 'chapter-01', content: 'C1' }, { id: 'chapter-02', content: 'C2' },
    ] },
  ],
} as unknown as BookTree;

describe('store 选中辅助', () => {
  it('findChapter 命中指定章', () => {
    const ch = findChapter(tree, { kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-02' });
    expect(ch?.content).toBe('C2');
  });
  it('findChapter 非章选中返回 null', () => {
    expect(findChapter(tree, { kind: 'outline' })).toBeNull();
  });
  it('firstSelectable 有章时返回首章', () => {
    expect(firstSelectable(tree)).toEqual({ kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-01' });
  });
  it('firstSelectable 无章时返回 outline', () => {
    const empty = { book: {}, sections: [] } as unknown as BookTree;
    expect(firstSelectable(empty)).toEqual({ kind: 'outline' });
  });
});
