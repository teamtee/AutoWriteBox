import { join } from 'node:path';
import {
  generationBookOutlineText, generationCharacterRows, generationCoreFieldText,
  generationChapterMemoryRows,
  generationCharacterCraftRelevantText,
  generationPriorSectionSummary,
  generationSectionOutlineText, previousChapterEndingText, recentSectionSummary,
  previousChapterHandoffText,
} from '../generation-context.js';
import {
  MAX_RECENT_REVIEW_SIGNAL_CHAPTERS, MAX_RECENT_REVIEW_SIGNAL_SCAN_CHAPTERS,
  MAX_TOTAL_BOOK_CHAPTERS, MAX_VERSION_TEXT_CHARS,
} from '../limits.js';
import { normalizeChapterReviewSignals } from '../chapter-review-schema.js';
import {
  chapterProseObservations, measureChapterProse,
} from '../chapter-prose-metrics.js';
import { buildChapterContextManifest } from '../chapter-context-manifest.js';
import {
  CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION, CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION,
  CHAPTER_PLAN_RHYTHM_INTENT_VERSION,
  chapterPlanRevision, chapterPlanView, normalizeChapterPlan,
} from '../chapter-plan-schema.js';
import {
  incomingChapterPlanCarryover, normalizeChapterPlanComparison,
} from '../chapter-plan-review-schema.js';
import { normalizeStoryEngine } from '../story-engine-schema.js';
import {
  chapterPlanPromiseAlignment, generationPromiseLedgerRows,
  invalidatePromiseEvidenceSources, normalizePromiseLedger,
  promiseLedgerRevision, requirePromiseLedgerId,
} from '../promise-ledger-schema.js';
import {
  chapterReviewPromiseProgressId, normalizeChapterReviewPromiseCandidates,
} from '../chapter-review-promise-schema.js';
import { chapterReviewRevision } from '../chapter-review-revision-prompt.js';
import { generationCharacterCraftRows } from '../character-craft-schema.js';
import {
  normalizePlatformConfirmations, platformGovernanceView,
} from '../platform-governance-schema.js';
import {
  assertExpectedVersionRevision, commitVersion, currentText, jsonFingerprint,
  moveCursor, versionRevision,
} from './versioned.js';
import { withStoreLock } from './concurrency.js';
import { throwIfAborted } from './abort.js';
import { assertGeneratedWorldBible } from '../world-bible.js';
import { assertGeneratedStyleBible } from '../style-bible.js';
import {
  normalizeChapterReviewWorldGateCandidates,
} from '../chapter-review-world-schema.js';
import {
  confirmedWorldGateId, invalidateWorldGateSources, normalizeWorldProgressState,
  worldProgressContextState, worldProgressPlanningState, worldProgressRevision,
} from '../world-progress-schema.js';
import { worldRevealRoute } from '../world-bible.js';

export function createChapterWorkflowStore(dependencies) {
  const {
    CHAPTER_PREFLIGHT_JSON_PROJECTION, advanceBookUpdatedAt,
    assertChapterReferenced, bookDir,
    bookJsonLockKey, bookMemoryRevision, bookSectionIds,
    chapterFileLockKey, chapterMemoryCandidatesView, countBookChapterReferences,
    hasOtherCompletedChapter, invalidateChapterDerivedData, isObjectRecord,
    latestProgressState, normalizeStoredChapter, normalizedStoredBookMemory,
    parseVersionPath, persistChapterBodyMutation, readBook, readChapter,
    readChapterCompletionMetadata, readReferencedChapter, readReferencedSection,
    readSection, readSectionChapterReferences, readStoredJsonProjection,
    readWritingAssetContext, recoverReferencedStructureTransactions, safeId,
    sectionChapterIds, sectionFileLockKey, touchBookUnlocked, updateBookSectionSummary,
    withChapterWriteLocks, writeBookUnlocked, writeChapterFile,
  } = dependencies;

function chapterPublicationView(chapter) {
  const published = chapter?.published;
  if (!published) return null;
  return {
    ...published,
    isCurrent: published.bodyFingerprint === chapter.bodyFingerprint,
  };
}

async function publishChapterVersion(bookId, sectionId, chapterId, {
  expectedBodyFingerprint,
  expectedMemoryRevision,
  signal,
} = {}) {
  if (typeof expectedBodyFingerprint !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedBodyFingerprint)
    || typeof expectedMemoryRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedMemoryRevision)) {
    throw new Error('BAD_PUBLICATION_ANCHOR');
  }
  return withChapterWriteLocks(bookId, sectionId, chapterId,
    async (safeBookId, safeSectionId, safeChapterId) => {
      const section = await assertChapterReferenced(
        safeBookId, safeSectionId, safeChapterId, { signal },
      );
      const [book, rawChapter] = await Promise.all([
        readBook(safeBookId, { signal }),
        readChapter(safeBookId, safeSectionId, safeChapterId, { signal }),
      ]);
      const chapterIds = sectionChapterIds(section);
      const chapter = normalizeStoredChapter(rawChapter, {
        referencedChapters: new Set(chapterIds),
        chapterIndexes: new Map(chapterIds.map((id, index) => [id, index + 1])),
      });
      if (chapter.bodyFingerprint !== expectedBodyFingerprint) {
        throw new Error('PUBLICATION_STALE');
      }
      if (!currentText(chapter.body).trim()) throw new Error('CHAPTER_EMPTY');
      if (bookMemoryRevision(book) !== expectedMemoryRevision) {
        throw new Error('MEMORY_REVISION_CONFLICT');
      }
      if (chapter.published?.bodyFingerprint === chapter.bodyFingerprint) {
        return {
          published: chapterPublicationView(chapter),
          memoryRevision: bookMemoryRevision(book),
        };
      }

      const memory = normalizedStoredBookMemory(book);
      const now = new Date().toISOString();
      for (const fact of memory.facts) {
        if (fact.status === 'active'
          && fact.source.sectionId === safeSectionId
          && fact.source.chapterId === safeChapterId
          && fact.source.bodyFingerprint !== chapter.bodyFingerprint) {
          fact.status = 'stale';
          fact.updatedAt = now;
        }
      }
      // 发布新版后，旧发布快照不再代表读者当前看到的正文。
      // 仅保留由这次发布正文支撑的作者确认门槛；旧版门槛及其下游依赖一并失效。
      invalidateWorldGateSources(book, {
        sectionId: safeSectionId,
        chapterId: safeChapterId,
        preserveFingerprint: chapter.bodyFingerprint,
      });
      invalidatePromiseEvidenceSources(book, {
        sectionId: safeSectionId,
        chapterId: safeChapterId,
        preserveFingerprint: chapter.bodyFingerprint,
      });
      chapter.published = {
        content: currentText(chapter.body),
        bodyFingerprint: chapter.bodyFingerprint,
        publishedAt: now,
        publicationNumber: (chapter.published?.publicationNumber ?? 0) + 1,
      };

      // 跨 book/chapter 的保守提交顺序：先让旧发布事实退出上下文，
      // 再更新章节发布快照。若第二步磁盘写入失败，最坏是暂时少用旧事实，
      // 不会把未发布事实当成读者已知内容。页面重读后可用新修订号重试。
      throwIfAborted(signal);
      await writeBookUnlocked(safeBookId, book);
      await writeChapterFile(safeBookId, safeSectionId, safeChapterId, chapter);
      return {
        published: chapterPublicationView(chapter),
        memoryRevision: bookMemoryRevision(book),
      };
    }, { signal });
}

async function readChapterPreflightProjection(
  bookId, sectionId, chapterId, { signal } = {},
) {
  const chapterPath = join(bookDir(bookId), sectionId, `${chapterId}.json`);
  let projected;
  try {
    projected = await readStoredJsonProjection(
      chapterPath, CHAPTER_PREFLIGHT_JSON_PROJECTION,
      { signal, projectionInvalidError: 'STORAGE_PROJECTED_DATA_INVALID' },
    );
  } catch (error) {
    if (error?.message !== 'STORAGE_PROJECTED_DATA_INVALID') throw error;
  }
  if (isObjectRecord(projected)
    && projected.id === chapterId
    && typeof projected.title === 'string'
    && typeof projected.bodyFingerprint === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(projected.bodyFingerprint)) {
    return projected;
  }
  const chapter = await readChapter(bookId, sectionId, chapterId, { signal });
  return {
    id: chapter.id,
    title: typeof chapter.title === 'string' ? chapter.title : '',
    bodyFingerprint: chapter.bodyFingerprint,
  };
}

