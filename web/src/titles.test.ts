import { describe, expect, it } from 'vitest';
import { formatIndexedTitle, toChineseNumber } from './titles';

describe('toChineseNumber', () => {
  it.each([
    [1, '一'], [10, '十'], [11, '十一'], [20, '二十'],
    [99, '九十九'], [101, '一百零一'], [110, '一百一十'], [999, '九百九十九'],
  ])('%d → %s', (n, expected) => {
    expect(toChineseNumber(n)).toBe(expected);
  });
});

describe('formatIndexedTitle', () => {
  it('有纯标题时组合中文序号', () => {
    expect(formatIndexedTitle(1, '章', '夜雨来客')).toBe('第一章 · 夜雨来客');
    expect(formatIndexedTitle(12, '部', '暗潮初现')).toBe('第十二部 · 暗潮初现');
  });
  it('无纯标题时只显示序号', () => {
    expect(formatIndexedTitle(2, '章', '')).toBe('第二章');
    expect(formatIndexedTitle(3, '部')).toBe('第三部');
  });
});
