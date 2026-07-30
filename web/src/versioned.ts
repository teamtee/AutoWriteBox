import type { Versioned } from './types';

// 当前版本文本（无版本时返回空串）
export const currentText = (v: Versioned): string => v.versions[v.cursor] ?? '';
// 是否可切上一版
export const canPrev = (v: Versioned): boolean => v.cursor > 0;
// 是否可切下一版
export const canNext = (v: Versioned): boolean => v.cursor < v.versions.length - 1;
// 版本徽标文案：第 N / M 版
export const versionLabel = (v: Versioned): string => `第 ${v.cursor + 1} / ${v.versions.length} 版`;

// 按书 id 生成稳定色相，纯 CSS 书脊色（无图片请求）
export function bookSpineColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 60%)`;
}