function publicationReviewCheck(review, id) {
  return Array.isArray(review?.webFictionChecks)
    ? review.webFictionChecks.find((item) => item?.id === id)
    : undefined;
}

function publicationReviewResult(reviewCurrent, review, id, label) {
  if (!reviewCurrent) {
    return { id, label, status: 'pending', detail: '当前正文尚无有效审稿，请先重新审稿。' };
  }
  const check = publicationReviewCheck(review, id);
  if (!check || check.status === 'na') {
    return { id, label, status: 'pending', detail: check?.detail || '当前审稿未提供该项结论。' };
  }
  return { id, label, status: check.status, detail: check.detail };
}

function publicationPlatformConfirmationDetail(book) {
  const records = normalizePlatformConfirmations(
    book?.settings?.serialization?.platformConfirmations,
    { errorCode: 'STORAGE_DATA_INVALID' },
  );
  const views = platformGovernanceView(records).confirmations;
  const current = views.filter((item) => item.reviewStatus === 'current');
  if (current.length) {
    const names = current.slice(0, 5).map((item) => item.platform).join('、');
    return `已找到作者近 30 天内的人工核对记录：${names}${current.length > 5 ? ` 等 ${current.length} 个平台` : ''}。实际发布时仍须打开所记录的官方页面确认规则、AI 内容政策和合同未变化；本工具不会标记为已合规。`;
  }
  if (views.length) {
    return '现有平台核对记录均已超过 30 天提醒周期；请重新打开官方规则、AI 内容政策和合同页面核对并更新记录。本工具不会标记为已合规。';
  }
  return '尚未记录平台官方规则、AI 内容政策和合同的人工核对证据；发布前请在「连载管理」登记官方链接与核对时间。本工具不会标记为已合规。';
}

async function readChapterPublicationPreflight(bookId, sectionId, chapterId, {
  expectedBodyFingerprint, signal,
} = {}) {
  if (typeof expectedBodyFingerprint !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedBodyFingerprint)) {
    throw new Error('BAD_PUBLICATION_ANCHOR');
  }
  return withChapterWriteLocks(bookId, sectionId, chapterId,
    async (safeBookId, safeSectionId, safeChapterId) => {
      const section = await assertChapterReferenced(
        safeBookId, safeSectionId, safeChapterId, { signal },
      );
      const [book, rawChapter] = await Promise.all([
        readBook(safeBookId, { signal }),
        readChapter(safeBookId, safeSectionId, safeChapterId, { signal }),
      ]);
      const chapterIds = sectionChapterIds(section);
      const chapter = normalizeStoredChapter(rawChapter, {
        referencedChapters: new Set(chapterIds),
        chapterIndexes: new Map(chapterIds.map((id, index) => [id, index + 1])),
      });
      if (chapter.bodyFingerprint !== expectedBodyFingerprint) {
        throw new Error('PUBLICATION_STALE');
      }
      const content = currentText(chapter.body);
      if (!content.trim()) throw new Error('CHAPTER_EMPTY');

      const bookChapterIndex = await resolveBookChapterIndex(
        safeBookId, book, safeSectionId, chapterIds.indexOf(safeChapterId), { signal },
      );
      const recentReviewSignals = await readRecentChapterReviewSignals(
        safeBookId, book, section, safeSectionId,
        chapterIds.indexOf(safeChapterId), bookChapterIndex, { signal },
      );
      const writingAssetContext = await readWritingAssetContext(
        safeBookId, safeChapterId, { signal },
      );
      const contextRevision = chapterReviewContextRevision({
        book, section, chapter, bookChapterIndex, recentReviewSignals, writingAssetContext,
      });
      const reviewCurrent = Boolean(chapter.review
        && chapter.review.sourceFingerprint === chapter.bodyFingerprint
        && chapter.review.sourceContextRevision === contextRevision);

      const duplicateMatches = [];
      let duplicateCount = 0;
      let logicalChapterIndex = 0;
      for (const candidateSectionId of bookSectionIds(book)) {
        throwIfAborted(signal);
        const candidateSection = candidateSectionId === safeSectionId
          ? section
          : await readSection(safeBookId, candidateSectionId, { signal });
        const candidateChapterIds = sectionChapterIds(candidateSection);
        for (let position = 0; position < candidateChapterIds.length; position += 1) {
          throwIfAborted(signal);
          logicalChapterIndex += 1;
          const candidateChapterId = candidateChapterIds[position];
          if (candidateSectionId === safeSectionId && candidateChapterId === safeChapterId) {
            continue;
          }
          const projected = await readChapterPreflightProjection(
            safeBookId, candidateSectionId, candidateChapterId, { signal },
          );
          if (projected.bodyFingerprint !== chapter.bodyFingerprint) continue;
          // 指纹只用于筛选。命中后再读原文逐字比较，避免损坏派生字段或
          // 理论哈希碰撞把不同正文误报为重复。
          const candidate = await readChapter(
            safeBookId, candidateSectionId, candidateChapterId, { signal },
          );
          if (currentText(candidate.body) !== content) continue;
          duplicateCount += 1;
          if (duplicateMatches.length < 10) {
            duplicateMatches.push({
              sectionId: candidateSectionId,
              chapterId: candidateChapterId,
              chapterIndex: logicalChapterIndex,
              title: typeof candidate.title === 'string' ? candidate.title : '',
            });
          }
        }
      }

      const normalized = content.replace(/\r\n?/g, '\n');
      const formatRisks = [];
      if (!chapter.title.trim()) formatRisks.push('章名为空');
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
        formatRisks.push('含不可见控制字符');
      }
      if (/\uFFFD/.test(normalized)) formatRisks.push('含疑似损坏的替换字符 �');
      if (/\n[ \t]*\n[ \t]*\n[ \t]*\n/.test(normalized)) {
        formatRisks.push('存在连续三行以上空白');
      }
      const firstLine = normalized.split('\n').find((line) => line.trim())?.trim() ?? '';
      if (chapter.title.trim() && firstLine === chapter.title.trim()) {
        formatRisks.push('正文首行重复章名');
      }
      const characterCount = Array.from(normalized.replace(/\s/g, '')).length;
      const paragraphCount = normalized.split('\n').filter((line) => line.trim()).length;
      // 发布前只报告可计算的事实，不替作者判定写得好不好，也不阻断发布；
      // 低于经验值时标为待作者确认，由作者决定本章是否本来就该短。
      const prose = measureChapterProse(content);
      const proseObservations = chapterProseObservations(prose);
      const proseCheck = {
        id: 'prose', label: '正文体量与质感',
        status: proseObservations.length ? 'pending' : 'pass',
        detail: `正文 ${prose.chars} 字符；最长连续叙述块 ${prose.longestNarrationChars} 字符；`
          + `身体与感官锚点 ${prose.sensoryDensity} 处/千字。`
          + (proseObservations.length
            ? `${proseObservations.join('')}这些只是统计观察，是否需要调整由你判断。`
            : ''),
      };
      const checks = [
        {
          id: 'format', label: '章节格式',
          status: formatRisks.length ? 'risk' : 'pass',
          detail: formatRisks.length
            ? formatRisks.join('；')
            : `未见控制字符、异常连续空行或重复章名；正文约 ${characterCount} 字符、${paragraphCount} 个非空段落。`,
        },
        proseCheck,
        {
          id: 'duplicate', label: '整书重复正文',
          status: duplicateCount ? 'risk' : 'pass',
          detail: duplicateCount
            ? `发现 ${duplicateCount} 个正文完全相同的其它章节${duplicateCount > duplicateMatches.length ? '，仅列前 10 个' : ''}。`
            : '未发现与本章正文逐字完全相同的其它章节。',
        },
        publicationReviewResult(
          reviewCurrent, chapter.review, 'effectiveIncrement', '剧情有效增量',
        ),
        publicationReviewResult(
          reviewCurrent, chapter.review, 'endingHook', '章末钩子',
        ),
      ];
      const consistencyChecks = ['longArcProgress', 'styleConsistency', 'packagingPromise']
        .map((id) => publicationReviewCheck(chapter.review, id))
        .filter(Boolean);
      checks.push(!reviewCurrent
        ? {
          id: 'consistency', label: '长线与风格一致性', status: 'pending',
          detail: '当前正文尚无有效审稿，请先重新审稿。',
        }
        : consistencyChecks.some((item) => item.status === 'risk')
          ? {
            id: 'consistency', label: '长线与风格一致性', status: 'risk',
            detail: consistencyChecks.filter((item) => item.status === 'risk')
              .map((item) => item.detail).join('；'),
          }
          : {
            id: 'consistency', label: '长线与风格一致性', status: 'pass',
            detail: '当前审稿未标出长线推进、绑定文风或包装承诺的一致性风险。',
          });
      checks.push(publicationReviewResult(
        reviewCurrent, chapter.review, 'contentRisk', '内容风险线索',
      ));
      checks.push({
        id: 'platformRules', label: '平台规则与合同', status: 'manual',
        detail: publicationPlatformConfirmationDetail(book),
      });
      const status = checks.some((item) => item.status === 'risk')
        ? 'risk'
        : checks.some((item) => ['pending', 'manual'].includes(item.status))
          ? 'attention'
          : 'ready';
      return {
        bodyFingerprint: chapter.bodyFingerprint,
        checkedAt: new Date().toISOString(),
        status,
        characterCount,
        paragraphCount,
        reviewCurrent,
        duplicateCount,
        duplicateMatches,
        checks,
      };
    }, { signal });
}

