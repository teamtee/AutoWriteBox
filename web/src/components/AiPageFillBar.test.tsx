import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AiPageFillBar } from './AiPageFillBar';

describe('AiPageFillBar', () => {
  it('renders a page-level AI fill action and disables it when busy', () => {
    const html = renderToStaticMarkup(
      <AiPageFillBar
        title="本页空白项"
        description="不必先手填。"
        actionLabel="✨ AI 一键填充"
        onFill={vi.fn()} />,
    );
    expect(html).toContain('本页空白项');
    expect(html).toContain('不必先手填。');
    expect(html).toContain('✨ AI 一键填充');
    const busy = renderToStaticMarkup(
      <AiPageFillBar
        title="本页空白项" description="" actionLabel="✨ AI 一键填充"
        busy onFill={vi.fn()} />,
    );
    expect(busy).toContain('AI 填充中…');
    expect(busy).toMatch(/disabled=""/);
  });
});
