import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createClientCharacterGuideId, createClientRelationshipGuideId,
  createClientTemperatureChangeId, deleteCharacterCraftEntry,
  getCharacterCraft, readableApiError, saveCharacterGuide, saveRelationshipGuide,
} from './api';
import type { CharacterGuideInput, RelationshipGuideInput } from './types';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const character: CharacterGuideInput = {
  id: `charcraft_${'a'.repeat(32)}`, name: '沈砚', importance: 5, asOfChapter: 8,
  currentDesire: '拿回密信', fear: '妹妹发现真相', secret: '调换过证物',
  pressureResponse: '先嘲讽拖延', speechPattern: '短句，不解释关心',
  speechAvoid: '不讲大道理', notes: '',
};
const relationship: RelationshipGuideInput = {
  id: `relcraft_${'b'.repeat(32)}`, from: '沈砚', to: '沈青', importance: 5,
  asOfChapter: 8, temperature: 1, surfaceState: '共同查案',
  privateTension: '愧疚被误解为控制', desiredDirection: '真相曝光后决裂',
  changes: [], notes: '',
};

describe('character craft API', () => {
  it('loads separately and sends both entry kinds with one optimistic revision', async () => {
    globalThis.fetch = vi.fn(async (path) => new Response(JSON.stringify(
      String(path).endsWith('/character-craft')
        ? { characters: [], relationships: [], revision: 'R'.repeat(43) }
        : { entry: character, revision: 'N'.repeat(43), deletedId: character.id },
    ), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const controller = new AbortController();
    await getCharacterCraft('book one', controller.signal);
    await saveCharacterGuide('book one', character, 'R'.repeat(43), controller.signal);
    await saveRelationshipGuide('book one', relationship, 'N'.repeat(43));
    await deleteCharacterCraftEntry('book one', character.id, 'D'.repeat(43));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1, '/api/books/book%20one/character-craft', { signal: controller.signal },
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2, '/api/books/book%20one/character-craft/characters', expect.objectContaining({
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ entry: character, expectedRevision: 'R'.repeat(43) }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3, '/api/books/book%20one/character-craft/relationships', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ entry: relationship, expectedRevision: 'N'.repeat(43) }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      4, `/api/books/book%20one/character-craft/entries/${character.id}`,
      expect.objectContaining({
        method: 'DELETE', body: JSON.stringify({ expectedRevision: 'D'.repeat(43) }),
      }),
    );
  });

  it('creates schema-compatible IDs and explains conflicts', () => {
    expect(createClientCharacterGuideId()).toMatch(/^charcraft_[0-9a-f]{32}$/);
    expect(createClientRelationshipGuideId()).toMatch(/^relcraft_[0-9a-f]{32}$/);
    expect(createClientTemperatureChangeId()).toMatch(/^relchange_[0-9a-f]{32}$/);
    expect(readableApiError('CHARACTER_CRAFT_CONFLICT')).toContain('未覆盖新版');
  });
});