async function saveChapterReview(bookId, sectionId, chapterId, review, {
  expectedBodyFingerprint,
  expectedContextRevision,
  signal,
} = {}) {
  return withChapterWriteLocks(bookId, sectionId, chapterId, async (safeBookId, safeSectionId, safeChapterId) => {
    await assertChapterReferenced(safeBookId, safeSectionId, safeChapterId, { signal });
    const [book, section, rawChapter] = await Promise.all([
      readBook(safeBookId, { signal }),
      readSection(safeBookId, safeSectionId, { signal }),
      readChapter(safeBookId, safeSectionId, safeChapterId, { signal }),
    ]);
    const chapterIds = sectionChapterIds(section);
    const chapter = normalizeStoredChapter(rawChapter, {
      referencedChapters: new Set(chapterIds),
      chapterIndexes: new Map(chapterIds.map((id, index) => [id, index + 1])),
    });
    if (expectedBodyFingerprint && chapter.bodyFingerprint !== expectedBodyFingerprint) {
      return { applied: false, reason: 'body', chapter };
    }
    const bookChapterIndex = await resolveBookChapterIndex(
      safeBookId, book, safeSectionId, chapterIds.indexOf(safeChapterId), { signal },
    );
    const recentReviewSignals = await readRecentChapterReviewSignals(
      safeBookId, book, section, safeSectionId,
      chapterIds.indexOf(safeChapterId), bookChapterIndex, { signal },
    );
    const writingAssetContext = await readWritingAssetContext(
      safeBookId, safeChapterId, { signal },
    );
    const previous = await readPreviousChapterForGeneration(
      safeBookId, book, safeSectionId, section,
      chapterIds.indexOf(safeChapterId), { signal },
    );
    const currentContextRevision = chapterReviewContextRevision({
      book, section, chapter,
      previousChapter: previous.previousChapter,
      previousChapterSectionId: previous.previousChapterSectionId,
      bookChapterIndex, recentReviewSignals, writingAssetContext,
    });
    if (expectedContextRevision !== undefined
      && currentContextRevision !== expectedContextRevision) {
      return { applied: false, reason: 'context', chapter };
    }
    const planComparison = normalizeChapterPlanComparison(review?.planComparison, {
      chapterPlan: chapter.plan, requireForPlanned: true,
    });
    if (planComparison === null) throw new Error('REVIEW_FAILED');
    const promiseLedgerCandidates = normalizeChapterReviewPromiseCandidates(
      review?.promiseLedgerCandidates,
      {
        chapterPlan: chapter.plan,
        promiseLedger: book.settings?.promiseLedger,
        chapterContent: currentText(chapter.body),
        requireForActions: true,
      },
    );
    if (promiseLedgerCandidates === null) throw new Error('REVIEW_FAILED');
    const worldGateCandidates = normalizeChapterReviewWorldGateCandidates(
      review?.worldGateCandidates,
      {
        sectionOutline: section.outline?.content,
        chapterContent: currentText(chapter.body), requireForContract: true,
      },
    );
    if (worldGateCandidates === null) throw new Error('REVIEW_FAILED');
    const savedReview = {
      ...review,
      ...(planComparison === undefined ? {} : { planComparison }),
      ...(promiseLedgerCandidates === undefined ? {} : { promiseLedgerCandidates }),
      ...(worldGateCandidates === undefined ? {} : { worldGateCandidates }),
      sourceCursor: chapter.body.cursor,
      sourceFingerprint: chapter.bodyFingerprint,
      sourceContextRevision: currentContextRevision,
      sourcePlanRevision: chapterPlanRevision(chapter.plan),
      updatedAt: new Date().toISOString(),
    };
    throwIfAborted(signal);
    chapter.review = savedReview;
    await touchBookUnlocked(safeBookId);
    await writeChapterFile(safeBookId, safeSectionId, safeChapterId, chapter);
    return { applied: true, chapter, review: savedReview };
  }, { signal });
}

