import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  bookSectionSummaryWindow, buildBookSummaryFromSectionSummaries,
} from '../generation-context.js';
import {
  MAX_DIGEST_PROGRESS_CHARS, MAX_DIGEST_SUMMARY_CHARS,
  MAX_MEMORY_FACTS_PER_BOOK, MAX_MEMORY_REJECTIONS_PER_BOOK,
  MAX_STAGE_SUMMARIES_PER_BOOK, MAX_STAGE_SUMMARY_CHARS,
  MAX_STAGE_SUMMARY_TITLE_CHARS, MAX_STORED_CHARACTERS,
} from '../limits.js';
import { MEMORY_ID_PATTERN, sanitizeMemoryCandidates } from '../memory-schema.js';
import {
  createStageSummaryId, stageSummaryPublicView, stageSummaryRange,
  stageSummarySourceSnapshot, STAGE_SUMMARY_ID_PATTERN, STAGE_SUMMARY_STATUSES,
} from '../stage-summary-schema.js';
import { currentText, isValidVersioned, jsonFingerprint } from './versioned.js';
import { withStoreLock } from './concurrency.js';
import { throwIfAborted } from './abort.js';
import {
  CHAPTER_DIGEST_TRANSACTION_FORMAT, CHAPTER_DIGEST_TRANSACTION_VERSION,
} from './structure-constants.js';
import { invalidateWorldGateSources } from '../world-progress-schema.js';
import { invalidatePromiseEvidenceSources } from '../promise-ledger-schema.js';
import { emptyChapterHandoff, normalizeChapterHandoff } from '../chapter-handoff-schema.js';

