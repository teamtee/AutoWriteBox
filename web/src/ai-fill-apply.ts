import type {
  CharacterCraftDraftCharacter, CharacterCraftDraftRelationship,
  CharacterGuideInput, PromiseLedgerDraftResult, PromiseLedgerEntryInput,
  RelationshipGuideInput,
} from './types';

export function characterCraftPairKey(from: string, to: string) {
  return [from.trim(), to.trim()].sort().join('::');
}

export function characterGuideDraft(
  id: string, entry: CharacterCraftDraftCharacter,
): CharacterGuideInput {
  return { ...entry, id };
}

export function relationshipGuideDraft(
  id: string, entry: CharacterCraftDraftRelationship,
): RelationshipGuideInput {
  return { ...entry, id, changes: [] };
}

export function plannedPromiseEntry(
  id: string, entry: PromiseLedgerDraftResult['entries'][number],
): PromiseLedgerEntryInput {
  return {
    id, kind: entry.kind, status: 'planned', importance: entry.importance,
    promise: entry.promise, introducedChapter: null,
    expectedStartChapter: entry.expectedStartChapter,
    expectedEndChapter: entry.expectedEndChapter,
    progress: [], resolution: '', resolvedChapter: null, nextPromise: '',
    notes: entry.notes,
  };
}
