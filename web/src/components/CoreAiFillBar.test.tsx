import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CoreAiFillBar } from './CoreAiFillBar';

describe('CoreAiFillBar', () => {
  it('明确核心循环与进阶 AI 内容都会自动保存', () => {
    const html = renderToStaticMarkup(
      <CoreAiFillBar
        bookId="book-1"
        engine={{
          readerExperience: '', protagonistAction: '', progression: '', cost: '',
          escalation: '', revision: 'E'.repeat(43), isEmpty: true,
        }}
        emptyFields={[{ path: 'core:world', label: '世界观 / 世界圣经' }]}
        onEngineDraft={vi.fn()}
        onRewrite={vi.fn()} />,
    );
    expect(html).toContain('AI 填充本页创作骨架');
    expect(html).toContain('人物、关系和计划承诺也由 AI 直接保存');
    expect(html).toContain('核心循环会先进入表单并自动保存');
    expect(html).toContain('✨ AI 填充核心循环草稿');
    expect(html).toContain('✨ 世界观 / 世界圣经');
    expect(html).not.toContain('AI 填充本页创作卡');
  });
});
