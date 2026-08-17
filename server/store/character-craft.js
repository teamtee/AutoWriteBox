import {
  characterCraftRevision, characterCraftView, normalizeCharacterCraft,
  normalizeCharacterGuideInput, normalizeRelationshipGuideInput,
  CHARACTER_GUIDE_ID_PATTERN, RELATIONSHIP_GUIDE_ID_PATTERN,
} from '../character-craft-schema.js';
import {
  MAX_CHARACTER_CRAFT_ENTRIES, MAX_RELATIONSHIP_CRAFT_ENTRIES,
} from '../limits.js';

const REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createCharacterCraftStore({
  bookJsonLockKey, readBook, safeId, throwIfAborted, withStoreLock, writeBookUnlocked,
}) {
  async function readCharacterCraft(bookId, { signal } = {}) {
    const book = await readBook(safeId(bookId), { signal });
    return characterCraftView(book.settings.characterCraft);
  }

  async function saveEntry(bookId, value, {
    expectedRevision, signal, collection, normalize, limit,
  }) {
    if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
      throw new Error('BAD_CHARACTER_CRAFT_REVISION');
    }
    const input = normalize(value);
    const safeBookId = safeId(bookId);
    return withStoreLock(bookJsonLockKey(safeBookId), async () => {
      const book = await readBook(safeBookId, { signal });
      const craft = normalizeCharacterCraft(book.settings.characterCraft);
      if (characterCraftRevision(craft) !== expectedRevision) {
        throw new Error('CHARACTER_CRAFT_CONFLICT');
      }
      const entries = craft[collection];
      const index = entries.findIndex((entry) => entry.id === input.id);
      if (index < 0 && entries.length >= limit) throw new Error('CHARACTER_CRAFT_LIMIT');
      const comparable = (entry) => normalize(entry);
      if (index >= 0 && JSON.stringify(comparable(entries[index])) === JSON.stringify(input)) {
        return { entry: entries[index], revision: expectedRevision };
      }
      const now = new Date().toISOString();
      const entry = {
        ...input,
        createdAt: index >= 0 ? entries[index].createdAt : now,
        updatedAt: now,
      };
      if (index >= 0) entries[index] = entry;
      else entries.push(entry);
      throwIfAborted(signal);
      book.settings.characterCraft = craft;
      await writeBookUnlocked(safeBookId, book);
      return { entry, revision: characterCraftRevision(craft) };
    }, { signal });
  }

  const saveCharacterGuide = (bookId, value, options = {}) => saveEntry(bookId, value, {
    ...options, collection: 'characters', normalize: normalizeCharacterGuideInput,
    limit: MAX_CHARACTER_CRAFT_ENTRIES,
  });
  const saveRelationshipGuide = (bookId, value, options = {}) => saveEntry(bookId, value, {
    ...options, collection: 'relationships', normalize: normalizeRelationshipGuideInput,
    limit: MAX_RELATIONSHIP_CRAFT_ENTRIES,
  });

  async function deleteCharacterCraftEntry(bookId, entryId, {
    expectedRevision, signal,
  } = {}) {
    if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
      throw new Error('BAD_CHARACTER_CRAFT_REVISION');
    }
    const collection = CHARACTER_GUIDE_ID_PATTERN.test(entryId) ? 'characters'
      : RELATIONSHIP_GUIDE_ID_PATTERN.test(entryId) ? 'relationships' : null;
    if (!collection) throw new Error('BAD_CHARACTER_CRAFT_ENTRY');
    const safeBookId = safeId(bookId);
    return withStoreLock(bookJsonLockKey(safeBookId), async () => {
      const book = await readBook(safeBookId, { signal });
      const craft = normalizeCharacterCraft(book.settings.characterCraft);
      if (characterCraftRevision(craft) !== expectedRevision) {
        throw new Error('CHARACTER_CRAFT_CONFLICT');
      }
      const index = craft[collection].findIndex((entry) => entry.id === entryId);
      if (index < 0) throw new Error('CHARACTER_CRAFT_ENTRY_NOT_FOUND');
      craft[collection].splice(index, 1);
      throwIfAborted(signal);
      book.settings.characterCraft = craft;
      await writeBookUnlocked(safeBookId, book);
      return { deletedId: entryId, revision: characterCraftRevision(craft) };
    }, { signal });
  }

  return {
    deleteCharacterCraftEntry, readCharacterCraft,
    saveCharacterGuide, saveRelationshipGuide,
  };
}
