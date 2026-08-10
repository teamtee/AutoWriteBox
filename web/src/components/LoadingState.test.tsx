import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoadingState } from './LoadingState';

describe('LoadingState accessibility', () => {
  it('announces a named busy state while hiding decorative skeleton lines', () => {
    const html = renderToStaticMarkup(<LoadingState label="正在加载章节" />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="正在加载章节"');
    expect((html.match(/aria-hidden="true"/g) || []).length).toBe(3);
  });

  it('supports compact loading placeholders', () => {
    const html = renderToStaticMarkup(<LoadingState label="正在加载作品" lines={1} />);

    expect((html.match(/class="sk-line"/g) || []).length).toBe(1);
    expect(html).not.toContain('sk-line short');
  });
});
