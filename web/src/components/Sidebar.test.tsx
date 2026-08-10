import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BookTree } from '../types';
import { Sidebar } from './Sidebar';

const tree: BookTree = {
  book: {
    id: 'book-1',
    title: '键盘测试',
    titleSource: 'manual',
    outline: { versions: [''], cursor: 0 },
    settings: {
      core: {
        world: { versions: [''], cursor: 0 },
        style: { versions: [''], cursor: 0 },
        constraints: { versions: [''], cursor: 0 },
        pacing: { versions: [''], cursor: 0 },
      },
      history: [],
    },
  },
  sections: [{
    id: 'section-01', index: 1, title: '起始部', titleSource: 'manual',
    chapters: [{
      id: 'chapter-01', index: 1, title: '开场', titleSource: 'manual',
      status: 'done', hasContent: true,
    }],
  }],
};

const callbacks = {
  onSelect: vi.fn(),
  onAddSection: vi.fn(),
  onAddChapter: vi.fn(),
  onPlanSections: vi.fn(),
};

describe('Sidebar keyboard navigation semantics', () => {
  it('renders outline, core and chapter navigation as real buttons', () => {
    const html = renderToStaticMarkup(
      <Sidebar tree={tree} selection={{ kind: 'outline' }} disabled={false} {...callbacks} />,
    );

    expect(html).toContain('<button type="button" class="side-tab active " aria-current="page">📜 全书大纲</button>');
    expect(html).toContain('<button type="button" class="side-tab  ">🧭 核心设定</button>');
    expect(html).toContain('<button type="button" class="side-tab  ">📅 连载管理</button>');
    expect(html).toMatch(/<button type="button" class="nav-item\s+\s+chapter"[^>]*><span>第一章 · 开场<\/span>/);
  });

  it('uses native disabled state for every navigation target while locked', () => {
    const html = renderToStaticMarkup(
      <Sidebar tree={tree} selection={{
        kind: 'chapter', sectionId: 'section-01', chapterId: 'chapter-01',
      }} disabled {...callbacks} />,
    );

    expect(html).toMatch(/<button type="button" class="side-tab [^"]*disabled" disabled="">📜 全书大纲<\/button>/);
    expect(html).toMatch(/<button type="button" class="nav-item active disabled chapter" disabled="" aria-current="page">/);
  });
});
