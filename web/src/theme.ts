export type Theme = 'paper' | 'blackboard';

const KEY = 'novelbox-theme';

// 纯逻辑：任意输入归一到合法主题，非 blackboard 一律 paper
export function normalizeTheme(raw: string | null): Theme {
  return raw === 'blackboard' ? 'blackboard' : 'paper';
}

// 纯逻辑：两主题互切
export function nextTheme(cur: Theme): Theme {
  return cur === 'paper' ? 'blackboard' : 'paper';
}

export function getTheme(): Theme {
  try {
    return normalizeTheme(globalThis.localStorage?.getItem(KEY) ?? null);
  } catch {
    // 隐私模式、沙箱 iframe 或浏览器策略可能让 localStorage 访问直接
    // 抛出 SecurityError；主题偏好不可用不能阻止整个应用启动。
    return 'paper';
  }
}

export function setTheme(t: Theme): void {
  try {
    globalThis.localStorage?.setItem(KEY, t);
  } catch {
    // 仍应用当前会话的主题，仅放弃持久化。
  }
  document.documentElement.setAttribute('data-theme', t);
}

export function toggleTheme(): Theme {
  const t = nextTheme(getTheme());
  setTheme(t);
  return t;
}

// 启动时把已存主题写到 <html data-theme>
export function applyStoredTheme(): void {
  document.documentElement.setAttribute('data-theme', getTheme());
}
