import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ChapterContextManifest } from '../types';
import { ChapterContextManifestCard } from './ChapterContextManifestCard';

const manifest: ChapterContextManifest = {
  schemaVersion: 1, bookChapterIndex: 21, riskCount: 0, advisoryCount: 1,
  truncatedItems: ['book-outline'],
  warnings: [{
    id: 'missing-rhythm-history', severity: 'advisory',
    message: '没有最近章节节奏记录。',
  }],
  budget: {
    ceiling: 500000, fixedOverheadCharacters: 24000,
    assignableCharacters: 476000, remainingCharacters: 12000,
    layers: [{
      id: 'memory', label: '已确认长期记忆', want: 12000, characters: 8000,
      floor: 2000, priority: 600, truncated: true,
    }, {
      id: 'bookOutline', label: '全书大纲', want: 4000, characters: 4000,
      floor: 2000, priority: 380, truncated: false,
    }],
  },
  layers: [{
    id: 'facts', label: '已发生事实与连续性', items: [{
      id: 'previous-ending', label: '上一有效章结尾', status: 'included',
      characters: 1800, truncated: false, note: '只携带结尾窗口，不发送整章。',
    }, {
      id: 'confirmed-memory', label: '已确认长期记忆', status: 'included',
      characters: 11600, count: 87, truncated: true,
      note: '活动事实 120 项；本次任务直接命中 4/4 项；33 项因预算未装入。',
    }],
  }, {
    id: 'plans', label: '作者方向与当前章计划', items: [{
      id: 'book-outline', label: '全书大纲', status: 'included',
      characters: 12000, truncated: true,
    }],
  }, {
    id: 'debts', label: '阅读债务与作者导演信息', items: [{
      id: 'promise-ledger', label: '承诺—推进—兑现账本', status: 'missing',
      characters: 0, count: 0, truncated: false,
    }],
  }, {
    id: 'expression', label: '表达与去 AI 味约束', items: [{
      id: 'quality-rules', label: '通用网文章法与去 AI 味规则', status: 'included',
      characters: 8, truncated: false, note: '由系统提示词固定注入。',
    }],
  }],
};

describe('ChapterContextManifestCard', () => {
  it('展示四层覆盖、缺失、数量和裁剪，不展示材料原文', () => {
    const html = renderToStaticMarkup(<ChapterContextManifestCard manifest={manifest} />);
    expect(html).toContain('当前章节 API 上下文体检');
    expect(html).toContain('1 项建议');
    expect(html).toContain('已发生事实与连续性');
    expect(html).toContain('上一有效章结尾');
    expect(html).toContain('1800 字符');
    expect(html).toContain('已确认长期记忆');
    expect(html).toContain('87 项');
    expect(html).toContain('本次任务直接命中 4/4 项');
    expect(html).toContain('已裁剪');
    expect(html).toContain('承诺—推进—兑现账本');
    expect(html).toContain('缺失');
    expect(html).toContain('不展示正文、秘密或提示词原文');
    expect(html).toContain('单次调用预算分配');
    expect(html).toContain('固定指令预留 24000');
    expect(html).toContain('需求 12000 · 实发 8000 · 已裁剪（保底 2000）');
    expect(html).toContain('需求 4000 · 实发 4000 · 完整');
    expect(html).toContain('未发送内容仍保存在作品中');
    expect(html).not.toContain('built-in');
  });

  it('没有体量数据时不渲染雷达', () => {
    const html = renderToStaticMarkup(<ChapterContextManifestCard manifest={manifest} />);
    expect(html).not.toContain('正文体量与质感雷达');
  });

  it('展示当前章与参考值的对照和跨章趋势表', () => {
    const html = renderToStaticMarkup(<ChapterContextManifestCard manifest={{
      ...manifest,
      prose: {
        current: {
          chars: 1386, paragraphs: 78, avgParagraphChars: 18, dialogueRatio: 44,
          sensoryHits: 4, sensoryDensity: 2.9, longestNarrationChars: 151,
        },
        reference: [{
          id: 'body-length', label: '正文体量', unit: '字符',
          reference: 3000, actual: 1386, belowReference: true,
        }, {
          id: 'slow-passage', label: '最长连续叙述块', unit: '字符',
          reference: 250, actual: 303, belowReference: false,
        }],
        trend: {
          measuredCount: 2,
          rows: [{
            bookChapterIndex: 19, chars: 2247, avgParagraphChars: 16,
            dialogueRatio: 45, sensoryDensity: 13.4, longestNarrationChars: 180,
          }, {
            bookChapterIndex: 20, chars: 2629, avgParagraphChars: 18,
            dialogueRatio: 21, sensoryDensity: 3, longestNarrationChars: 503,
          }],
          risks: [],
        },
      },
    }} />);
    expect(html).toContain('正文体量与质感雷达');
    expect(html).toContain('1386 / 参考 3000 字符');
    expect(html).toContain('303 / 参考 250 字符');
    expect(html).toContain('13.4');
    expect(html).toContain('503');
  });
});