export function createMemoryStore(dependencies) {
  const {
    CHAPTER_COMPLETION_JSON_PROJECTION, CHAPTER_DIGEST_SUMMARY_JSON_PROJECTION,
    atomicWriteJson, bookDir, bookJsonLockKey, bookSectionIds,
    assertChapterReferenced, chapterDigestTransactionPath, chapterFileLockKey,
    clearCommittedTransaction, inspectJsonFile, isObjectRecord,
    isValidChapterDigestTransaction,
    backupText, normalizeBackupBookMemory, normalizeBackupStageSummaries, normalizeStoredChapter,
    readBook, readChapter, readSection, readSectionChapterReferences,
    readStoredJsonProjection, safeId, sectionChapterIds,
    sectionFileLockKey, recoverReferencedStructureTransactions, validateStoredData,
    withChapterWriteLocks, writeBookUnlocked, writeChapterFile,
  } = dependencies;

function buildSectionSummary(section) {
  const summaries = section.chapterSummaries;
  if (!summaries || typeof summaries !== 'object' || Array.isArray(summaries)) return section.summary || '';
  return (section.chapters || []).flatMap((cid, position) => {
    if (!Object.prototype.hasOwnProperty.call(summaries, cid)) return [];
    const item = summaries[cid];
    if (!item) return [];
    if (typeof item === 'string') return [`第${position + 1}章：${item}`];
    if (typeof item.summary !== 'string' || !item.summary) return [];
    // item.index 是兼容旧数据的历史快照；删章、导入或人工调整引用后可能
    // 已过期。聚合摘要与作品树、生成提示词一样始终以当前引用顺序为准。
    return [`第${position + 1}章：${item.summary}`];
  }).join('\n');
}

function updateBookSectionSummary(book, section) {
  if (!isObjectRecord(book.sectionSummaries)) book.sectionSummaries = {};
  const sectionIds = bookSectionIds(book);
  const sectionIndex = sectionIds.indexOf(section.id);
  if (sectionIndex < 0) throw new Error('SECTION_NOT_FOUND');
  const summary = bookSectionSummaryWindow(section.summary);
  if (!summary) {
    delete book.sectionSummaries[section.id];
  } else {
    Object.defineProperty(book.sectionSummaries, section.id, {
      value: {
        index: sectionIndex + 1,
        title: typeof section.title === 'string' ? section.title : '',
        summary,
      },
      enumerable: true, writable: true, configurable: true,
    });
  }
  book.summary = buildBookSummaryFromSectionSummaries(book);
}

function normalizeStoredDigestSummary(value) {
  if (typeof value !== 'string') return '';
  return validateStoredData(() => backupText(
    value, MAX_DIGEST_SUMMARY_CHARS, { codePoints: true },
  ));
}

async function readChapterDigestSummary(bookId, sectionId, chapterId, { signal } = {}) {
  let projected;
  try {
    projected = await readStoredJsonProjection(
      join(bookDir(bookId), sectionId, `${chapterId}.json`),
      CHAPTER_DIGEST_SUMMARY_JSON_PROJECTION,
      { signal, projectionInvalidError: 'STORAGE_PROJECTED_DATA_INVALID' },
    );
  } catch (error) {
    if (error?.message !== 'STORAGE_PROJECTED_DATA_INVALID') throw error;
    // 早期或人工编辑数据的 summary 若不是字符串，保留旧行为
    // 将其视为无摘要；超界字符串则不再向聚合文件传播。
    const chapter = await readChapter(bookId, sectionId, chapterId, { signal });
    if (!isObjectRecord(chapter) || chapter.id !== chapterId) {
      throw new Error('STORAGE_DATA_INVALID');
    }
    return normalizeStoredDigestSummary(chapter.summary);
  }
  throwIfAborted(signal);
  if (!isObjectRecord(projected) || projected.id !== chapterId) {
    throw new Error('STORAGE_DATA_INVALID');
  }
  return normalizeStoredDigestSummary(projected.summary);
}

async function ensureChapterSummaries(bookId, section, {
  force = false, strict = false, signal,
} = {}) {
  if (!force && section.chapterSummaries && typeof section.chapterSummaries === 'object'
    && !Array.isArray(section.chapterSummaries)) {
    return section.chapterSummaries;
  }
  const summaries = {};
  for (const [position, cid] of (section.chapters || []).entries()) {
    throwIfAborted(signal);
    try {
      const summary = await readChapterDigestSummary(
        bookId, section.id, cid, { signal },
      );
      if (summary) {
        Object.defineProperty(summaries, cid, {
          value: { index: position + 1, summary },
          enumerable: true, writable: true, configurable: true,
        });
      }
    } catch (err) {
      if (err.code !== 'ENOENT' || strict) throw err;
    }
  }
  section.chapterSummaries = summaries;
  return summaries;
}

async function readChapterCompletionMetadata(
  bookId, sectionId, chapterId, { signal } = {},
) {
  let projected;
  try {
    projected = await readStoredJsonProjection(
      join(bookDir(bookId), sectionId, `${chapterId}.json`),
      CHAPTER_COMPLETION_JSON_PROJECTION,
      { signal, projectionInvalidError: 'STORAGE_PROJECTED_DATA_INVALID' },
    );
  } catch (error) {
    if (error?.message !== 'STORAGE_PROJECTED_DATA_INVALID') throw error;
    // 早期正文使用 content/history，需先经原有迁移逻辑。
    // 异常的现代字段则在回退后继续执行同等边界校验。
    const chapter = await readChapter(bookId, sectionId, chapterId, { signal });
    if (!isObjectRecord(chapter)
      || chapter.id !== chapterId
      || !isValidVersioned(chapter.body)
      || (chapter.progress !== undefined
        && (typeof chapter.progress !== 'string'
          || chapter.progress.length > MAX_DIGEST_PROGRESS_CHARS))) {
      throw new Error('STORAGE_DATA_INVALID');
    }
    return {
      hasContent: Boolean(currentText(chapter.body).trim()),
      progress: chapter.progress ?? '',
    };
  }
  throwIfAborted(signal);
  if (!isObjectRecord(projected)
    || projected.id !== chapterId
    || typeof projected.body !== 'boolean'
    || (projected.progress !== undefined && typeof projected.progress !== 'string')) {
    throw new Error('STORAGE_DATA_INVALID');
  }
  return {
    hasContent: projected.body,
    progress: projected.progress ?? '',
  };
}

async function latestCompletedChapterInSection(
  bookId, sectionId, section, {
    targetSectionId, targetChapterId, targetChapter, signal,
  } = {},
) {
  const chapterIds = sectionChapterIds(section);
  for (let index = chapterIds.length - 1; index >= 0; index -= 1) {
    throwIfAborted(signal);
    const chapterId = chapterIds[index];
    const isTarget = sectionId === targetSectionId && chapterId === targetChapterId;
    const chapter = isTarget
      ? {
        hasContent: Boolean(currentText(targetChapter?.body).trim()),
        progress: typeof targetChapter?.progress === 'string' ? targetChapter.progress : '',
      }
      : await readChapterCompletionMetadata(bookId, sectionId, chapterId, { signal });
    throwIfAborted(signal);
    if (chapter.hasContent) return chapter;
  }
  return null;
}

async function latestProgressState(
  bookId, book, sectionId, section, chapterId, chapter, { signal } = {},
) {
  const lookup = {
    targetSectionId: sectionId,
    targetChapterId: chapterId,
    targetChapter: chapter,
    signal,
  };
  const sectionLatest = await latestCompletedChapterInSection(
    bookId, sectionId, section, lookup,
  );
  const sectionIds = bookSectionIds(book);
  const currentSectionIndex = sectionIds.indexOf(sectionId);
  if (currentSectionIndex < 0) throw new Error('SECTION_NOT_FOUND');

  let bookLatest = null;
  for (let index = sectionIds.length - 1; index >= 0; index -= 1) {
    throwIfAborted(signal);
    const candidateSectionId = sectionIds[index];
    if (candidateSectionId === sectionId) {
      bookLatest = sectionLatest;
    } else {
      const candidateChapterIds = await readSectionChapterReferences(
        bookId, candidateSectionId, { signal },
      );
      bookLatest = await latestCompletedChapterInSection(
        bookId, candidateSectionId, { chapters: candidateChapterIds }, lookup,
      );
    }
    if (bookLatest) break;
  }

  return {
    sectionProgress: typeof sectionLatest?.progress === 'string'
      ? sectionLatest.progress
      : '',
    bookProgress: typeof bookLatest?.progress === 'string'
      ? bookLatest.progress
      : '',
  };
}

// digest 会依次更新 book、chapter、section 三个文件。若最后一步失败或进程
// 退出，章节文件可能已有新摘要，而分部聚合索引仍停留在旧状态。事务标记
// 不重放模型输出，只以当前章节文件为权威重建摘要与剧情路标，因此无论
// 中断发生在哪一步都可幂等收敛，也不会把半写内存对象当成已提交事实。
async function recoverChapterDigestTransaction(bookId, sectionId, { signal } = {}) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  const transactionPath = chapterDigestTransactionPath(safeBookId, safeSectionId);
  const inspected = await inspectJsonFile(transactionPath, { signal });
  if (inspected.status === 'missing') return null;
  if (inspected.status !== 'ok') {
    throw new Error(`CHAPTER_DIGEST_TRANSACTION_${inspected.status.toUpperCase()}`);
  }
  if (!isValidChapterDigestTransaction(inspected.value, safeBookId, safeSectionId)) {
    throw new Error('CHAPTER_DIGEST_TRANSACTION_INVALID');
  }

  const [book, section] = await Promise.all([
    readBook(safeBookId, { signal }),
    readSection(safeBookId, safeSectionId, { signal }),
  ]);
  if (!bookSectionIds(book).includes(safeSectionId)) {
    throw new Error('CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT');
  }
  const chapterIds = sectionChapterIds(section);
  if (!chapterIds.includes(inspected.value.chapterId)) {
    throw new Error('CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT');
  }
  const targetChapter = await readChapter(
    safeBookId, safeSectionId, inspected.value.chapterId, { signal },
  );
  if (!isObjectRecord(targetChapter)
    || targetChapter.id !== inspected.value.chapterId
    || !isValidVersioned(targetChapter.body)) {
    throw new Error('STORAGE_DATA_INVALID');
  }
  if (targetChapter.bodyFingerprint !== inspected.value.bodyFingerprint) {
    throw new Error('CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT');
  }
  await ensureChapterSummaries(safeBookId, section, {
    force: true, strict: true, signal,
  });
  section.summary = buildSectionSummary(section);
  updateBookSectionSummary(book, section);
  const latestProgress = await latestProgressState(
    safeBookId, book, safeSectionId, section, null, null, { signal },
  );
  section.progress = latestProgress.sectionProgress;
  book.progress = latestProgress.bookProgress;

  // 标记已经存在后，取消只能发生在首个恢复写入前；随后必须完整收尾并
  // 保留标记供再次重试，直到两个聚合文件都成功提交。
  throwIfAborted(signal);
  await writeBookUnlocked(safeBookId, book);
  await atomicWriteJson(join(bookDir(safeBookId), safeSectionId, 'section.json'), section);
  await clearCommittedTransaction(
    transactionPath, join(bookDir(safeBookId), safeSectionId),
  );
  return { type: 'chapter-digest', chapterId: inspected.value.chapterId };
}

