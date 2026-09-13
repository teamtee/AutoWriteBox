import type {
  ChapterPlanDraftResult, ChapterPlanInput, CharacterCraftDraftResult,
  PromiseLedgerDraftResult, StoryEngineDraftResult,
} from './types';

type Transport = {
  jpost: (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
};

export function createAiFillApi({ jpost }: Transport) {
  return {
    generateChapterPlanDraft: (
      bookId: string,
      sectionId: string,
      chapterId: string,
      seedPlan: ChapterPlanInput,
      expectedPlanRevision: string,
      signal?: AbortSignal,
    ): Promise<ChapterPlanDraftResult> => jpost(
      '/api/gen/chapter-plan-draft',
      { bookId, sectionId, chapterId, seedPlan, expectedPlanRevision },
      signal,
    ) as Promise<ChapterPlanDraftResult>,
    generateStoryEngineDraft: (
      bookId: string, expectedRevision: string, signal?: AbortSignal,
    ): Promise<StoryEngineDraftResult> => jpost(
      '/api/gen/story-engine-draft', { bookId, expectedRevision }, signal,
    ) as Promise<StoryEngineDraftResult>,
    generateCharacterCraftDraft: (
      bookId: string, expectedRevision: string, signal?: AbortSignal,
    ): Promise<CharacterCraftDraftResult> => jpost(
      '/api/gen/character-craft-draft',
      { bookId, expectedRevision }, signal,
    ) as Promise<CharacterCraftDraftResult>,
    generatePromiseLedgerDraft: (
      bookId: string, expectedRevision: string, signal?: AbortSignal,
    ): Promise<PromiseLedgerDraftResult> => jpost(
      '/api/gen/promise-ledger-draft',
      { bookId, expectedRevision }, signal,
    ) as Promise<PromiseLedgerDraftResult>,
  };
}
