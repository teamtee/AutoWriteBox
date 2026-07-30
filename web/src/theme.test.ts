import { describe, it, expect } from 'vitest';
import { normalizeTheme, nextTheme } from './theme';

describe('theme 纯逻辑', () => {
  it('normalizeTheme 识别 blackboard', () => {
    expect(normalizeTheme('blackboard')).toBe('blackboard');
  });
  it('normalizeTheme 其它值一律回退 paper', () => {
    expect(normalizeTheme('paper')).toBe('paper');
    expect(normalizeTheme(null)).toBe('paper');
    expect(normalizeTheme('乱七八糟')).toBe('paper');
  });
  it('nextTheme 在两主题间切换', () => {
    expect(nextTheme('paper')).toBe('blackboard');
    expect(nextTheme('blackboard')).toBe('paper');
  });
});
