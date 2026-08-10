import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BookModelBindingPanel } from './BookModelBindingPanel';

describe('BookModelBindingPanel', () => {
  it('明确单书固定模型的优先级、无回退与备份边界', () => {
    const html = renderToStaticMarkup(
      <BookModelBindingPanel bookId="book-one" />,
    );
    expect(html).toContain('本书固定模型');
    expect(html).toContain('优先于全局分工');
    expect(html).toContain('失败时不会自动回退');
    expect(html).toContain('单书导出不携带 API Key');
    expect(html).toContain('正在读取模型方案');
  });
});
