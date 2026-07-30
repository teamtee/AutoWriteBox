import { describe, it, expect } from 'vitest';
import { parseSectionTitles } from './sections';

describe('parseSectionTitles', () => {
  it('解析「第 N 部 · 标题」', () => {
    const t = '第 1 部 · 迷雾初现\n第 2 部 · 真相追踪';
    expect(parseSectionTitles(t)).toEqual(['迷雾初现', '真相追踪']);
  });
  it('兼容「第N部：标题」「第N部 标题」多种分隔', () => {
    const t = '第1部：开端\n第2部 发展\n第3部-高潮';
    expect(parseSectionTitles(t)).toEqual(['开端', '发展', '高潮']);
  });
  it('忽略无法匹配的行与空行', () => {
    const t = '下面是我的规划：\n\n第1部 序章\n随便一句话\n';
    expect(parseSectionTitles(t)).toEqual(['序章']);
  });
  it('标题缺失时用「第 N 部」兜底', () => {
    expect(parseSectionTitles('第1部\n第2部')).toEqual(['第 1 部', '第 2 部']);
  });
  it('全无匹配返回空数组', () => {
    expect(parseSectionTitles('毫无结构的一段话')).toEqual([]);
  });
});
