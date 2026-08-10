import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  Actions, hasWhipInstructionDraft, isSubmittedWhipDraft, shouldDisableNextChapter,
} from './Actions';

const callbacks = {
  onWhipChange: vi.fn(),
  onNext: vi.fn(),
  onWhip: vi.fn(),
  onStop: vi.fn(),
};

describe('Actions whip draft protection', () => {
  it('treats only meaningful instructions as a draft', () => {
    expect(hasWhipInstructionDraft('  ')).toBe(false);
    expect(hasWhipInstructionDraft('  加快冲突  ')).toBe(true);
  });

  it('only identifies the exact current draft as the submitted instruction', () => {
    expect(isSubmittedWhipDraft('  加快冲突  ', '加快冲突')).toBe(true);
    expect(isSubmittedWhipDraft('保留这条', '使用审稿建议')).toBe(false);
    expect(isSubmittedWhipDraft('  ', '')).toBe(false);
  });

  it('locks next chapter while a whip instruction is present', () => {
    expect(shouldDisableNextChapter(false, '调整结尾')).toBe(true);
    expect(shouldDisableNextChapter(false, '')).toBe(false);
    expect(shouldDisableNextChapter(true, '')).toBe(true);
    expect(shouldDisableNextChapter(false, '', true, false)).toBe(true);
    expect(shouldDisableNextChapter(false, '', true, true)).toBe(false);
  });

  it('keeps the controlled instruction visible and submit-ready', () => {
    const html = renderToStaticMarkup(
      <Actions {...callbacks} streaming={false} disabled={false} whip="保留这条长指令" />,
    );

    expect(html).toContain('保留这条长指令');
    expect(html).toContain('aria-label="抽打修改要求"');
    expect(html).toMatch(/disabled=""[^>]*>✍️ 生成下一章<\/button>/);
    expect(html).not.toMatch(/disabled=""[^>]*>🗯️ 抽<\/button>/);
  });

  it('distinguishes safe navigation from a model generation request', () => {
    const navigateHtml = renderToStaticMarkup(
      <Actions {...callbacks} streaming={false} disabled={false}
        hasExistingNextChapter whip="" />,
    );
    const generateHtml = renderToStaticMarkup(
      <Actions {...callbacks} streaming={false} disabled={false} whip="" />,
    );

    expect(navigateHtml).toContain('➡️ 下一章');
    expect(navigateHtml).not.toContain('生成下一章');
    expect(generateHtml).toContain('✍️ 生成下一章');
  });

  it('does not offer generation beyond an empty last chapter', () => {
    const html = renderToStaticMarkup(
      <Actions {...callbacks} streaming={false} disabled={false}
        chapterEmpty whip="补充冲突" />,
    );

    expect(html).toMatch(/disabled=""[^>]*>请先生成本章<\/button>/);
    expect(html).toMatch(/aria-label="抽打修改要求"[^>]*disabled=""/);
    expect(html).toMatch(/disabled=""[^>]*>🗯️ 抽<\/button>/);
    expect(html).not.toContain('生成下一章');
  });

  it('disables an empty whip submission', () => {
    const html = renderToStaticMarkup(
      <Actions {...callbacks} streaming={false} disabled={false} whip="  " />,
    );

    expect(html).toMatch(/disabled=""[^>]*>🗯️ 抽<\/button>/);
  });
});