async function applyChapterReviewPromiseCandidate(bookId, sectionId, chapterId, entryId, {
  expectedBodyFingerprint,
  expectedReviewRevision,
  expectedPromiseLedgerRevision,
  signal,
} = {}) {
  if (typeof expectedBodyFingerprint !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedBodyFingerprint)
    || typeof expectedReviewRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedReviewRevision)
    || typeof expectedPromiseLedgerRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedPromiseLedgerRevision)) {
    throw new Error('BAD_REVIEW_PROMISE_ANCHOR');
  }
  const safeEntryId = requirePromiseLedgerId(entryId);
  return withChapterWriteLocks(bookId, sectionId, chapterId,
    async (safeBookId, safeSectionId, safeChapterId) => {
      await assertChapterReferenced(safeBookId, safeSectionId, safeChapterId, { signal });
      const [book, section, rawChapter] = await Promise.all([
        readBook(safeBookId, { signal }),
        readSection(safeBookId, safeSectionId, { signal }),
        readChapter(safeBookId, safeSectionId, safeChapterId, { signal }),
      ]);
      const chapterIds = sectionChapterIds(section);
      const chapter = normalizeStoredChapter(rawChapter, {
        referencedChapters: new Set(chapterIds),
        chapterIndexes: new Map(chapterIds.map((id, index) => [id, index + 1])),
      });
      const review = chapter.review;
      if (chapter.bodyFingerprint !== expectedBodyFingerprint
        || !review
        || review.sourceFingerprint !== chapter.bodyFingerprint
        || review.sourcePlanRevision !== chapterPlanRevision(chapter.plan)
        || chapterReviewRevision(review) !== expectedReviewRevision) {
        throw new Error('REVIEW_PROMISE_CANDIDATE_STALE');
      }
      const ledger = normalizePromiseLedger(book.settings?.promiseLedger);
      const currentPromiseLedgerRevision = promiseLedgerRevision(ledger);
      const rawCandidate = review.promiseLedgerCandidates?.find(
        (candidate) => candidate.entryId === safeEntryId,
      );
      if (!rawCandidate) throw new Error('REVIEW_PROMISE_CANDIDATE_NOT_FOUND');
      const syntaxCandidates = normalizeChapterReviewPromiseCandidates([rawCandidate], {
        chapterPlan: chapter.plan,
        chapterContent: currentText(chapter.body),
      });
      if (!syntaxCandidates?.length) throw new Error('REVIEW_PROMISE_CANDIDATE_STALE');
      const candidate = syntaxCandidates[0];
      const entryIndex = ledger.entries.findIndex((entry) => entry.id === safeEntryId);
      if (entryIndex < 0) throw new Error('REVIEW_PROMISE_CANDIDATE_NOT_FOUND');
      const chapterNumber = await resolveBookChapterIndex(
        safeBookId, book, safeSectionId, chapterIds.indexOf(safeChapterId), { signal },
      );
      const progressId = chapterReviewPromiseProgressId({
        bodyFingerprint: chapter.bodyFingerprint,
        entryId: candidate.entryId,
        action: candidate.action,
      });
      const currentEntry = ledger.entries[entryIndex];
      const confirmedEvent = currentEntry.progress.find((event) =>
        event.id === progressId
        && event.chapter === chapterNumber
        && event.note === candidate.summary
        && event.beat === candidate.beat
        && event.readerBefore === candidate.readerBefore
        && event.readerAfter === candidate.readerAfter
        && event.actionConsequence === candidate.actionConsequence
        && event.worldLink === candidate.worldLink
        && event.worldEffect === candidate.worldEffect
        && event.evidence === candidate.evidence
        && event.source?.sectionId === safeSectionId
        && event.source?.chapterId === safeChapterId
        && event.source?.bodyFingerprint === chapter.bodyFingerprint
        && event.status === 'active');
      const alreadyApplied = Boolean(confirmedEvent) && (candidate.action === 'establish'
        ? currentEntry.status === 'open' && currentEntry.introducedChapter === chapterNumber
        : candidate.action === 'pay'
          ? currentEntry.status === 'paid' && currentEntry.resolvedChapter === chapterNumber
            && currentEntry.resolution === candidate.summary
          : true);
      if (alreadyApplied) {
        return {
          entry: currentEntry,
          revision: currentPromiseLedgerRevision,
          alreadyApplied: true,
        };
      }
      if (currentPromiseLedgerRevision !== expectedPromiseLedgerRevision) {
        throw new Error('PROMISE_LEDGER_CONFLICT');
      }
      const candidates = normalizeChapterReviewPromiseCandidates([rawCandidate], {
        chapterPlan: chapter.plan,
        promiseLedger: ledger,
        chapterContent: currentText(chapter.body),
      });
      if (!candidates?.length) throw new Error('REVIEW_PROMISE_CANDIDATE_STALE');
      const now = new Date().toISOString();
      const entry = { ...ledger.entries[entryIndex], updatedAt: now };
      const evidenceEvent = {
        id: progressId,
        chapter: chapterNumber,
        note: candidate.summary,
        beat: candidate.beat,
        readerBefore: candidate.readerBefore,
        readerAfter: candidate.readerAfter,
        actionConsequence: candidate.actionConsequence,
        worldLink: candidate.worldLink,
        worldEffect: candidate.worldEffect,
        evidence: candidate.evidence,
        source: {
          sectionId: safeSectionId,
          chapterId: safeChapterId,
          bodyFingerprint: chapter.bodyFingerprint,
        },
        status: 'active',
        confirmedAt: now,
      };
      if (candidate.action === 'establish') {
        entry.status = 'open';
        entry.introducedChapter = chapterNumber;
        entry.progress = [...entry.progress, evidenceEvent];
      } else if (candidate.action === 'advance') {
        entry.progress = [...entry.progress, evidenceEvent];
      } else {
        entry.status = 'paid';
        entry.resolution = candidate.summary;
        entry.resolvedChapter = chapterNumber;
        entry.progress = [...entry.progress, evidenceEvent];
      }
      ledger.entries[entryIndex] = entry;
      const normalizedLedger = normalizePromiseLedger(ledger);
      throwIfAborted(signal);
      book.settings.promiseLedger = normalizedLedger;
      await writeBookUnlocked(safeBookId, book);
      return { entry, revision: promiseLedgerRevision(normalizedLedger) };
    }, { signal });
}

async function applyChapterReviewWorldGateCandidate(bookId, sectionId, chapterId, {
  expectedBodyFingerprint,
  expectedReviewRevision,
  expectedWorldProgressRevision,
  signal,
} = {}) {
  if (typeof expectedBodyFingerprint !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedBodyFingerprint)
    || typeof expectedReviewRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedReviewRevision)
    || typeof expectedWorldProgressRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedWorldProgressRevision)) {
    throw new Error('BAD_REVIEW_WORLD_GATE_ANCHOR');
  }
  return withChapterWriteLocks(bookId, sectionId, chapterId,
    async (safeBookId, safeSectionId, safeChapterId) => {
      await assertChapterReferenced(safeBookId, safeSectionId, safeChapterId, { signal });
      const [book, section, rawChapter] = await Promise.all([
        readBook(safeBookId, { signal }),
        readSection(safeBookId, safeSectionId, { signal }),
        readChapter(safeBookId, safeSectionId, safeChapterId, { signal }),
      ]);
      const chapterIds = sectionChapterIds(section);
      const chapter = normalizeStoredChapter(rawChapter, {
        referencedChapters: new Set(chapterIds),
        chapterIndexes: new Map(chapterIds.map((id, index) => [id, index + 1])),
      });
      const review = chapter.review;
      if (chapter.bodyFingerprint !== expectedBodyFingerprint
        || !review
        || review.sourceFingerprint !== chapter.bodyFingerprint
        || review.sourcePlanRevision !== chapterPlanRevision(chapter.plan)
        || chapterReviewRevision(review) !== expectedReviewRevision) {
        throw new Error('REVIEW_WORLD_GATE_CANDIDATE_STALE');
      }
      const candidates = normalizeChapterReviewWorldGateCandidates(
        review.worldGateCandidates,
        {
          sectionOutline: section.outline?.content,
          chapterContent: currentText(chapter.body),
        },
      );
      if (!candidates?.length) throw new Error('REVIEW_WORLD_GATE_CANDIDATE_NOT_FOUND');
      const candidate = candidates[0];
      const worldBible = currentText(book.settings?.core?.world);
      const route = worldRevealRoute(worldBible);
      const fromStage = route.find((stage) => stage.layer === candidate.fromLayer);
      const state = normalizeWorldProgressState(book.settings?.worldProgressState);
      const currentRevision = worldProgressRevision(state);
      const id = confirmedWorldGateId({
        fromLayer: candidate.fromLayer,
        bodyFingerprint: chapter.bodyFingerprint,
      });
      const existingIndex = state.gates.findIndex((gate) => gate.id === id);
      const existing = state.gates[existingIndex];
      if (existing?.status === 'active'
        && existing.toLayer === candidate.toLayer
        && existing.gateCondition === candidate.gateCondition
        && existing.summary === candidate.summary
        && existing.evidence === candidate.evidence
        && existing.source.sectionId === safeSectionId
        && existing.source.chapterId === safeChapterId) {
        return { gate: existing, revision: currentRevision, alreadyApplied: true };
      }
      const progress = worldProgressPlanningState(state, worldBible);
      if (!fromStage || fromStage.nextLayerGate !== candidate.gateCondition
        || progress.startLayer !== candidate.fromLayer) {
        throw new Error('REVIEW_WORLD_GATE_CANDIDATE_STALE');
      }
      if (currentRevision !== expectedWorldProgressRevision) {
        throw new Error('WORLD_PROGRESS_CONFLICT');
      }
      const gate = {
        id,
        fromLayer: candidate.fromLayer,
        toLayer: candidate.toLayer,
        gateCondition: candidate.gateCondition,
        summary: candidate.summary,
        evidence: candidate.evidence,
        source: {
          sectionId: safeSectionId,
          chapterId: safeChapterId,
          bodyFingerprint: chapter.bodyFingerprint,
        },
        status: 'active',
        confirmedAt: new Date().toISOString(),
      };
      if (existingIndex < 0) state.gates.push(gate);
      else state.gates[existingIndex] = gate;
      const normalized = normalizeWorldProgressState(state);
      throwIfAborted(signal);
      book.settings.worldProgressState = normalized;
      await writeBookUnlocked(safeBookId, book);
      return { gate, revision: worldProgressRevision(normalized) };
    }, { signal });
}

