import { describe, it, expect } from 'vitest';
import { toastReducer } from './components/Toast';
import type { ToastItem } from './components/Toast';

const a: ToastItem = { id: 1, type: 'success', msg: 'A' };
const b: ToastItem = { id: 2, type: 'error', msg: 'B' };

describe('toastReducer', () => {
  it('add 追加到末尾', () => {
    expect(toastReducer([a], { kind: 'add', toast: b })).toEqual([a, b]);
  });
  it('remove 按 id 删除', () => {
    expect(toastReducer([a, b], { kind: 'remove', id: 1 })).toEqual([b]);
  });
  it('remove 不存在的 id 原样返回', () => {
    expect(toastReducer([a], { kind: 'remove', id: 99 })).toEqual([a]);
  });
});