async function hasOtherCompletedChapter(
  bookId, sectionId, section, chapterId, { signal } = {},
) {
  for (const otherChapterId of sectionChapterIds(section)) {
    if (otherChapterId === chapterId) continue;
    throwIfAborted(signal);
    const other = await readChapterCompletionMetadata(
      bookId, sectionId, otherChapterId, { signal },
    );
    throwIfAborted(signal);
    if (other.hasContent) return true;
  }
  return false;
}

const MEMORY_REVISION_SALT = randomUUID();
const STAGE_SUMMARY_REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function normalizedStoredStageSummaries(book) {
  const normalized = validateStoredData(() =>
    normalizeBackupStageSummaries(book?.stageSummaries, bookSectionIds(book)));
  book.stageSummaries = normalized;
  return normalized;
}

function stageSummaryRevision(book) {
  return jsonFingerprint(normalizedStoredStageSummaries(book));
}

function assertStageSummaryRevision(book, expectedRevision) {
  if (typeof expectedRevision !== 'string'
    || !STAGE_SUMMARY_REVISION_PATTERN.test(expectedRevision)) {
    throw new Error('BAD_STAGE_SUMMARY_REVISION');
  }
  if (stageSummaryRevision(book) !== expectedRevision) {
    throw new Error('STAGE_SUMMARY_CONFLICT');
  }
}

function normalizeStageSummaryInput({
  id, title, startSectionId, endSectionId, summary, status,
}, { requireSummary = true } = {}) {
  if (typeof id !== 'string' || !STAGE_SUMMARY_ID_PATTERN.test(id)) {
    throw new Error('BAD_STAGE_SUMMARY_ID');
  }
  if (typeof title !== 'string' || !title.trim()
    || Array.from(title).length > MAX_STAGE_SUMMARY_TITLE_CHARS) {
    throw new Error('BAD_STAGE_SUMMARY_TITLE');
  }
  if (typeof startSectionId !== 'string' || typeof endSectionId !== 'string') {
    throw new Error('BAD_STAGE_SUMMARY_RANGE');
  }
  if (requireSummary && (typeof summary !== 'string' || !summary.trim())) {
    throw new Error('BAD_STAGE_SUMMARY_TEXT');
  }
  if (summary !== undefined && (typeof summary !== 'string'
    || Array.from(summary).length > MAX_STAGE_SUMMARY_CHARS)) {
    throw new Error('STAGE_SUMMARY_TEXT_TOO_LARGE');
  }
  if (status !== undefined && !STAGE_SUMMARY_STATUSES.has(status)) {
    throw new Error('BAD_STAGE_SUMMARY_STATUS');
  }
  if (requireSummary && status === undefined) throw new Error('BAD_STAGE_SUMMARY_STATUS');
  return {
    id, title: title.trim(), startSectionId, endSectionId,
    ...(summary === undefined ? {} : { summary: summary.trim() }),
    ...(status === undefined ? {} : { status }),
  };
}

function stageSummaryLibraryView(book) {
  const stageSummaries = normalizedStoredStageSummaries(book)
    .map((item) => stageSummaryPublicView(book, item));
  return { stageSummaries, stageSummaryRevision: stageSummaryRevision(book) };
}

function normalizedStoredBookMemory(book) {
  const memory = validateStoredData(() => normalizeBackupBookMemory(book?.memory));
  book.memory = memory;
  return memory;
}

