import {
  generationBookOutlineText, generationCoreFieldText, generationTextWindow,
} from '../generation-context.js';
import { MAX_GOLDEN_THREE_CHAPTER_PROMPT_CHARS } from '../limits.js';
import { normalizeStoredGoldenThreeReview, normalizeGoldenThreeReview } from '../golden-three-review-schema.js';
import { normalizeStoryEngine } from '../story-engine-schema.js';
import { currentText, jsonFingerprint } from './versioned.js';
import { throwIfAborted } from './abort.js';

const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createGoldenThreeReviewStore(dependencies) {
  const {
    bookJsonLockKey, bookSectionIds, readBook, readChapter, readSection, safeId,
    sectionChapterIds, withStoreLock, writeBookUnlocked,
  } = dependencies;

  function reviewIsCurrent(review, contextRevision, sources) {
    return Boolean(review && contextRevision
      && review.sourceContextRevision === contextRevision
      && review.sources.every((source, index) =>
        source.sectionId === sources[index]?.sectionId
        && source.chapterId === sources[index]?.chapterId
        && source.bodyFingerprint === sources[index]?.bodyFingerprint));
  }

  async function readContextUnlocked(bookId, { signal } = {}) {
    throwIfAborted(signal);
    const book = await readBook(bookId, { signal });
    const targets = [];
    for (const sectionId of bookSectionIds(book)) {
      if (targets.length >= 3) break;
      throwIfAborted(signal);
      const section = await readSection(bookId, sectionId, { signal });
      for (const chapterId of sectionChapterIds(section)) {
        targets.push({ sectionId, chapterId });
        if (targets.length === 3) break;
      }
    }
    const storedReview = normalizeStoredGoldenThreeReview(
      book.settings?.goldenThreeReview,
    );
    const chapters = [];
    for (let index = 0; index < targets.length; index += 1) {
      throwIfAborted(signal);
      const target = targets[index];
      const chapter = await readChapter(
        bookId, target.sectionId, target.chapterId, { signal },
      );
      chapters.push({
        ...target, bookChapterIndex: index + 1,
        title: typeof chapter.title === 'string' ? chapter.title : '',
        bodyFingerprint: chapter.bodyFingerprint,
        content: currentText(chapter.body),
      });
    }
    const missingBodyIndexes = chapters
      .filter((chapter) => !chapter.content.trim())
      .map((chapter) => chapter.bookChapterIndex);
    const sources = chapters.map((chapter) => ({
      sectionId: chapter.sectionId, chapterId: chapter.chapterId,
      bookChapterIndex: chapter.bookChapterIndex, title: chapter.title,
      bodyFingerprint: chapter.bodyFingerprint,
    }));
    if (targets.length < 3) {
      return {
        book, ready: false, reason: 'chapters', availableChapterCount: targets.length,
        completedChapterCount: chapters.length - missingBodyIndexes.length,
        missingChapterIndexes: [
          ...missingBodyIndexes, ...[1, 2, 3].slice(targets.length),
        ],
        sources, review: storedReview, isCurrent: false,
      };
    }
    const missingChapterIndexes = missingBodyIndexes;
    if (missingChapterIndexes.length) {
      return {
        book, ready: false, reason: 'body', availableChapterCount: 3,
        completedChapterCount: 3 - missingChapterIndexes.length,
        missingChapterIndexes, sources, review: storedReview, isCurrent: false,
      };
    }

    const core = book.settings?.core ?? {};
    const promptContext = {
      title: typeof book.title === 'string' ? book.title : '',
      premise: typeof book.premise === 'string' ? book.premise : '',
      outline: generationBookOutlineText(currentText(book.outline)),
      core: {
        world: generationCoreFieldText(currentText(core.world)),
        style: generationCoreFieldText(currentText(core.style)),
        constraints: generationCoreFieldText(currentText(core.constraints)),
        pacing: generationCoreFieldText(currentText(core.pacing)),
      },
      storyEngine: normalizeStoryEngine(book.settings?.storyEngine),
      chapters: chapters.map((chapter) => ({
        ...sources[chapter.bookChapterIndex - 1],
        content: generationTextWindow(
          chapter.content, MAX_GOLDEN_THREE_CHAPTER_PROMPT_CHARS,
        ),
      })),
    };
    const contextRevision = jsonFingerprint(promptContext);
    return {
      book, ready: true, reason: null, availableChapterCount: 3,
      completedChapterCount: 3, missingChapterIndexes: [], sources, promptContext,
      contextRevision, review: storedReview,
      isCurrent: reviewIsCurrent(storedReview, contextRevision, sources),
    };
  }

  async function readGoldenThreeReviewContext(bookId, { signal } = {}) {
    const safeBookId = safeId(bookId);
    return withStoreLock(
      bookJsonLockKey(safeBookId),
      () => readContextUnlocked(safeBookId, { signal }),
      { signal },
    );
  }

  async function saveGoldenThreeReview(bookId, value, {
    expectedContextRevision, signal,
  } = {}) {
    if (typeof expectedContextRevision !== 'string'
      || !HASH_PATTERN.test(expectedContextRevision)) throw new Error('BAD_GOLDEN_THREE_ANCHOR');
    const safeBookId = safeId(bookId);
    return withStoreLock(bookJsonLockKey(safeBookId), async () => {
      const current = await readContextUnlocked(safeBookId, { signal });
      if (!current.ready || current.contextRevision !== expectedContextRevision) {
        return { applied: false, reason: current.ready ? 'context' : 'incomplete' };
      }
      const review = normalizeGoldenThreeReview(value, {
        chapterContents: current.promptContext.chapters.map((chapter) => chapter.content),
        requireEvidenceQuotes: true,
      });
      if (!review) throw new Error('GOLDEN_THREE_REVIEW_FAILED');
      const savedReview = {
        ...review, sourceContextRevision: current.contextRevision,
        sources: current.sources, updatedAt: new Date().toISOString(),
      };
      throwIfAborted(signal);
      current.book.settings.goldenThreeReview = savedReview;
      await writeBookUnlocked(safeBookId, current.book);
      return { applied: true, review: savedReview };
    }, { signal });
  }

  function goldenThreeReviewState(context) {
    const {
      ready, reason, availableChapterCount, completedChapterCount,
      missingChapterIndexes, sources, contextRevision, review, isCurrent,
    } = context;
    return {
      ready, reason, availableChapterCount, completedChapterCount,
      missingChapterIndexes, sources, contextRevision, review, isCurrent,
    };
  }

  return Object.freeze({
    goldenThreeReviewState, readGoldenThreeReviewContext, saveGoldenThreeReview,
  });
}
