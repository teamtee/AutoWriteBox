import { afterEach, describe, it, expect, vi } from 'vitest';
import { parseSSELines, streamGen } from './api';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

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
  it('streamGen 将非 2xx JSON 响应收敛为 onError', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'BAD_PATH' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const errors: string[] = [];
    streamGen('/api/gen/bad', {}, { onError: (m) => errors.push(m) });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual(['BAD_PATH']);
  });
  it('streamGen 在 SSE 正常断开但缺少终止事件时触发 onError', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      'data: {"delta":"半截"}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;

    const deltas: string[] = [];
    const errors: string[] = [];
    streamGen('/api/gen/chapter', {}, {
      onDelta: (d) => deltas.push(d),
      onError: (m) => errors.push(m),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deltas).toEqual(['半截']);
    expect(errors).toEqual(['生成中断：响应未完成']);
  });
});
