import { afterEach, describe, it, expect, vi } from 'vitest';
import { getTheme, normalizeTheme, nextTheme, setTheme } from './theme';

afterEach(() => vi.unstubAllGlobals());

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

  it('浏览器拒绝读取站点存储时回退到白纸主题', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('denied', 'SecurityError'); },
    });
    expect(getTheme()).toBe('paper');
  });

  it('浏览器拒绝写入站点存储时仍应用当前会话主题', () => {
    const setAttribute = vi.fn();
    vi.stubGlobal('localStorage', {
      setItem: () => { throw new DOMException('denied', 'SecurityError'); },
    });
    vi.stubGlobal('document', { documentElement: { setAttribute } });

    expect(() => setTheme('blackboard')).not.toThrow();
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'blackboard');
  });
});