async function saveChapterPlan(bookId, sectionId, chapterId, value, {
  expectedRevision,
  signal,
} = {}) {
  if (typeof expectedRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedRevision)) {
    throw new Error('BAD_CHAPTER_PLAN_REVISION');
  }
  const requestedQualityProtocolVersion = value?.qualityProtocolVersion;
  const requestedDesignProtocolVersion = value?.designProtocolVersion;
  const requestedRhythmIntentVersion = value?.rhythmIntentVersion;
  let plan = normalizeChapterPlan(value);
  return withChapterWriteLocks(bookId, sectionId, chapterId,
    async (safeBookId, safeSectionId, safeChapterId) => {
      const section = await assertChapterReferenced(
        safeBookId, safeSectionId, safeChapterId, { signal },
      );
      const rawChapter = await readChapter(
        safeBookId, safeSectionId, safeChapterId, { signal },
      );
      const chapterIds = sectionChapterIds(section);
      const chapter = normalizeStoredChapter(rawChapter, {
        referencedChapters: new Set(chapterIds),
        chapterIndexes: new Map(chapterIds.map((id, index) => [id, index + 1])),
      });
      if (chapterPlanRevision(chapter.plan) !== expectedRevision) {
        throw new Error('CHAPTER_PLAN_CONFLICT');
      }
      // 新空章第一次保存策划时服务端也强制进入当前协议，不能只依赖当前前端
      // 传版本号；旧客户端或直接 HTTP 调用同样不能新建宽松模式策划。
      const currentPlanView = chapterPlanView(chapter.plan);
      if (currentPlanView.isEmpty && !chapterPlanView(plan).isEmpty
        && (plan.qualityProtocolVersion !== CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION
          || plan.designProtocolVersion !== CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION)) {
        plan = normalizeChapterPlan({
          ...plan,
          qualityProtocolVersion: CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION,
          designProtocolVersion: CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION,
        });
      }
      const storedQualityProtocolVersion = chapter.plan.qualityProtocolVersion ?? 0;
      if (Number.isInteger(requestedQualityProtocolVersion)
        && requestedQualityProtocolVersion < storedQualityProtocolVersion) {
        throw new Error('CHAPTER_PLAN_QUALITY_DOWNGRADE');
      }
      // 没有版本字段的旧客户端可继续编辑，但服务端保留既有协议，不让它
      // 因旧请求形状而降级；只有明确提交 0 才按冲突拒绝。
      if (storedQualityProtocolVersion > 0 && requestedQualityProtocolVersion === undefined
        && plan.qualityProtocolVersion !== storedQualityProtocolVersion) {
        plan = normalizeChapterPlan({
          ...plan, qualityProtocolVersion: storedQualityProtocolVersion,
        });
      }
      const storedDesignProtocolVersion = chapter.plan.designProtocolVersion ?? 0;
      if (Number.isInteger(requestedDesignProtocolVersion)
        && requestedDesignProtocolVersion < storedDesignProtocolVersion) {
        throw new Error('CHAPTER_PLAN_DESIGN_DOWNGRADE');
      }
      if (storedDesignProtocolVersion > 0 && requestedDesignProtocolVersion === undefined
        && plan.designProtocolVersion !== storedDesignProtocolVersion) {
        plan = normalizeChapterPlan({
          ...plan, designProtocolVersion: storedDesignProtocolVersion,
          decisionChain: chapter.plan.decisionChain,
          knowledgeDesign: chapter.plan.knowledgeDesign,
        });
      }
      const storedRhythmIntentVersion = chapter.plan.rhythmIntentVersion ?? 0;
      if (Number.isInteger(requestedRhythmIntentVersion)
        && requestedRhythmIntentVersion < storedRhythmIntentVersion) {
        throw new Error('CHAPTER_PLAN_RHYTHM_DOWNGRADE');
      }
      if (storedRhythmIntentVersion > 0 && requestedRhythmIntentVersion === undefined
        && plan.rhythmIntentVersion !== storedRhythmIntentVersion) {
        plan = normalizeChapterPlan({
          ...plan,
          rhythmIntentVersion: storedRhythmIntentVersion,
          rhythmIntent: chapter.plan.rhythmIntent,
        });
      }
      const book = await readBook(safeBookId, { signal });
      const bookChapterIndex = await resolveBookChapterIndex(
        safeBookId, book, safeSectionId, chapterIds.indexOf(safeChapterId), { signal },
      );
      const recentReviewSignals = await readRecentChapterReviewSignals(
        safeBookId, book, section, safeSectionId, chapterIds.indexOf(safeChapterId),
        bookChapterIndex, { signal },
      );
      const planView = (candidate) => chapterPlanView(candidate, {
        promiseAlignment: chapterPlanPromiseAlignment(
          book?.settings?.promiseLedger, { bookChapterIndex, plan: candidate },
        ),
        sectionOutline: section.outline?.content,
        recentReviewSignals,
        bookChapterIndex,
        requireCurrentProtocol: !currentText(chapter.body).trim(),
      });
      if (chapterPlanRevision(plan) === expectedRevision) return planView(plan);
      throwIfAborted(signal);
      chapter.plan = plan;
      await touchBookUnlocked(safeBookId);
      await writeChapterFile(safeBookId, safeSectionId, safeChapterId, chapter);
      return planView(chapter.plan);
    }, { signal });
}

function chapterReviewContextRevision({
  book, section, previousChapter, previousChapterSectionId, chapter,
  bookChapterIndex = chapter?.index, recentReviewSignals = [],
  writingAssetContext = { text: '', scene: null, assetIds: [] },
}) {
  const assetContext = {
    text: typeof writingAssetContext?.text === 'string' ? writingAssetContext.text : '',
    scene: typeof writingAssetContext?.scene === 'string' ? writingAssetContext.scene : null,
    assetIds: Array.isArray(writingAssetContext?.assetIds) ? writingAssetContext.assetIds : [],
  };
  return jsonFingerprint({
    book: {
      title: typeof book?.title === 'string' ? book.title : '',
      premise: generationCoreFieldText(typeof book?.premise === 'string' ? book.premise : ''),
      outline: generationBookOutlineText(currentText(book?.outline)),
      summary: generationPriorSectionSummary(book, section?.id),
      core: {
        world: generationCoreFieldText(currentText(book?.settings?.core?.world)),
        style: generationCoreFieldText(currentText(book?.settings?.core?.style)),
        constraints: generationCoreFieldText(currentText(book?.settings?.core?.constraints)),
        pacing: generationCoreFieldText(currentText(book?.settings?.core?.pacing)),
      },
      storyEngine: normalizeStoryEngine(book?.settings?.storyEngine),
      worldProgressState: worldBibleProgressState(book),
      promiseLedger: generationPromiseLedgerRows(book?.settings?.promiseLedger, {
        bookChapterIndex,
      }),
      characterCraft: generationCharacterCraftRows(book?.settings?.characterCraft, {
        relevantText: generationCharacterCraftRelevantText({
          book, section, prevChapter: previousChapter,
          chapterPlan: chapter?.plan, currentContent: chapter?.content,
        }),
      }),
      characters: generationCharacterRows(book?.characters),
      memory: generationChapterMemoryRows(book?.memory, {
        book, section, prevChapter: previousChapter,
        chapterPlan: chapter?.plan, currentContent: chapter?.content,
      }),
    },
    section: {
      outline: generationSectionOutlineText(
        typeof section?.outline?.content === 'string' ? section.outline.content : '',
      ),
      summary: recentSectionSummary(section?.summary),
      characters: generationCharacterRows(section?.characters),
    },
    previousChapter: previousChapter ? {
      sectionId: previousChapterSectionId,
      id: previousChapter.id,
      content: previousChapterEndingText(currentText(previousChapter.body)),
      handoff: previousChapterHandoffText(previousChapter.handoff),
      progress: typeof previousChapter.progress === 'string' ? previousChapter.progress : '',
      characters: generationCharacterRows(previousChapter.characters),
    } : null,
    plan: normalizeChapterPlan(chapter?.plan),
    chapterIndex: chapter?.index,
    bookChapterIndex,
    recentReviewSignals,
    writingAssetContext: assetContext,
  });
}

async function resolveBookChapterIndex(
  bookId, book, sectionId, chapterPosition, { signal } = {},
) {
  const sectionIds = bookSectionIds(book);
  const sectionPosition = sectionIds.indexOf(sectionId);
  if (sectionPosition < 0) throw new Error('SECTION_NOT_FOUND');
  let bookChapterIndex = chapterPosition + 1;
  for (let index = 0; index < sectionPosition; index += 1) {
    throwIfAborted(signal);
    const chapterIds = await readSectionChapterReferences(
      bookId, sectionIds[index], { signal },
    );
    bookChapterIndex += chapterIds.length;
    if (bookChapterIndex > MAX_TOTAL_BOOK_CHAPTERS) {
      throw new Error('BOOK_CHAPTERS_LIMIT_EXCEEDED');
    }
  }
  return bookChapterIndex;
}

