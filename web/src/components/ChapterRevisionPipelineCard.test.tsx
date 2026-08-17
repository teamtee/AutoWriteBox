import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChapterRevisionCandidateResult } from '../types';
import {
  chapterRevisionCandidatePreview, ChapterRevisionCandidate,
  ChapterRevisionPipelineCard, revisionCandidateIsCurrent,
} from './ChapterRevisionPipelineCard';

const candidate: ChapterRevisionCandidateResult = {
  stage: 'character-voice', candidate: '张三压低声音：“这事不能让她知道。”', changed: true,
  sourceBodyFingerprint: 'B'.repeat(43), sourceContextRevision: 'C'.repeat(43),
};

describe('ChapterRevisionPipelineCard', () => {
  it('明确展示六个单项阶段且不承诺自动保存', () => {
    const html = renderToStaticMarkup(<ChapterRevisionPipelineCard
      bodyFingerprint={'B'.repeat(43)} contextRevision={'C'.repeat(43)}
      currentText="当前正文" onGenerate={vi.fn()} onAdopt={vi.fn()} />);
    for (const label of ['概述化', '抽象总结', '模板修辞', '人物同声', '节奏同强度', '无效段落']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('一次只处理一类问题');
    expect(html).toContain('不会自动覆盖');
    expect((html.match(/role="radio"/g) || []).length).toBe(6);
  });

  it('候选卡提示完整核对并只允许采用为未保存草稿', () => {
    const html = renderToStaticMarkup(<ChapterRevisionCandidate label="人物同声"
      candidate={candidate} currentLength={100} onAdopt={vi.fn()} onDiscard={vi.fn()} />);
    expect(html).toContain('人物同声候选');
    expect(html).toContain('原文 100 字符');
    expect(html).toContain('采用为未保存正文草稿');
    expect(html).toContain('仍需手动保存');
    expect(html).not.toContain('直接保存');
  });

  it('正文或上下文变化会让候选失效，预览长度保持有界', () => {
    expect(revisionCandidateIsCurrent(candidate, 'B'.repeat(43), 'C'.repeat(43))).toBe(true);
    expect(revisionCandidateIsCurrent(candidate, 'D'.repeat(43), 'C'.repeat(43))).toBe(false);
    const preview = chapterRevisionCandidatePreview('甲'.repeat(5_000));
    expect(preview.length).toBeLessThan(2_000);
    expect(preview).toContain('中间内容在采用后于正文编辑器完整核对');
  });
});