function invalidateDeletedChapterMemory(
  book, sectionId, chapterId, chapter, remainingChapterIds = [],
) {
  const memory = normalizedStoredBookMemory(book);
  invalidateWorldGateSources(book, {
    sectionId, chapterId, preserveFingerprint: undefined,
  });
  invalidatePromiseEvidenceSources(book, {
    sectionId, chapterId, preserveFingerprint: undefined,
  });
  const staleAt = new Date().toISOString();
  const remainingIndexes = new Map(
    remainingChapterIds.map((id, index) => [id, index + 1]),
  );
  for (const fact of memory.facts) {
    if (fact.source.sectionId !== sectionId || fact.status !== 'active') continue;
    if (fact.source.chapterId === chapterId) {
      fact.status = 'stale';
      fact.updatedAt = staleAt;
    } else if (remainingIndexes.has(fact.source.chapterId)) {
      fact.source.chapterIndex = remainingIndexes.get(fact.source.chapterId);
    }
  }
  const candidateIds = new Set(
    (Array.isArray(chapter?.memoryCandidates) ? chapter.memoryCandidates : [])
      .map((candidate) => candidate?.id)
      .filter((id) => typeof id === 'string' && MEMORY_ID_PATTERN.test(id)),
  );
  if (candidateIds.size) {
    memory.rejectedCandidateIds = memory.rejectedCandidateIds.filter(
      (id) => !candidateIds.has(id),
    );
  }
}

function bookMemoryRevision(book) {
  const memory = validateStoredData(() => normalizeBackupBookMemory(book?.memory));
  return createHash('sha256')
    .update(MEMORY_REVISION_SALT, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(memory), 'utf8')
    .digest('base64url');
}

function chapterMemoryCandidatesView(book, chapter) {
  const memory = validateStoredData(() => normalizeBackupBookMemory(book?.memory));
  const facts = new Map(memory.facts.map((fact) => [fact.id, fact]));
  const rejected = new Set(memory.rejectedCandidateIds);
  return (Array.isArray(chapter?.memoryCandidates) ? chapter.memoryCandidates : []).map(
    (candidate) => {
      const fact = facts.get(candidate.id);
      const status = fact
        ? fact.status === 'active' ? 'accepted' : fact.status
        : rejected.has(candidate.id) ? 'rejected' : 'pending';
      return {
        ...candidate, status,
        ...(fact?.autoAccepted === true ? { autoAccepted: true } : {}),
      };
    },
  );
}

function bookMemoryLibraryView(book) {
  const memory = normalizedStoredBookMemory(book);
  return {
    facts: memory.facts,
    plotSummary: typeof book.summary === 'string' ? book.summary : '',
    sectionSummaryCount: isObjectRecord(book.sectionSummaries)
      ? Object.keys(book.sectionSummaries).length : 0,
    memoryRevision: bookMemoryRevision(book),
    ...stageSummaryLibraryView(book),
  };
}

async function readStageSummarySource(bookId, input, {
  expectedStageSummaryRevision, signal,
} = {}) {
  const safeBookId = safeId(bookId);
  const normalized = normalizeStageSummaryInput(input ?? {}, { requireSummary: false });
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId, { signal });
    assertStageSummaryRevision(book, expectedStageSummaryRevision);
    const stageSummaries = normalizedStoredStageSummaries(book);
    const existing = stageSummaries.find((item) => item.id === normalized.id);
    if (existing?.status === 'frozen') throw new Error('STAGE_SUMMARY_FROZEN');
    stageSummaryRange(book, normalized.startSectionId, normalized.endSectionId);
    const source = stageSummarySourceSnapshot(
      book, normalized.startSectionId, normalized.endSectionId,
    );
    if (!source.rows.some((row) => row.summary.trim())) {
      throw new Error('STAGE_SUMMARY_SOURCE_EMPTY');
    }
    return { ...normalized, ...source };
  }, { signal });
}

async function saveGeneratedStageSummary(bookId, input, {
  expectedStageSummaryRevision, expectedSourceFingerprint, signal,
} = {}) {
  const safeBookId = safeId(bookId);
  const normalized = normalizeStageSummaryInput({ ...input, status: 'draft' });
  if (typeof expectedSourceFingerprint !== 'string'
    || !STAGE_SUMMARY_REVISION_PATTERN.test(expectedSourceFingerprint)) {
    throw new Error('BAD_STAGE_SUMMARY_SOURCE');
  }
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId, { signal });
    assertStageSummaryRevision(book, expectedStageSummaryRevision);
    const stageSummaries = normalizedStoredStageSummaries(book);
    const index = stageSummaries.findIndex((item) => item.id === normalized.id);
    if (index >= 0 && stageSummaries[index].status === 'frozen') {
      throw new Error('STAGE_SUMMARY_FROZEN');
    }
    if (index < 0 && stageSummaries.length >= MAX_STAGE_SUMMARIES_PER_BOOK) {
      throw new Error('STAGE_SUMMARY_LIMIT');
    }
    const source = stageSummarySourceSnapshot(
      book, normalized.startSectionId, normalized.endSectionId,
    );
    if (source.fingerprint !== expectedSourceFingerprint) {
      throw new Error('STAGE_SUMMARY_SOURCE_STALE');
    }
    const now = new Date().toISOString();
    const previous = index >= 0 ? stageSummaries[index] : null;
    const item = {
      ...normalized,
      sourceFingerprint: source.fingerprint,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (index >= 0) stageSummaries[index] = item;
    else stageSummaries.push(item);
    throwIfAborted(signal);
    await writeBookUnlocked(safeBookId, book);
    return {
      item: stageSummaryPublicView(book, item),
      stageSummaryRevision: stageSummaryRevision(book),
    };
  }, { signal });
}