async function readRecentChapterReviewSignals(
  bookId, book, currentSection, sectionId, chapterPosition, bookChapterIndex,
  { signal } = {},
) {
  const sectionIds = bookSectionIds(book);
  let sectionPosition = sectionIds.indexOf(sectionId);
  if (sectionPosition < 0) throw new Error('SECTION_NOT_FOUND');
  let candidatePosition = chapterPosition - 1;
  let candidateBookIndex = bookChapterIndex - 1;
  let scanned = 0;
  const rows = [];

  while (sectionPosition >= 0
    && rows.length < MAX_RECENT_REVIEW_SIGNAL_CHAPTERS
    && scanned < MAX_RECENT_REVIEW_SIGNAL_SCAN_CHAPTERS) {
    throwIfAborted(signal);
    const candidateSectionId = sectionIds[sectionPosition];
    // 历史节奏只需要章节引用，不应为此整份解析可能高达 100 MiB 的
    // 前部分部聚合数据。当前部复用已验证快照，其它部走严格流式投影。
    const chapterIds = candidateSectionId === sectionId
      ? sectionChapterIds(currentSection)
      : await readSectionChapterReferences(bookId, candidateSectionId, { signal });
    if (candidatePosition >= chapterIds.length) candidatePosition = chapterIds.length - 1;

    while (candidatePosition >= 0
      && rows.length < MAX_RECENT_REVIEW_SIGNAL_CHAPTERS
      && scanned < MAX_RECENT_REVIEW_SIGNAL_SCAN_CHAPTERS) {
      throwIfAborted(signal);
      const candidateChapterId = chapterIds[candidatePosition];
      const rawChapter = await readChapter(
        bookId, candidateSectionId, candidateChapterId, { signal },
      );
      const candidateChapter = normalizeStoredChapter(rawChapter, {
        referencedChapters: new Set(chapterIds),
        chapterIndexes: new Map(chapterIds.map((id, index) => [id, index + 1])),
      });
      scanned += 1;
      const candidateBody = currentText(candidateChapter.body);
      if (candidateBody.trim()) {
        const currentSignals = candidateChapter.review?.sourceFingerprint
            === candidateChapter.bodyFingerprint
          ? normalizeChapterReviewSignals(candidateChapter.review.webFictionSignals)
          : undefined;
        rows.unshift({
          bookChapterIndex: candidateBookIndex,
          sectionChapterIndex: candidatePosition + 1,
          signals: currentSignals && currentSignals !== null ? currentSignals : null,
          // 体量与质感度量只依赖已保存正文，不需要审稿先完成，
          // 也不额外读盘；旧作品没有审稿记录时仍能形成跨章趋势。
          prose: measureChapterProse(candidateBody),
        });
      }
      candidatePosition -= 1;
      candidateBookIndex -= 1;
    }
    sectionPosition -= 1;
    // 下一轮拿到该部投影后再按实际长度夹紧，避免重复读取一次索引。
    if (sectionPosition >= 0) candidatePosition = Number.MAX_SAFE_INTEGER;
  }
  return rows;
}

async function readChapterReviewContextUnlocked(bookId, sectionId, chapterId, { signal } = {}) {
  throwIfAborted(signal);
  const section = await readReferencedSection(bookId, sectionId, { signal });
  throwIfAborted(signal);
  const chapterIds = sectionChapterIds(section);
  if (!chapterIds.includes(chapterId)) throw new Error('CHAPTER_NOT_FOUND');
  const [book, rawChapter] = await Promise.all([
    readBook(bookId, { signal }),
    readChapter(bookId, sectionId, chapterId, { signal }),
  ]);
  throwIfAborted(signal);
  const chapter = normalizeStoredChapter(rawChapter, {
    referencedChapters: new Set(chapterIds),
    chapterIndexes: new Map(chapterIds.map((id, index) => [id, index + 1])),
  });
  const bookChapterIndex = await resolveBookChapterIndex(
    bookId, book, sectionId, chapterIds.indexOf(chapterId), { signal },
  );
  const recentReviewSignals = await readRecentChapterReviewSignals(
    bookId, book, section, sectionId, chapterIds.indexOf(chapterId),
    bookChapterIndex, { signal },
  );
  const previous = await readPreviousChapterForGeneration(
    bookId, book, sectionId, section, chapterIds.indexOf(chapterId), { signal },
  );
  const incomingPlanCarryover = incomingChapterPlanCarryover(previous.previousChapter, {
    sourceChapterId: previous.previousChapterId,
    sourceChapterTitle: previous.previousChapter?.title,
  });
  const writingAssetContext = await readWritingAssetContext(bookId, chapterId, { signal });
  const contextManifest = buildChapterContextManifest({
    book, section, chapter, previousChapter: previous.previousChapter,
    bookChapterIndex, recentReviewSignals, writingAssetContext,
  });
  return {
    book,
    section,
    chapter,
    previousChapter: previous.previousChapter,
    previousChapterId: previous.previousChapterId,
    previousChapterSectionId: previous.previousChapterSectionId,
    bookChapterIndex,
    recentReviewSignals,
    writingAssetContext,
    contextManifest,
    incomingPlanCarryover,
    contextRevision: chapterReviewContextRevision({
      book, section, chapter,
      previousChapter: previous.previousChapter,
      previousChapterSectionId: previous.previousChapterSectionId,
      bookChapterIndex, recentReviewSignals, writingAssetContext,
    }),
  };
}

async function readChapterReviewContext(bookId, sectionId, chapterId, { signal } = {}) {
  throwIfAborted(signal);
  return withChapterWriteLocks(bookId, sectionId, chapterId,
    (safeBookId, safeSectionId, safeChapterId) =>
      readChapterReviewContextUnlocked(safeBookId, safeSectionId, safeChapterId, { signal }),
    { signal });
}

// 只纳入章节提示词真正读取的持久化字段。updatedAt 等无关变化不应
// 让已经完成的昂贵生成失效；书名、简介、大纲、核心设定、人物、
// 本部前情和上一章路标变化则必须阻止旧上下文结果落盘。
function chapterGenerationContextRevision({
  book, section, previousChapter, previousChapterSectionId, chapter,
  bookChapterIndex = chapter?.index, recentReviewSignals = [],
  writingAssetContext = { text: '', scene: null, assetIds: [] },
}) {
  const assetContext = {
    text: typeof writingAssetContext?.text === 'string' ? writingAssetContext.text : '',
    scene: typeof writingAssetContext?.scene === 'string' ? writingAssetContext.scene : null,
    assetIds: Array.isArray(writingAssetContext?.assetIds) ? writingAssetContext.assetIds : [],
  };
  return jsonFingerprint({
    book: {
      title: typeof book?.title === 'string' ? book.title : '',
      premise: generationCoreFieldText(typeof book?.premise === 'string' ? book.premise : ''),
      outline: generationBookOutlineText(currentText(book?.outline)),
      summary: generationPriorSectionSummary(book, section?.id),
      core: {
        world: generationCoreFieldText(currentText(book?.settings?.core?.world)),
        style: generationCoreFieldText(currentText(book?.settings?.core?.style)),
        constraints: generationCoreFieldText(currentText(book?.settings?.core?.constraints)),
        pacing: generationCoreFieldText(currentText(book?.settings?.core?.pacing)),
      },
      storyEngine: normalizeStoryEngine(book?.settings?.storyEngine),
      worldProgressState: worldBibleProgressState(book),
      promiseLedger: generationPromiseLedgerRows(book?.settings?.promiseLedger, {
        bookChapterIndex,
      }),
      characterCraft: generationCharacterCraftRows(book?.settings?.characterCraft, {
        relevantText: generationCharacterCraftRelevantText({
          book, section, prevChapter: previousChapter,
          chapterPlan: chapter?.plan, currentContent: chapter?.content,
        }),
      }),
      characters: generationCharacterRows(book?.characters),
      memory: generationChapterMemoryRows(book?.memory, {
        book, section, prevChapter: previousChapter,
        chapterPlan: chapter?.plan, currentContent: chapter?.content,
      }),
    },
    section: {
      outline: generationSectionOutlineText(
        typeof section?.outline?.content === 'string' ? section.outline.content : '',
      ),
      summary: recentSectionSummary(section?.summary),
      characters: generationCharacterRows(section?.characters),
    },
    previousChapter: previousChapter ? {
      sectionId: previousChapterSectionId,
      id: previousChapter.id,
      content: previousChapterEndingText(currentText(previousChapter.body)),
      handoff: previousChapterHandoffText(previousChapter.handoff),
      progress: typeof previousChapter.progress === 'string' ? previousChapter.progress : '',
      characters: generationCharacterRows(previousChapter.characters),
    } : null,
    plan: normalizeChapterPlan(chapter?.plan),
    chapterIndex: chapter?.index,
    bookChapterIndex,
    recentReviewSignals,
    writingAssetContext: assetContext,
  });
}

