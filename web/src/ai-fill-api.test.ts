import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateCharacterCraftDraft, generatePromiseLedgerDraft, generateStoryEngineDraft,
} from './api';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('ai fill API', () => {
  it('requests story engine, character craft and promise drafts with revision anchors', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('story-engine-draft')) {
        return new Response(JSON.stringify({
          storyEngine: {
            readerExperience: '追火种', protagonistAction: '干预', progression: '权限',
            cost: '反噬', escalation: '升级',
          },
          baseRevision: 'E'.repeat(43),
        }));
      }
      if (url.includes('character-craft-draft')) {
        return new Response(JSON.stringify({
          characters: [{ name: '沈砚', importance: 5, asOfChapter: 1, currentDesire: '保住火种',
            fear: '', secret: '', pressureResponse: '', speechPattern: '', speechAvoid: '', notes: '' }],
          relationships: [], baseRevision: 'C'.repeat(43),
        }));
      }
      return new Response(JSON.stringify({
        entries: [{
          kind: 'main', importance: 5, promise: '第一次改写规则',
          expectedStartChapter: 1, expectedEndChapter: 3, notes: '',
        }],
        baseRevision: 'P'.repeat(43),
      }));
    }) as unknown as typeof fetch;

    await expect(generateStoryEngineDraft('book 1', 'E'.repeat(43)))
      .resolves.toMatchObject({ baseRevision: 'E'.repeat(43) });
    await expect(generateCharacterCraftDraft('book 1', 'C'.repeat(43)))
      .resolves.toMatchObject({ characters: [expect.objectContaining({ name: '沈砚' })] });
    await expect(generatePromiseLedgerDraft('book 1', 'P'.repeat(43)))
      .resolves.toMatchObject({ entries: [expect.objectContaining({ promise: '第一次改写规则' })] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});
