import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StyleBibleDiagnosticsCard } from './StyleBibleDiagnosticsCard';

describe('StyleBibleDiagnosticsCard', () => {
  it('显示文风圣经覆盖、薄弱与 API 落盘门槛', () => {
    const html = renderToStaticMarkup(<StyleBibleDiagnosticsCard diagnostics={{
      valid: false, characters: 280, sectionCount: 2,
      missingSections: ['对话、潜台词与人物声音'], thinSections: ['叙事视角与距离'],
      issues: ['too-short', 'missing-sections', 'thin-sections'],
    }} />);
    expect(html).toContain('文风圣经完整度');
    expect(html).toContain('2/10 栏 · 280 字符');
    expect(html).toContain('△ 叙事视角与距离');
    expect(html).toContain('○ 对话、潜台词与人物声音');
    expect(html).toContain('少于 1000 字符、漏栏或空栏的结果不会保存');
  });
});