async function saveStageSummary(bookId, input, {
  expectedStageSummaryRevision, signal,
} = {}) {
  const safeBookId = safeId(bookId);
  const normalized = normalizeStageSummaryInput(input ?? {});
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId, { signal });
    assertStageSummaryRevision(book, expectedStageSummaryRevision);
    const stageSummaries = normalizedStoredStageSummaries(book);
    const index = stageSummaries.findIndex((item) => item.id === normalized.id);
    if (index < 0 && stageSummaries.length >= MAX_STAGE_SUMMARIES_PER_BOOK) {
      throw new Error('STAGE_SUMMARY_LIMIT');
    }
    const source = stageSummarySourceSnapshot(
      book, normalized.startSectionId, normalized.endSectionId,
    );
    const now = new Date().toISOString();
    const previous = index >= 0 ? stageSummaries[index] : null;
    const item = {
      ...normalized,
      sourceFingerprint: source.fingerprint,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (index >= 0) stageSummaries[index] = item;
    else stageSummaries.push(item);
    throwIfAborted(signal);
    await writeBookUnlocked(safeBookId, book);
    return {
      item: stageSummaryPublicView(book, item),
      stageSummaryRevision: stageSummaryRevision(book),
    };
  }, { signal });
}

async function deleteStageSummary(bookId, stageSummaryId, {
  expectedStageSummaryRevision, signal,
} = {}) {
  if (typeof stageSummaryId !== 'string'
    || !STAGE_SUMMARY_ID_PATTERN.test(stageSummaryId)) {
    throw new Error('BAD_STAGE_SUMMARY_ID');
  }
  const safeBookId = safeId(bookId);
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId, { signal });
    assertStageSummaryRevision(book, expectedStageSummaryRevision);
    const stageSummaries = normalizedStoredStageSummaries(book);
    const index = stageSummaries.findIndex((item) => item.id === stageSummaryId);
    if (index < 0) throw new Error('STAGE_SUMMARY_NOT_FOUND');
    const [item] = stageSummaries.splice(index, 1);
    throwIfAborted(signal);
    await writeBookUnlocked(safeBookId, book);
    return {
      item: stageSummaryPublicView(book, item),
      stageSummaryRevision: stageSummaryRevision(book),
    };
  }, { signal });
}

async function readBookMemory(bookId, { signal } = {}) {
  const safeBookId = safeId(bookId);
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    await recoverReferencedStructureTransactions(safeBookId, {
      signal,
      invalidBookReferencesError: 'STORAGE_DATA_INVALID',
      invalidSectionReferencesError: 'STORAGE_DATA_INVALID',
    });
    throwIfAborted(signal);
    const book = await readBook(safeBookId, { signal });
    return bookMemoryLibraryView(book);
  }, { signal });
}

async function deactivateMemoryFact(bookId, factId, {
  expectedMemoryRevision, signal,
} = {}) {
  if (typeof factId !== 'string' || !MEMORY_ID_PATTERN.test(factId)) {
    throw new Error('BAD_MEMORY_FACT_ID');
  }
  if (typeof expectedMemoryRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedMemoryRevision)) {
    throw new Error('BAD_MEMORY_REVISION');
  }
  const safeBookId = safeId(bookId);
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    await recoverReferencedStructureTransactions(safeBookId, {
      signal,
      invalidBookReferencesError: 'STORAGE_DATA_INVALID',
      invalidSectionReferencesError: 'STORAGE_DATA_INVALID',
    });
    throwIfAborted(signal);
    const book = await readBook(safeBookId, { signal });
    if (bookMemoryRevision(book) !== expectedMemoryRevision) {
      throw new Error('MEMORY_REVISION_CONFLICT');
    }
    const memory = normalizedStoredBookMemory(book);
    const fact = memory.facts.find((item) => item.id === factId);
    if (!fact) throw new Error('MEMORY_FACT_NOT_FOUND');
    if (fact.status === 'active') {
      fact.status = 'stale';
      fact.updatedAt = new Date().toISOString();
      throwIfAborted(signal);
      await writeBookUnlocked(safeBookId, book);
    }
    return {
      fact,
      memoryRevision: bookMemoryRevision(book),
    };
  }, { signal });
}

function memoryCandidateId(sectionId, chapterId, bodyFingerprint, candidate) {
  return `memory_${createHash('sha256').update(JSON.stringify({
    sectionId, chapterId, bodyFingerprint,
    kind: candidate.kind, subject: candidate.subject,
    predicate: candidate.predicate, object: candidate.object,
  }), 'utf8').digest('hex').slice(0, 32)}`;
}

