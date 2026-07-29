import { describe, it, expect } from 'vitest';
import { parseSSELines } from './api';

describe('parseSSELines', () => {
  it('解析多条 data 行并保留残尾', () => {
    const { events, rest } = parseSSELines(
      'data: {"delta":"你"}\n\ndata: {"delta":"好"}\n\ndata: {"del', ''
    );
    expect(events).toEqual([{ delta: '你' }, { delta: '好' }]);
    expect(rest).toMatch(/del/);
  });
  it('解析 done 事件', () => {
    const { events } = parseSSELines('data: {"done":true}\n\n', '');
    expect(events).toEqual([{ done: true }]);
  });
});
