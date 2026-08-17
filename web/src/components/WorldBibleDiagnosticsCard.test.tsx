import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WorldBibleDiagnosticsCard } from './WorldBibleDiagnosticsCard';

describe('WorldBibleDiagnosticsCard', () => {
  it('显示世界圣经覆盖、薄弱与 API 落盘门槛', () => {
    const html = renderToStaticMarkup(<WorldBibleDiagnosticsCard diagnostics={{
      valid: false, characters: 320, sectionCount: 2,
      missingSections: ['独特机制'], thinSections: ['一句话世界钩子'],
      issues: ['too-short', 'missing-sections', 'thin-sections'],
    }} />);
    expect(html).toContain('世界观完整度');
    expect(html).toContain('2/12 栏 · 320 字符');
    expect(html).toContain('△ 一句话世界钩子');
    expect(html).toContain('○ 独特机制');
    expect(html).toContain('少于 1800 字符、漏栏或薄栏的结果不会保存');
  });
});