// 摘要、剧情路标、人物与 AI 标题都来自某一版正文。正文实际变化后，
// 继续保留这些派生信息会让下一章提示词混入已经撤销的剧情。失效发生在
// 正文写入同一锁域内；相同文本的重复版本或游标切换则保留已有 digest。
async function invalidateChapterDerivedData(
  bookId, sectionId, chapterId, { book, section, chapter, signal } = {},
) {
  let sectionChanged = false;
  let otherCompleted;
  const readOtherCompleted = async () => {
    if (otherCompleted === undefined) {
      otherCompleted = await hasOtherCompletedChapter(
        bookId, sectionId, section, chapterId, { signal },
      );
    }
    return otherCompleted;
  };

  const summaryRecorded = Boolean(chapter.summary)
    || (section.chapterSummaries
      && typeof section.chapterSummaries === 'object'
      && !Array.isArray(section.chapterSummaries)
      && Object.prototype.hasOwnProperty.call(section.chapterSummaries, chapterId));
  if (summaryRecorded) {
    const summaries = await ensureChapterSummaries(bookId, section, { signal });
    delete summaries[chapterId];
    section.summary = buildSectionSummary(section);
    sectionChanged = true;
  } else if (section.summary && !await readOtherCompleted()) {
    // 空分部里没有任何其它已完成章节时，原有聚合摘要不可能
    // 属于新落盘的首章。清理老版或手工改盘留下的无归属摘要，
    // 避免 digest 失败后把它当作新正文前情。
    section.chapterSummaries = {};
    section.summary = '';
    sectionChanged = true;
  }

  chapter.summary = '';
  chapter.progress = '';
  chapter.handoff = emptyChapterHandoff();
  chapter.characters = [];
  const oldMemoryCandidateIds = new Set(
    Array.isArray(chapter.memoryCandidates)
      ? chapter.memoryCandidates.map((candidate) => candidate?.id).filter(Boolean)
      : [],
  );
  chapter.memoryCandidates = [];
  const memory = normalizedStoredBookMemory(book);
  const staleAt = new Date().toISOString();
  const publishedFingerprint = chapter.published?.bodyFingerprint;
  invalidateWorldGateSources(book, {
    sectionId, chapterId, bodyFingerprint: chapter.bodyFingerprint,
    preserveFingerprint: publishedFingerprint,
  });
  invalidatePromiseEvidenceSources(book, {
    sectionId, chapterId, bodyFingerprint: chapter.bodyFingerprint,
    preserveFingerprint: publishedFingerprint,
  });
  for (const fact of memory.facts) {
    if (fact.status === 'active'
      && fact.source.sectionId === sectionId
      && fact.source.chapterId === chapterId
      && fact.source.bodyFingerprint === chapter.bodyFingerprint
      // 当前正文正好是读者已看到的锁定版时，后续本地改写
      // 只形成未发布草稿；已确认事实仍锚定发布快照，不随草稿失效。
      && fact.source.bodyFingerprint !== publishedFingerprint) {
      fact.status = 'stale';
      fact.updatedAt = staleAt;
    }
  }
  if (oldMemoryCandidateIds.size) {
    memory.rejectedCandidateIds = memory.rejectedCandidateIds.filter(
      (id) => !oldMemoryCandidateIds.has(id),
    );
  }
  if (chapter.titleSource === 'ai') {
    chapter.title = '';
    chapter.titleSource = 'default';
  }

  // 部名只会由“本部尚无其它已完成章节”时的 digest 自动生成；同样条件下
  // 改写该唯一正文时可确定其来源已经失效。手动部名和已有多章的稳定部名保留。
  if (section.titleSource === 'ai') {
    if (!await readOtherCompleted()) {
      section.title = '';
      section.titleSource = 'default';
      sectionChanged = true;
    }
  }

  if (sectionChanged) updateBookSectionSummary(book, section);

  // 分部/全书 progress 必须指向正文顺序中最后一个非空章节，
  // 而不是最近一次执行 digest 的章节。当前章路标清空后精确重算，
  // 既避免重写早期章节时误删后续路标，也能在清空末章时回退
  // 到上一个仍有正文的章节。
  const latestProgress = await latestProgressState(
    bookId, book, sectionId, section, chapterId, chapter, { signal },
  );
  if (section.progress !== latestProgress.sectionProgress) {
    section.progress = latestProgress.sectionProgress;
    sectionChanged = true;
  }
  book.progress = latestProgress.bookProgress;
  return { sectionChanged };
}

async function persistChapterBodyMutation(
  bookId, sectionId, chapterId, { book, section, chapter, sectionChanged },
) {
  // 先推进 book 删除锚点，再失效分部派生信息，正文最后提交。若中间写入
  // 失败，最多暂时缺少可重算的 digest；不会出现新正文已经落盘却仍携带
  // 旧剧情元数据，也不会让旧书架删除已经发生子文件变化的作品。
  await writeBookUnlocked(bookId, book);
  if (sectionChanged) {
    await atomicWriteJson(join(bookDir(bookId), sectionId, 'section.json'), section);
  }
  await writeChapterFile(bookId, sectionId, chapterId, chapter);
}

function memoryCandidateCanAutoAccept(candidate, chapterContent) {
  if (!candidate || candidate.importance !== 5 || typeof chapterContent !== 'string') {
    return false;
  }
  const contains = (value) => typeof value === 'string'
    && value.length >= 2 && value.length <= 80 && chapterContent.includes(value);
  // 主体与事实值都必须能在正文中精确定位。模型给出的抽象证据或长解释
  // 不能触发自动采纳；拿不准的候选继续留给作者确认。
  return contains(candidate.subject) && contains(candidate.object);
}

function autoAcceptMemoryCandidates(book, chapter, sectionId, chapterId, now) {
  const memory = normalizedStoredBookMemory(book);
  const content = currentText(chapter.body);
  for (const candidate of chapter.memoryCandidates ?? []) {
    if (!memoryCandidateCanAutoAccept(candidate, content)
      || memory.rejectedCandidateIds.includes(candidate.id)
      || memory.facts.some((fact) => fact.id === candidate.id)) continue;
    const conflicts = memory.facts.some((fact) => fact.status === 'active'
      && fact.kind === candidate.kind && fact.subject === candidate.subject
      && fact.predicate === candidate.predicate && fact.object !== candidate.object);
    if (conflicts || memory.facts.length >= MAX_MEMORY_FACTS_PER_BOOK) continue;
    memory.facts.push({
      id: candidate.id,
      kind: candidate.kind,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      evidence: candidate.evidence,
      importance: candidate.importance,
      ...(candidate.aliases?.length ? { aliases: candidate.aliases } : {}),
      ...(candidate.details ? { details: candidate.details } : {}),
      status: 'active', autoAccepted: true,
      source: {
        sectionId, chapterId, chapterIndex: chapter.index,
        bodyFingerprint: chapter.bodyFingerprint,
      },
      confirmedAt: now, updatedAt: now,
    });
  }
}

