import type {
  ChapterReview, ChapterReviewRevisionCandidateResult,
  ChapterReviewRevisionVerificationResult,
  ChapterRevisionCandidateResult, ChapterRevisionStage, GoldenThreeReview,
  PromiseLedgerMutationResult,
  WorldProgressMutationResult,
} from './types';

type Transport = {
  jpost: (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
};

export function createReviewApi({ jpost }: Transport) {
  return {
    reviewChapter: (
      bookId: string, sectionId: string, chapterId: string,
      expectedBodyFingerprint: string, expectedContextRevision: string,
      signal?: AbortSignal,
    ): Promise<ChapterReview> => jpost(
      `/api/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}`
        + `/chapters/${encodeURIComponent(chapterId)}/review`,
      { expectedBodyFingerprint, expectedContextRevision }, signal,
    ) as Promise<ChapterReview>,
    applyChapterReviewPromiseCandidate: (
      bookId: string, sectionId: string, chapterId: string, entryId: string,
      expectedBodyFingerprint: string, expectedReviewRevision: string,
      expectedPromiseLedgerRevision: string, signal?: AbortSignal,
    ): Promise<PromiseLedgerMutationResult> => jpost(
      `/api/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}`
        + `/chapters/${encodeURIComponent(chapterId)}/review-promise-candidates/`
        + `${encodeURIComponent(entryId)}/apply`,
      { expectedBodyFingerprint, expectedReviewRevision, expectedPromiseLedgerRevision }, signal,
    ) as Promise<PromiseLedgerMutationResult>,
    applyChapterReviewWorldGateCandidate: (
      bookId: string, sectionId: string, chapterId: string,
      expectedBodyFingerprint: string, expectedReviewRevision: string,
      expectedWorldProgressRevision: string, signal?: AbortSignal,
    ): Promise<WorldProgressMutationResult> => jpost(
      `/api/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}`
        + `/chapters/${encodeURIComponent(chapterId)}/review-world-gate-candidate/apply`,
      {
        expectedBodyFingerprint, expectedReviewRevision, expectedWorldProgressRevision,
      }, signal,
    ) as Promise<WorldProgressMutationResult>,
    reviewGoldenThree: (
      bookId: string, expectedContextRevision: string, signal?: AbortSignal,
    ): Promise<GoldenThreeReview> => jpost(
      `/api/books/${encodeURIComponent(bookId)}/golden-three-review`,
      { expectedContextRevision }, signal,
    ) as Promise<GoldenThreeReview>,
    generateChapterRevisionCandidate: (
      bookId: string, sectionId: string, chapterId: string, stage: ChapterRevisionStage,
      expectedBodyFingerprint: string, expectedContextRevision: string,
      signal?: AbortSignal,
    ): Promise<ChapterRevisionCandidateResult> => jpost(
      `/api/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}`
        + `/chapters/${encodeURIComponent(chapterId)}/revision-candidate`,
      { stage, expectedBodyFingerprint, expectedContextRevision }, signal,
    ) as Promise<ChapterRevisionCandidateResult>,
    generateChapterReviewRevisionCandidate: (
      bookId: string, sectionId: string, chapterId: string,
      expectedBodyFingerprint: string, expectedContextRevision: string,
      expectedReviewRevision: string, signal?: AbortSignal,
    ): Promise<ChapterReviewRevisionCandidateResult> => jpost(
      `/api/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}`
        + `/chapters/${encodeURIComponent(chapterId)}/review-revision-candidate`,
      { expectedBodyFingerprint, expectedContextRevision, expectedReviewRevision }, signal,
    ) as Promise<ChapterReviewRevisionCandidateResult>,
    verifyChapterReviewRevisionCandidate: (
      bookId: string, sectionId: string, chapterId: string, candidate: string,
      expectedBodyFingerprint: string, expectedContextRevision: string,
      expectedReviewRevision: string, signal?: AbortSignal,
    ): Promise<ChapterReviewRevisionVerificationResult> => jpost(
      `/api/books/${encodeURIComponent(bookId)}/sections/${encodeURIComponent(sectionId)}`
        + `/chapters/${encodeURIComponent(chapterId)}/review-revision-candidate/verify`,
      { candidate, expectedBodyFingerprint, expectedContextRevision, expectedReviewRevision }, signal,
    ) as Promise<ChapterReviewRevisionVerificationResult>,
  };
}
