import { describe, expect, it, vi } from 'vitest';
import { runPersistedReviewRequest } from './app-workflows';

describe('runPersistedReviewRequest', () => {
  it('只在请求成功后刷新，并区分保存成功与刷新失败', async () => {
    const refresh = vi.fn(async () => {});
    const saved = await runPersistedReviewRequest({
      begin: () => ({ token: 1, signal: new AbortController().signal }),
      owns: () => true, request: async () => {}, refresh,
    });
    expect(saved.status).toBe('saved');
    expect(refresh).toHaveBeenCalledOnce();
    const failure = new Error('refresh failed');
    const failedRefresh = await runPersistedReviewRequest({
      begin: () => ({ token: 2, signal: new AbortController().signal }),
      owns: () => true, request: async () => {}, refresh: async () => { throw failure; },
    });
    expect(failedRefresh).toEqual({ status: 'saved-refresh-failed', error: failure });
  });

  it('所有权失效后不再刷新或报告成功', async () => {
    const refresh = vi.fn(async () => {});
    const result = await runPersistedReviewRequest({
      begin: () => ({ token: 1, signal: new AbortController().signal }),
      owns: () => false, request: async () => {}, refresh,
    });
    expect(result.status).toBe('aborted');
    expect(refresh).not.toHaveBeenCalled();
  });
});
