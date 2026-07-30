import { describe, it, expect } from 'vitest';
import { currentText, canPrev, canNext, versionLabel, bookSpineColor } from './versioned';

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