async function readPreviousChapterForGeneration(
  bookId, book, sectionId, section, chapterIndex, { signal } = {},
) {
  const latestCompletedBefore = async (
    candidateSectionId, candidateChapterIds, startIndex,
  ) => {
    for (let index = startIndex; index >= 0; index -= 1) {
      throwIfAborted(signal);
      const candidateChapterId = candidateChapterIds[index];
      const candidateChapter = await readChapter(
        bookId, candidateSectionId, candidateChapterId, { signal },
      );
      throwIfAborted(signal);
      if (currentText(candidateChapter.body).trim()) {
        return {
          previousChapter: candidateChapter,
          previousChapterId: candidateChapterId,
          previousChapterSectionId: candidateSectionId,
        };
      }
    }
    return null;
  };

  // “上一章”是正文顺序中最近的非空章节，而不是最近创建的占位文件。
  // 用户可以手动连续建立空章；若把空占位当作前情，会丢掉真正的结尾、
  // 路标和人物。调用者已持有 book-json 锁，其它章节写入会在提交前等待，
  // 因此跨分部倒序读取仍属于同一稳定生成快照。
  const currentChapterIds = sectionChapterIds(section);
  const inCurrentSection = await latestCompletedBefore(
    sectionId, currentChapterIds, chapterIndex - 1,
  );
  if (inCurrentSection) return inCurrentSection;

  const sectionIds = bookSectionIds(book);
  const currentSectionIndex = sectionIds.indexOf(sectionId);
  if (currentSectionIndex < 0) throw new Error('SECTION_NOT_FOUND');
  for (let index = currentSectionIndex - 1; index >= 0; index -= 1) {
    throwIfAborted(signal);
    const candidateSectionId = sectionIds[index];
    const candidateChapterIds = await readSectionChapterReferences(
      bookId, candidateSectionId, { signal },
    );
    const candidate = await latestCompletedBefore(
      candidateSectionId, candidateChapterIds, candidateChapterIds.length - 1,
    );
    if (candidate) return candidate;
  }

  return {
    previousChapter: null,
    previousChapterId: null,
    previousChapterSectionId: null,
  };
}

async function readChapterGenerationContextUnlocked(bookId, sectionId, chapterId, {
  signal, chapterPlan,
} = {}) {
  throwIfAborted(signal);
  // assertChapterReferenced 已经读取并校验了分部；直接复用该快照，避免同一
  // 锁域内为每次生成重复读取一次 section.json。
  const section = await assertChapterReferenced(bookId, sectionId, chapterId, { signal });
  throwIfAborted(signal);
  const chapterIds = sectionChapterIds(section);
  const chapterIndex = chapterIds.indexOf(chapterId);
  if (chapterIndex < 0) throw new Error('CHAPTER_NOT_FOUND');
  const [book, rawChapter] = await Promise.all([
    readBook(bookId, { signal }),
    readChapter(bookId, sectionId, chapterId, { signal }),
  ]);
  throwIfAborted(signal);
  // 导入或删章后，文件内的历史 index 可能与当前正文顺序不同。生成提示词
  // 必须使用用户在作品树里看到的逻辑序号，与审稿和备份读取保持一致。
  const chapter = normalizeStoredChapter(rawChapter, {
    referencedChapters: new Set(chapterIds),
    chapterIndexes: new Map(chapterIds.map((id, index) => [id, index + 1])),
  });
  const bookChapterIndex = await resolveBookChapterIndex(
    bookId, book, sectionId, chapterIndex, { signal },
  );
  const recentReviewSignals = await readRecentChapterReviewSignals(
    bookId, book, section, sectionId, chapterIndex, bookChapterIndex, { signal },
  );
  const {
    previousChapter, previousChapterId, previousChapterSectionId,
  } = await readPreviousChapterForGeneration(
    bookId, book, sectionId, section, chapterIndex, { signal },
  );
  const writingAssetContext = await readWritingAssetContext(bookId, chapterId, { signal });
  const incomingPlanCarryover = incomingChapterPlanCarryover(previousChapter, {
    sourceChapterId: previousChapterId,
    sourceChapterTitle: previousChapter?.title,
  });
  // AI 策划使用请求中的 seedPlan，而不是磁盘里尚未采纳的旧策划。允许调用方
  // 用这份实际任务计划构造修订号，确保它命中的长期记忆、人物导演卡等材料
  // 在模型调用期间发生变化时，迟到候选不会继续返回。
  const contextChapter = chapterPlan === undefined
    ? chapter
    : { ...chapter, plan: normalizeChapterPlan(chapterPlan) };
  const contextRevision = chapterGenerationContextRevision({
    book, section, previousChapter, previousChapterSectionId, chapter: contextChapter,
    bookChapterIndex, recentReviewSignals, writingAssetContext,
  });
  return {
    book,
    section,
    chapter,
    bookChapterIndex,
    recentReviewSignals,
    previousChapter,
    previousChapterId,
    previousChapterSectionId,
    writingAssetContext,
    incomingPlanCarryover,
    targetRevision: versionRevision(chapter.body),
    contextRevision,
    planDraftContextRevision: jsonFingerprint({
      contextRevision,
      incomingPlanCarryover,
      // 使用临时 seedPlan 计算实际提示词时，仍锚定磁盘策划修订号；否则
      // 另一页面在模型等待期间改策划，旧候选虽然不会自动保存，却会伪装成新鲜结果。
      storedPlanRevision: chapterPlanRevision(chapter.plan),
    }),
  };
}

async function readChapterGenerationContext(bookId, sectionId, chapterId, options = {}) {
  const { signal } = options;
  throwIfAborted(signal);
  return withChapterWriteLocks(bookId, sectionId, chapterId,
    (safeBookId, safeSectionId, safeChapterId) =>
      readChapterGenerationContextUnlocked(safeBookId, safeSectionId, safeChapterId, options),
    { signal });
}

async function commitGeneratedChapter(bookId, sectionId, chapterId, text, {
  expectedRevision,
  expectedContextRevision,
  expectedPreviousChapterId,
  expectedPreviousChapterSectionId,
  expectedLastChapterId,
  signal,
} = {}) {
  if (typeof text !== 'string') throw new Error('BAD_TEXT');
  if (text.length > MAX_VERSION_TEXT_CHARS) throw new Error('TEXT_TOO_LARGE');
  return withChapterWriteLocks(bookId, sectionId, chapterId,
    async (safeBookId, safeSectionId, safeChapterId) => {
      const current = await readChapterGenerationContextUnlocked(
        safeBookId, safeSectionId, safeChapterId, { signal },
      );
      assertExpectedVersionRevision(current.chapter.body, expectedRevision);
      if (typeof expectedContextRevision !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/.test(expectedContextRevision)
        || current.previousChapterId !== expectedPreviousChapterId
        || current.previousChapterSectionId !== expectedPreviousChapterSectionId
        // “下一章”在建章时已核对了旧末章，但模型返回前
        // 另一标签页仍可能在目标后追加新章。只有该模式会传
        // expectedLastChapterId；重写旧章不应因正常的后续章存在而失败。
        || (expectedLastChapterId !== undefined
          && (expectedLastChapterId !== safeChapterId
            || sectionChapterIds(current.section).at(-1) !== expectedLastChapterId))
        || current.contextRevision !== expectedContextRevision) {
        throw new Error('GENERATION_CONTEXT_CONFLICT');
      }
      // 正文和作品时间戳是一次逻辑提交；取得全部锁并复核上下文后，
      // 在首个写入前设置最后取消点，随后必须完整收尾。正文若实际变化，
      // 还要先失效旧 digest，防止后处理失败时留下新正文 + 旧剧情路标。
      throwIfAborted(signal);
      const previousText = currentText(current.chapter.body);
      commitVersion(current.chapter.body, text);
      const invalidated = previousText !== currentText(current.chapter.body)
        ? await invalidateChapterDerivedData(
          safeBookId, safeSectionId, safeChapterId, { ...current, signal },
        )
        : { sectionChanged: false };
      await persistChapterBodyMutation(safeBookId, safeSectionId, safeChapterId, {
        ...current,
        sectionChanged: invalidated.sectionChanged,
      });
      return current.chapter.body;
    }, { signal });
}

