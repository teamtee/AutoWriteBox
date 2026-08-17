import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveStoryEngine } from './api';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('story engine API', () => {
  it('sends the five fields with an optimistic revision anchor', async () => {
    const storyEngine = {
      readerExperience: '期待', protagonistAction: '行动', progression: '收益',
      cost: '代价', escalation: '升级',
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      ...storyEngine, revision: 'N'.repeat(43), isEmpty: false,
    }))) as unknown as typeof fetch;
    await expect(saveStoryEngine(
      'book 1', storyEngine, 'R'.repeat(43),
    )).resolves.toMatchObject({ progression: '收益' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/books/book%201/story-engine',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ storyEngine, expectedRevision: 'R'.repeat(43) }),
      }),
    );
  });
});
