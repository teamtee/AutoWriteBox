import type { Versioned } from './types';

// 容错归一：兼容 {versions,cursor} / 老结构 {content,history} / 字符串 / 空。
// 保证即便后端返回异常/老结构（如误连了旧进程），UI 也不会因读 undefined.versions 而白屏。
export function normalizeVersioned(v: unknown): Versioned {
  if (v && typeof v === 'object' && Array.isArray((v as Versioned).versions)) {
    const vv = v as Versioned;
    const versions = vv.versions.length ? vv.versions : [''];
    const cursor = Math.min(Math.max(vv.cursor ?? 0, 0), versions.length - 1);
    return { versions, cursor };
  }
  if (typeof v === 'string') return { versions: [v], cursor: 0 };
  if (v && typeof v === 'object') {
    const o = v as { content?: unknown; history?: unknown };
    if (typeof o.content === 'string' || Array.isArray(o.history)) {
      const history = Array.isArray(o.history) ? (o.history as string[]) : [];
      const versions = [...history, typeof o.content === 'string' ? o.content : ''];
      return { versions, cursor: versions.length - 1 };
    }
  }
  return { versions: [''], cursor: 0 };
}

// 当前版本文本（无版本时返回空串）
export const currentText = (v: Versioned): string => {
  const n = normalizeVersioned(v);
  return n.versions[n.cursor] ?? '';
};
// 是否可切上一版
export const canPrev = (v: Versioned): boolean => normalizeVersioned(v).cursor > 0;
// 是否可切下一版
export const canNext = (v: Versioned): boolean => {
  const n = normalizeVersioned(v);
  return n.cursor < n.versions.length - 1;
};
// 版本徽标文案：第 N / M 版
export const versionLabel = (v: Versioned): string => {
  const n = normalizeVersioned(v);
  return `第 ${n.cursor + 1} / ${n.versions.length} 版`;
};

// 按书 id 生成稳定色相，纯 CSS 书脊色（无图片请求）
export function bookSpineColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 60%)`;
}
