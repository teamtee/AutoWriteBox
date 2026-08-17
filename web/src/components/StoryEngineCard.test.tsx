import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StoryEngine } from '../types';
import {
  StoryEngineCard, storyEngineDraftIsDirty, storyEngineInput,
} from './StoryEngineCard';

const engine: StoryEngine = {
  readerExperience: '看文明在绝境中进化',
  protagonistAction: '推演并选择是否干预',
  progression: '获得新的干预权限',
  cost: '现实产生对应代价',
  escalation: '从聚落升级到多文明战争',
  revision: 'E'.repeat(43),
  isEmpty: false,
};

describe('StoryEngineCard', () => {
  it('展示五项可持续阅读循环和保存状态', () => {
    const html = renderToStaticMarkup(
      <StoryEngineCard bookId="book-1" engine={engine} onRefresh={async () => {}} />,
    );
    expect(html).toContain('作品核心循环');
    expect(html).toContain('读者反复期待什么');
    expect(html).toContain('主角反复做什么');
    expect(html).toContain('每轮获得什么进展');
    expect(html).toContain('每轮付出什么代价');
    expect(html).toContain('循环如何持续升级');
    expect(html).toContain('看文明在绝境中进化');
    expect(html).toContain('已保存');
  });

  it('只把相对服务器循环的实际变化标为草稿', () => {
    expect(storyEngineDraftIsDirty(storyEngineInput(engine), engine)).toBe(false);
    expect(storyEngineDraftIsDirty({
      ...storyEngineInput(engine), cost: ' 新的现实代价 ',
    }, engine)).toBe(true);
    expect(storyEngineDraftIsDirty({
      ...storyEngineInput(engine), cost: ` ${engine.cost} `,
    }, engine)).toBe(false);
  });

  it('其它创作操作期间禁用全部字段和保存', () => {
    const html = renderToStaticMarkup(
      <StoryEngineCard bookId="book-1" engine={engine} disabled
        onRefresh={async () => {}} />,
    );
    expect((html.match(/disabled=""/g) || []).length).toBe(6);
  });
});