// ——— 统一版本读写 ———
// path 形如：'outline' | 'core:world|style|constraints|pacing' | 'section:<sid>:chapter:<cid>'
function versionLockKey(bookId, parsedPath) {
  const safeBookId = safeId(bookId);
  if (parsedPath.type === 'chapter') {
    return chapterFileLockKey(safeBookId, parsedPath.sectionId, parsedPath.chapterId);
  }
  return bookJsonLockKey(safeBookId);
}

function bookGenerationContextRevision(book) {
  return jsonFingerprint({
    premise: typeof book?.premise === 'string' ? book.premise : '',
    core: {
      world: generationCoreFieldText(currentText(book?.settings?.core?.world)),
      style: generationCoreFieldText(currentText(book?.settings?.core?.style)),
      constraints: generationCoreFieldText(currentText(book?.settings?.core?.constraints)),
      pacing: generationCoreFieldText(currentText(book?.settings?.core?.pacing)),
    },
    storyEngine: normalizeStoryEngine(book?.settings?.storyEngine),
  });
}

function worldBibleProgressState(book) {
  return worldProgressContextState(
    book?.settings?.worldProgressState,
    currentText(book?.settings?.core?.world),
  );
}

function sectionPlanContextRevision(book) {
  return jsonFingerprint({
    outline: currentText(book?.outline),
    core: {
      world: generationCoreFieldText(currentText(book?.settings?.core?.world)),
      style: generationCoreFieldText(currentText(book?.settings?.core?.style)),
      constraints: generationCoreFieldText(currentText(book?.settings?.core?.constraints)),
      pacing: generationCoreFieldText(currentText(book?.settings?.core?.pacing)),
    },
    storyEngine: normalizeStoryEngine(book?.settings?.storyEngine),
    worldProgressState: worldBibleProgressState(book),
    occurredSections: (Array.isArray(book?.sections) ? book.sections : []).map((sectionId) => {
      const item = book?.sectionSummaries?.[sectionId];
      return {
        sectionId,
        title: typeof item?.title === 'string' ? item.title : '',
        summary: typeof item?.summary === 'string' ? item.summary : '',
      };
    }),
  });
}

async function commitGeneratedBookVersion(bookId, path, text, {
  expectedRevision,
  expectedContextRevision,
  expectedWritingAssetRevision,
  signal,
} = {}) {
  if (typeof text !== 'string') throw new Error('BAD_TEXT');
  if (text.length > MAX_VERSION_TEXT_CHARS) throw new Error('TEXT_TOO_LARGE');
  const parsed = parseVersionPath(path);
  if (parsed.type === 'chapter') throw new Error('BAD_VERSION_REWRITE_PATH');
  const safeBookId = safeId(bookId);
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId, { signal });
    const versioned = parsed.type === 'outline'
      ? book.outline
      : book.settings.core[parsed.field];
    assertExpectedVersionRevision(versioned, expectedRevision);
    if (typeof expectedContextRevision !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(expectedContextRevision)
      || bookGenerationContextRevision(book) !== expectedContextRevision) {
      throw new Error('GENERATION_CONTEXT_CONFLICT');
    }
    if (parsed.type === 'core' && parsed.field === 'style') {
      const writingAssetContext = await readWritingAssetContext(safeBookId, null, { signal });
      if (typeof expectedWritingAssetRevision !== 'string'
        || writingAssetContext.revision !== expectedWritingAssetRevision) {
        throw new Error('GENERATION_CONTEXT_CONFLICT');
      }
    }
    if (parsed.type === 'core' && parsed.field === 'world') {
      assertGeneratedWorldBible(text);
    }
    if (parsed.type === 'core' && parsed.field === 'style') {
      assertGeneratedStyleBible(text);
    }
    throwIfAborted(signal);
    commitVersion(versioned, text);
    await writeBookUnlocked(safeBookId, book);
    return versioned;
  }, { signal });
}

async function versionMove(bookId, path, delta, { expectedRevision } = {}) {
  const p = parseVersionPath(path);
  const safeBookId = safeId(bookId);
  if (p.type === 'chapter') {
    return withChapterWriteLocks(safeBookId, p.sectionId, p.chapterId, async () => {
      const section = await assertChapterReferenced(safeBookId, p.sectionId, p.chapterId);
      const ch = await readChapter(safeBookId, p.sectionId, p.chapterId);
      assertExpectedVersionRevision(ch.body, expectedRevision);
      const previousText = currentText(ch.body);
      if (!moveCursor(ch.body, delta)) return ch.body;
      const book = await readBook(safeBookId);
      const invalidated = previousText !== currentText(ch.body)
        ? await invalidateChapterDerivedData(
          safeBookId, p.sectionId, p.chapterId, { book, section, chapter: ch },
        )
        : { sectionChanged: false };
      await persistChapterBodyMutation(safeBookId, p.sectionId, p.chapterId, {
        book, section, chapter: ch, sectionChanged: invalidated.sectionChanged,
      });
      return ch.body;
    });
  }
  return withStoreLock(versionLockKey(safeBookId, p), async () => {
    const b = await readBook(safeBookId);
    const vf = p.type === 'outline' ? b.outline : b.settings.core[p.field];
    assertExpectedVersionRevision(vf, expectedRevision);
    if (!moveCursor(vf, delta)) return vf;
    await writeBookUnlocked(safeBookId, b);
    return vf;
  });
}
async function versionSet(bookId, path, text, { expectedRevision } = {}) {
  if (typeof text !== 'string') throw new Error('BAD_TEXT');
  if (text.length > MAX_VERSION_TEXT_CHARS) throw new Error('TEXT_TOO_LARGE');
  const p = parseVersionPath(path);
  const safeBookId = safeId(bookId);
  if (p.type === 'chapter') {
    return withChapterWriteLocks(safeBookId, p.sectionId, p.chapterId, async () => {
      const section = await assertChapterReferenced(safeBookId, p.sectionId, p.chapterId);
      const ch = await readChapter(safeBookId, p.sectionId, p.chapterId);
      assertExpectedVersionRevision(ch.body, expectedRevision);
      const previousText = currentText(ch.body);
      commitVersion(ch.body, text);
      const book = await readBook(safeBookId);
      const invalidated = previousText !== currentText(ch.body)
        ? await invalidateChapterDerivedData(
          safeBookId, p.sectionId, p.chapterId, { book, section, chapter: ch },
        )
        : { sectionChanged: false };
      await persistChapterBodyMutation(safeBookId, p.sectionId, p.chapterId, {
        book, section, chapter: ch, sectionChanged: invalidated.sectionChanged,
      });
      return ch.body;
    });
  }
  return withStoreLock(versionLockKey(safeBookId, p), async () => {
    const b = await readBook(safeBookId);
    const vf = p.type === 'outline' ? b.outline : b.settings.core[p.field];
    assertExpectedVersionRevision(vf, expectedRevision);
    commitVersion(vf, text);
    await writeBookUnlocked(safeBookId, b);
    return vf;
  });
}

  return Object.freeze({
    bookGenerationContextRevision,
    applyChapterReviewPromiseCandidate,
    applyChapterReviewWorldGateCandidate,
    chapterGenerationContextRevision,
    chapterPublicationView,
    chapterReviewContextRevision,
    commitGeneratedBookVersion,
    commitGeneratedChapter,
    publishChapterVersion,
    readChapterGenerationContext,
    readChapterPublicationPreflight,
    readChapterReviewContext,
    saveChapterPlan,
    saveChapterReview,
    sectionPlanContextRevision,
    versionMove,
    versionSet,
  });
}
