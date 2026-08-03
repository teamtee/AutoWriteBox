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
  it('解析中文数字「第X部 · 标题」', () => {
    const t = '第一部 · 深渊低语\n第二部 · 暗潮初现\n第十三部 · 意识风暴';
    expect(parseSectionTitles(t)).toEqual(['深渊低语', '暗潮初现', '意识风暴']);
  });
  it('中文数字无标题时兜底', () => {
    expect(parseSectionTitles('第一部\n第二部')).toEqual(['第一部', '第二部']);
  });
  it('只采纳冒号前的纯标题，丢弃剧情走向', () => {
    const t = '第一部 · 深渊低语：林深在雨城获得第一条线索\n第 2 部 · 意识风暴：深渊网络全面失控';
    expect(parseSectionTitles(t)).toEqual(['深渊低语', '意识风暴']);
  });
  it('解析 Markdown 标题格式的 AI 分部规划', () => {
    const t = [
      '# 《小奴的冒险》全书分部规划',
      '',
      '## 第一部 · 蝼蚁：从泥泞中抬头',
      '**章节跨度**：第1-8章',
      '**本部走向**：故事从奴隶营的泥泞中起步。',
      '',
      '## 第二部 · 异火：烫伤掌心的秘密',
      '',
      '### 第三部 · 燎原：天下初见我的名字',
    ].join('\n');

    expect(parseSectionTitles(t)).toEqual(['蝼蚁', '异火', '燎原']);
  });
});