async function applyChapterDigest(bookId, sectionId, chapterId, digest, {
  expectedBodyFingerprint,
  signal,
} = {}) {
  return withChapterWriteLocks(bookId, sectionId, chapterId, async (safeBookId, safeSectionId, safeChapterId) => {
    await assertChapterReferenced(safeBookId, safeSectionId, safeChapterId, { signal });
    const chapter = await readChapter(safeBookId, safeSectionId, safeChapterId, { signal });
    if (expectedBodyFingerprint && chapter.bodyFingerprint !== expectedBodyFingerprint) {
      return { applied: false, chapter };
    }
    const section = await readSection(safeBookId, safeSectionId, { signal });
    const book = await readBook(safeBookId, { signal });
    const d = digest && typeof digest === 'object' ? digest : {};

    if (typeof d.chapterTitle === 'string' && d.chapterTitle && chapter.titleSource === 'default') {
      chapter.title = d.chapterTitle;
      chapter.titleSource = 'ai';
    }
    if (typeof d.summary === 'string' && d.summary) chapter.summary = d.summary;
    if (typeof d.progress === 'string' && d.progress) chapter.progress = d.progress;
    if (d.digestParsed !== false && d.digestHandoffParsed !== false
      && d.handoff !== undefined) {
      chapter.handoff = normalizeChapterHandoff(d.handoff);
    }
    if (Array.isArray(d.newCharacters)
      && d.digestParsed !== false
      && d.digestCharactersParsed !== false) {
      // 人物与摘要一样是当前正文的派生快照。重复 digest 必须以最新完整
      // 提取结果替换，不能把不同响应累加成后续提示词里的“幽灵人物”。
      // 解析失败或字段缺失时则保留同一正文已有快照。
      const nextCharacters = [];
      const known = new Set();
      for (const character of d.newCharacters) {
        if (nextCharacters.length >= MAX_STORED_CHARACTERS) break;
        if (!character
          || typeof character.name !== 'string'
          || typeof character.role !== 'string'
          || typeof character.desc !== 'string') continue;
        const key = `${character.name}\0${character.role}`;
        if (!known.has(key)) {
          nextCharacters.push({
            name: character.name,
            role: character.role,
            desc: character.desc,
          });
          known.add(key);
        }
      }
      chapter.characters = nextCharacters;
    }
    if (Array.isArray(d.memoryCandidates)
      && d.digestParsed !== false
      && d.digestMemoryCandidatesParsed !== false) {
      const extractedAt = new Date().toISOString();
      const seenCandidates = new Set();
      chapter.memoryCandidates = sanitizeMemoryCandidates(d.memoryCandidates).flatMap(
        (candidate) => {
          const id = memoryCandidateId(
            safeSectionId, safeChapterId, chapter.bodyFingerprint, candidate,
          );
          if (seenCandidates.has(id)) return [];
          seenCandidates.add(id);
          return [{
            id, ...candidate,
            sourceFingerprint: chapter.bodyFingerprint,
            extractedAt,
          }];
        },
      );
    }

    // 只自动采纳正文中主体和值均可精确定位的 importance=5 候选；其余仍是
    // pending。自动项可在记忆库中否决，来源正文变化时沿用现有失效机制。
    autoAcceptMemoryCandidates(
      book, chapter, safeSectionId, safeChapterId, new Date().toISOString(),
    );

    if (typeof d.sectionTitle === 'string' && d.sectionTitle && section.titleSource === 'default') {
      let hasOtherCompleted = false;
      for (const cid of section.chapters || []) {
        if (cid === safeChapterId) continue;
        const other = await readChapterCompletionMetadata(
          safeBookId, safeSectionId, cid, { signal },
        );
        if (other.hasContent) {
          hasOtherCompleted = true;
          break;
        }
      }
      if (!hasOtherCompleted) {
        section.title = d.sectionTitle;
        section.titleSource = 'ai';
      }
    }
    if (typeof d.summary === 'string' && d.summary) {
      const summaries = await ensureChapterSummaries(safeBookId, section, { signal });
      const logicalChapterIndex = sectionChapterIds(section).indexOf(safeChapterId) + 1;
      Object.defineProperty(summaries, safeChapterId, {
        value: { index: logicalChapterIndex, summary: d.summary },
        enumerable: true, writable: true, configurable: true,
      });
      section.summary = buildSectionSummary(section);
    }
    if (typeof d.progress === 'string' && d.progress) {
      // 重写早期章节时，它的 digest 只更新本章路标；分部和全书
      // 仍应跟随正文顺序中最后的非空章节，避免下一章从旧时间点续写。
      const latestProgress = await latestProgressState(
        safeBookId, book, safeSectionId, section, safeChapterId, chapter, { signal },
      );
      section.progress = latestProgress.sectionProgress;
      book.progress = latestProgress.bookProgress;
    }

    updateBookSectionSummary(book, section);

    // 三个文件组成同一次摘要提交；取消只允许在首个写入前生效。
    // 先落一个小型恢复标记；book.json 先写既提交 progress，也先推进删除
    // 锚点。后续子文件失败时，下一次启动、读取作品树或章节写入会按当前
    // 章节文件重建聚合字段，避免 chapter 已更新而 section 永久漏掉该摘要。
    throwIfAborted(signal);
    const digestTransaction = chapterDigestTransactionPath(safeBookId, safeSectionId);
    await atomicWriteJson(digestTransaction, {
      format: CHAPTER_DIGEST_TRANSACTION_FORMAT,
      version: CHAPTER_DIGEST_TRANSACTION_VERSION,
      bookId: safeBookId,
      sectionId: safeSectionId,
      chapterId: safeChapterId,
      bodyFingerprint: chapter.bodyFingerprint,
    });
    await writeBookUnlocked(safeBookId, book);
    await writeChapterFile(safeBookId, safeSectionId, safeChapterId, chapter);
    await atomicWriteJson(join(bookDir(safeBookId), safeSectionId, 'section.json'), section);
    await clearCommittedTransaction(
      digestTransaction, join(bookDir(safeBookId), safeSectionId),
    );
    return { applied: true, chapter, section, book };
  }, { signal });
}

