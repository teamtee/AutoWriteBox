import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WritingAssetBookBinding } from '../types';
import {
  ChapterAssetSceneSelector, updateChapterSceneBinding,
} from './ChapterAssetSceneSelector';

const binding = (): WritingAssetBookBinding => ({
  nativeAssetId: null,
  primaryAssetId: 'asset_primary',
  auxiliaryAssetIds: ['asset_aux'],
  sceneAssetIds: { battle: 'asset_battle' },
  chapterScenes: { 'chapter-1': 'battle', 'chapter-2': 'dialogue' },
});

describe('ChapterAssetSceneSelector', () => {
  it('updates or removes only the selected chapter scene without mutating the source binding', () => {
    const source = binding();
    const changed = updateChapterSceneBinding(source, 'chapter-1', 'mystery');
    const removed = updateChapterSceneBinding(source, 'chapter-1', '');

    expect(changed).toEqual({
      ...source,
      chapterScenes: { 'chapter-1': 'mystery', 'chapter-2': 'dialogue' },
    });
    expect(removed).toEqual({
      ...source,
      chapterScenes: { 'chapter-2': 'dialogue' },
    });
    expect(source.chapterScenes).toEqual({
      'chapter-1': 'battle', 'chapter-2': 'dialogue',
    });
  });

  it('renders an explicit loading state before the chapter-scoped library request completes', () => {
    const html = renderToStaticMarkup(<ChapterAssetSceneSelector
      bookId="book-1"
      sectionId="section-1"
      chapterId="chapter-1"
      chapterIndex={1}
      chapterTitle="开端"
      hasPublishedVersion={false}
    />);

    expect(html).toContain('正在读取本章场景文风');
  });
});
