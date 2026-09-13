import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLlmUsage } from './api';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('LLM usage API', () => {
  it('读取本次服务的有界调用元数据', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      startedAt: '2026-08-26T00:00:00.000Z',
      totals: {
        calls: 1, succeeded: 1, failed: 0, cancelled: 0,
        inputChars: 10, outputChars: 20,
        estimatedInputTokens: 5, estimatedOutputTokens: 10,
        providerInputTokens: 0, providerOutputTokens: 0, providerUsageCalls: 0,
        billingInputTokens: 5, billingOutputTokens: 10, durationMs: 30,
      },
      models: [], recent: [], note: '字符近似',
    }))) as unknown as typeof fetch;
    await expect(getLlmUsage()).resolves.toMatchObject({
      totals: { calls: 1, inputChars: 10, outputChars: 20 },
    });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/llm-usage');
  });
});
