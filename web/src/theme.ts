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
  return normalizeTheme(localStorage.getItem(KEY));
}

export function setTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
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
