import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BookSection, StageSummary } from '../types';
import { StageSummaryPanel } from './StageSummaryPanel';

const sections: BookSection[] = [
  { id: 'section-1', index: 1, title: '启程', titleSource: 'manual', chapters: [] },
  { id: 'section-2', index: 2, title: '北境', titleSource: 'manual', chapters: [] },
];

const stage: StageSummary = {
  id: `stage_${'a'.repeat(32)}`,
  title: '北上阶段',
  startSectionId: 'section-1', endSectionId: 'section-2',
  startSectionIndex: 1, endSectionIndex: 2,
  summary: '林越离乡北上。', status: 'draft',
  sourceFingerprint: 'F'.repeat(43), stale: true,
  createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
};

describe('StageSummaryPanel', () => {
  it('明确展示阶段范围、冻结规则与过期状态', () => {
    const html = renderToStaticMarkup(<StageSummaryPanel
      bookId="book-1" sections={sections} items={[stage]}
      revision={'R'.repeat(43)} onReload={async () => true} />);
    expect(html).toContain('全书阶段摘要');
    expect(html).toContain('草稿过期后自动退出上下文');
    expect(html).toContain('北上阶段');
    expect(html).toContain('第 1–2 部 · 草稿 · 来源已变化');
    expect(html).toContain('+新建阶段');
  });

  it('空库提示每 3–5 个分部建立一份', () => {
    const html = renderToStaticMarkup(<StageSummaryPanel
      bookId="book-1" sections={sections} items={[]}
      revision={'R'.repeat(43)} onReload={async () => true} />);
    expect(html).toContain('每 3–5 个分部建立一份');
  });
});