async function decideMemoryCandidate(bookId, sectionId, chapterId, candidateId, {
  action,
  expectedBodyFingerprint,
  expectedMemoryRevision,
  signal,
} = {}) {
  if (typeof candidateId !== 'string' || !MEMORY_ID_PATTERN.test(candidateId)) {
    throw new Error('BAD_MEMORY_CANDIDATE_ID');
  }
  if (!['accept', 'reject', 'replace'].includes(action)) {
    throw new Error('BAD_MEMORY_DECISION');
  }
  if (typeof expectedBodyFingerprint !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedBodyFingerprint)) {
    throw new Error('BAD_MEMORY_BODY_FINGERPRINT');
  }
  if (typeof expectedMemoryRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedMemoryRevision)) {
    throw new Error('BAD_MEMORY_REVISION');
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
        throw new Error('MEMORY_SOURCE_STALE');
      }
      if (bookMemoryRevision(book) !== expectedMemoryRevision) {
        throw new Error('MEMORY_REVISION_CONFLICT');
      }
      const candidate = chapter.memoryCandidates.find((item) => item.id === candidateId);
      if (!candidate || candidate.sourceFingerprint !== chapter.bodyFingerprint) {
        throw new Error('MEMORY_CANDIDATE_NOT_FOUND');
      }
      if (action !== 'reject' && chapter.published
        && chapter.published.bodyFingerprint !== chapter.bodyFingerprint) {
        throw new Error('MEMORY_SOURCE_UNPUBLISHED');
      }
      const memory = normalizedStoredBookMemory(book);
      const existing = memory.facts.find((fact) => fact.id === candidateId);
      const rejectedIndex = memory.rejectedCandidateIds.indexOf(candidateId);
      if (action === 'reject') {
        if (existing?.status === 'active' && existing.autoAccepted !== true) {
          throw new Error('MEMORY_DECISION_CONFLICT');
        }
        // 自动采纳项允许作者事后否决；人工确认的 active 事实仍需通过
        // 冲突/替换流程，避免误触直接删除作者已经确认的长期事实。
        if (existing?.status === 'active' && existing.autoAccepted === true) {
          memory.facts.splice(memory.facts.indexOf(existing), 1);
        }
        if (rejectedIndex < 0) {
          if (memory.rejectedCandidateIds.length >= MAX_MEMORY_REJECTIONS_PER_BOOK) {
            throw new Error('MEMORY_REJECTION_LIMIT');
          }
          memory.rejectedCandidateIds.push(candidateId);
        }
        throwIfAborted(signal);
        await writeBookUnlocked(safeBookId, book);
        return {
          candidate: { ...candidate, status: 'rejected' },
          candidates: chapterMemoryCandidatesView(book, chapter),
          memoryRevision: bookMemoryRevision(book),
        };
      }

      const conflicts = memory.facts.filter((fact) =>
        fact.status === 'active'
        && fact.id !== candidateId
        && fact.kind === candidate.kind
        && fact.subject === candidate.subject
        && fact.predicate === candidate.predicate
        && fact.object !== candidate.object);
      if (conflicts.length && action !== 'replace') throw new Error('MEMORY_CONFLICT');
      const now = new Date().toISOString();
      if (action === 'replace') {
        for (const fact of conflicts) {
          fact.status = 'superseded';
          fact.updatedAt = now;
        }
      }
      if (rejectedIndex >= 0) memory.rejectedCandidateIds.splice(rejectedIndex, 1);
      let fact = existing;
      if (!fact) {
        if (memory.facts.length >= MAX_MEMORY_FACTS_PER_BOOK) {
          throw new Error('MEMORY_FACT_LIMIT');
        }
        fact = {
          id: candidate.id,
          kind: candidate.kind,
          subject: candidate.subject,
          predicate: candidate.predicate,
          object: candidate.object,
          evidence: candidate.evidence,
          importance: candidate.importance,
          ...(candidate.aliases?.length ? { aliases: candidate.aliases } : {}),
          ...(candidate.details ? { details: candidate.details } : {}),
          status: 'active',
          source: {
            sectionId: safeSectionId,
            chapterId: safeChapterId,
            chapterIndex: chapter.index,
            bodyFingerprint: chapter.bodyFingerprint,
          },
          confirmedAt: now,
          updatedAt: now,
        };
        memory.facts.push(fact);
      } else {
        fact.status = 'active';
        fact.updatedAt = now;
      }
      throwIfAborted(signal);
      await writeBookUnlocked(safeBookId, book);
      return {
        candidate: { ...candidate, status: 'accepted' },
        candidates: chapterMemoryCandidatesView(book, chapter),
        fact,
        memoryRevision: bookMemoryRevision(book),
      };
    }, { signal });
}


  return Object.freeze({
    applyChapterDigest,
    bookMemoryLibraryView,
    bookMemoryRevision,
    buildSectionSummary,
    chapterMemoryCandidatesView,
    deactivateMemoryFact,
    decideMemoryCandidate,
    deleteStageSummary,
    ensureChapterSummaries,
    hasOtherCompletedChapter,
    invalidateChapterDerivedData,
    invalidateDeletedChapterMemory,
    latestCompletedChapterInSection,
    latestProgressState,
    normalizedStoredBookMemory,
    normalizedStoredStageSummaries,
    persistChapterBodyMutation,
    readBookMemory,
    readChapterCompletionMetadata,
    readChapterDigestSummary,
    readStageSummarySource,
    recoverChapterDigestTransaction,
    saveGeneratedStageSummary,
    saveStageSummary,
    stageSummaryRevision,
    updateBookSectionSummary,
  });
}
