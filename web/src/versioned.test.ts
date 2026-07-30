import { describe, it, expect } from 'vitest';
import { currentText, canPrev, canNext, versionLabel, bookSpineColor, normalizeVersioned } from './versioned';

describe('versioned 纯函数', () => {
  const v = { versions: ['a', 'b', 'c'], cursor: 1 };
  it('currentText 取当前版', () => expect(currentText(v)).toBe('b'));
  it('canPrev/canNext 边界', () => {
    expect(canPrev(v)).toBe(true); expect(canNext(v)).toBe(true);
    expect(canPrev({ versions: ['x'], cursor: 0 })).toBe(false);
    expect(canNext({ versions: ['x'], cursor: 0 })).toBe(false);
  });
  it('versionLabel', () => expect(versionLabel(v)).toBe('第 2 / 3 版'));
  it('bookSpineColor 稳定且合法 hsl', () => {
    expect(bookSpineColor('book_1')).toBe(bookSpineColor('book_1'));
    expect(bookSpineColor('book_1')).toMatch(/^hsl\(\d{1,3}, \d+%, \d+%\)$/);
  });
});

// 容错：即便后端返回老结构 / 空 / 畸形（如误连旧进程），也不得抛错白屏
describe('normalizeVersioned 容错', () => {
  it('新结构原样（并夹紧越界 cursor）', () => {
    expect(normalizeVersioned({ versions: ['a', 'b'], cursor: 1 })).toEqual({ versions: ['a', 'b'], cursor: 1 });
    expect(normalizeVersioned({ versions: ['a'], cursor: 9 })).toEqual({ versions: ['a'], cursor: 0 });
  });
  it('老 {content,history} 结构 → 合并', () => {
    expect(normalizeVersioned({ content: '今', history: ['旧'] })).toEqual({ versions: ['旧', '今'], cursor: 1 });
  });
  it('字符串 → 单版', () => {
    expect(normalizeVersioned('世界观')).toEqual({ versions: ['世界观'], cursor: 0 });
  });
  it('空 / undefined / 畸形 → 安全空版本', () => {
    expect(normalizeVersioned(undefined)).toEqual({ versions: [''], cursor: 0 });
    expect(normalizeVersioned(null)).toEqual({ versions: [''], cursor: 0 });
    expect(normalizeVersioned({})).toEqual({ versions: [''], cursor: 0 });
  });
  it('老结构下 currentText 不抛错', () => {
    // 关键回归：旧进程返回 {content,history}，currentText 必须能取出当前版而非崩溃
    expect(currentText({ content: '当前', history: [] } as unknown as { versions: string[]; cursor: number })).toBe('当前');
  });
});
