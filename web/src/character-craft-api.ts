import type {
  CharacterCraft, CharacterCraftMutationResult, CharacterGuide, CharacterGuideInput,
  RelationshipGuide, RelationshipGuideInput,
} from './types';

type Transport = {
  json: (response: Response) => Promise<unknown>;
  jpost: (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
  getWithOptionalSignal: (path: string, signal?: AbortSignal) => Promise<Response>;
};

const clientId = (prefix: string): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const createClientCharacterGuideId = () => clientId('charcraft');
export const createClientRelationshipGuideId = () => clientId('relcraft');
export const createClientTemperatureChangeId = () => clientId('relchange');

export function createCharacterCraftApi({ json, jpost, getWithOptionalSignal }: Transport) {
  const root = (bookId: string) =>
    `/api/books/${encodeURIComponent(bookId)}/character-craft`;
  return {
    getCharacterCraft: (bookId: string, signal?: AbortSignal): Promise<CharacterCraft> =>
      getWithOptionalSignal(root(bookId), signal).then(json) as Promise<CharacterCraft>,
    saveCharacterGuide: (
      bookId: string, entry: CharacterGuideInput, expectedRevision: string,
      signal?: AbortSignal,
    ): Promise<CharacterCraftMutationResult<CharacterGuide>> => jpost(
      `${root(bookId)}/characters`, { entry, expectedRevision }, signal,
    ) as Promise<CharacterCraftMutationResult<CharacterGuide>>,
    saveRelationshipGuide: (
      bookId: string, entry: RelationshipGuideInput, expectedRevision: string,
      signal?: AbortSignal,
    ): Promise<CharacterCraftMutationResult<RelationshipGuide>> => jpost(
      `${root(bookId)}/relationships`, { entry, expectedRevision }, signal,
    ) as Promise<CharacterCraftMutationResult<RelationshipGuide>>,
    deleteCharacterCraftEntry: (
      bookId: string, entryId: string, expectedRevision: string,
    ): Promise<{ deletedId: string; revision: string }> => fetch(
      `${root(bookId)}/entries/${encodeURIComponent(entryId)}`,
      {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision }),
      },
    ).then(json) as Promise<{ deletedId: string; revision: string }>,
  };
}
