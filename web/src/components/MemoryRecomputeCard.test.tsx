import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRecomputeCard } from './MemoryRecomputeCard';

describe('MemoryRecomputeCard', () => {
  it('说明正文指纹、人工确认边界和显式重算范围', () => {
    const html = renderToStaticMarkup(
      <MemoryRecomputeCard
        bodyFingerprint="abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG"
        onRecompute={vi.fn()} />,
    );
    expect(html).toContain('记忆来源追踪');
    expect(html).toContain('abcdefghijkl');
    expect(html).toContain('仍需逐条确认');
    expect(html).toContain('重新提取摘要 / 人物 / 记忆');
  });

  it('重算期间禁用按钮并显示进度', () => {
    const html = renderToStaticMarkup(
      <MemoryRecomputeCard bodyFingerprint="fingerprint" recomputing
        onRecompute={vi.fn()} />,
    );
    expect(html).toContain('重新提取中');
    expect(html).toContain('disabled');
  });
});
