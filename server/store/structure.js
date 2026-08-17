import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  MAX_BOOK_DIRECTORY_ENTRIES, MAX_BOOK_SECTIONS, MAX_ID_CHARS,
  MAX_SECTION_CHAPTERS, MAX_STRUCTURE_RECOVERY_FAILURES, MAX_TITLE_CHARS,
  MAX_TOTAL_BOOK_CHAPTERS, MAX_VERSION_TEXT_CHARS,
} from '../limits.js';
import {
  BOOK_STRUCTURE_TRANSACTION_FILE, CHAPTER_DIGEST_TRANSACTION_FILE,
  CHAPTER_DIGEST_TRANSACTION_FORMAT, CHAPTER_DIGEST_TRANSACTION_VERSION,
  SECTION_STRUCTURE_TRANSACTION_FILE, STRUCTURE_TRANSACTION_FORMAT,
  STRUCTURE_TRANSACTION_VERSION,
} from './structure-constants.js';
import {
  assertExpectedVersionRevision, contentFingerprint, currentText, emptyVersioned,
} from './versioned.js';
import { mapWithConcurrency, withStoreLock } from './concurrency.js';
import { throwIfAborted } from './abort.js';
import { CHAPTER_PLAN_FIELDS, emptyChapterPlan } from '../chapter-plan-schema.js';
import { chapterHandoffHasContent, emptyChapterHandoff } from '../chapter-handoff-schema.js';

export function createStructureStore(dependencies) {
  const {
    CHAPTER_TREE_JSON_PROJECTION, SECTION_TREE_JSON_PROJECTION, TITLE_SOURCES,
    assertStoredRecord, atomicWriteJson, bookDir, bookJsonLockKey, bookSectionIds,
    booksDir, buildSectionSummary, chapterFileLockKey, countBookChapterReferences,
    ensureDirectory, inspectJsonFile, invalidateDeletedChapterMemory, isObjectRecord,
    migrateChapterInPlace, normalizeEntityTitle, normalizeStoredChapter,
    normalizeTitleInput, readBook, readSafeDirectory, readSectionChapterReferences,
    readStoredJson, readStoredJsonProjection, recoverChapterDigestTransaction, safeId,
    sectionChapterIds, sectionFileLockKey, sectionPlanContextRevision,
    serializationSettingsView, storageIdPathKey, stripGeneratedTitleDescription,
    syncDirectory, touchBookUnlocked,
    updateBookSectionSummary, validateStoredBook, validateStoredSection,
    writeBookUnlocked,
  } = dependencies;

const pad2 = (n) => String(n).padStart(2, '0');
const CN_NUM = '零一二三四五六七八九十百千两';

function allocateSectionId(index, sectionIds) {
  const occupiedPaths = new Set(sectionIds.map(storageIdPathKey));
  // 导入备份会保留内部 ID，它不一定与当前引用位置连续。候选数比已有
  // 引用多一个，且合法引用已按大小写不敏感路径去重，因此必能找到空位。
  for (let offset = 0; offset <= sectionIds.length; offset += 1) {
    const candidate = `section-${pad2(index + offset)}`;
    if (!occupiedPaths.has(storageIdPathKey(candidate))) return candidate;
  }
  throw new Error('BOOK_SECTION_LIMIT');
}

const INTERNAL_CHAPTER_ID_PATTERN = /^chapter-(?:\d+|u-\d+)$/;

function allocateChapterId(chapterIds) {
  const occupiedPaths = new Set(chapterIds.map(storageIdPathKey));
  let maxNumericSequence = null;
  for (const chapterId of chapterIds) {
    const match = typeof chapterId === 'string'
      ? chapterId.match(/^chapter-(\d+)$/)
      : null;
    if (!match) continue;
    // ID 最长可达 128 字符，不能先转成 Number；否则合法长数字会变成
    // 科学计数法，继而生成带“+”的非法存储路径。
    const sequence = BigInt(match[1]);
    if (maxNumericSequence === null || sequence > maxNumericSequence) {
      maxNumericSequence = sequence;
    }
  }

  const numericCandidate = maxNumericSequence === null
    ? 'chapter-01'
    : `chapter-${(maxNumericSequence + 1n).toString().padStart(2, '0')}`;
  if (numericCandidate.length <= MAX_ID_CHARS
    && !occupiedPaths.has(storageIdPathKey(numericCandidate))) {
    return numericCandidate;
  }

  // 只有数字后继超出 ID 长度，或大小写变体占用了候选路径时才进入备用
  // 命名空间。当前引用至多占用 chapterIds.length 个候选，扫描 n+1 个
  // 即可确定性找到空位，不依赖随机碰撞概率。
  const fallbackStart = chapterIds.length + 1;
  for (let offset = 0; offset <= chapterIds.length; offset += 1) {
    const candidate = `chapter-u-${pad2(fallbackStart + offset)}`;
    if (!occupiedPaths.has(storageIdPathKey(candidate))) return candidate;
  }
  throw new Error('SECTION_CHAPTER_LIMIT');
}

const bookStructureTransactionPath = (bookId) =>
  join(bookDir(bookId), BOOK_STRUCTURE_TRANSACTION_FILE);
const sectionStructureTransactionPath = (bookId, sectionId) =>
  join(bookDir(bookId), safeId(sectionId), SECTION_STRUCTURE_TRANSACTION_FILE);
const chapterDigestTransactionPath = (bookId, sectionId) =>
  join(bookDir(bookId), safeId(sectionId), CHAPTER_DIGEST_TRANSACTION_FILE);

function structureTransactionBase(value, type, bookId, sectionId) {
  return isObjectRecord(value)
    && value.format === STRUCTURE_TRANSACTION_FORMAT
    && value.version === STRUCTURE_TRANSACTION_VERSION
    && value.type === type
    && value.bookId === bookId
    && (sectionId === undefined || value.sectionId === sectionId);
}

function hasExactKeys(value, expectedKeys) {
  if (!isObjectRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isSafeStoredId(value) {
  try { safeId(value); return true; }
  catch { return false; }
}

function isValidPendingSection(section, sectionId) {
  const sequenceMatch = typeof sectionId === 'string'
    ? sectionId.match(/^section-(\d+)$/)
    : null;
  const sequence = sequenceMatch ? Number(sequenceMatch[1]) : Number.NaN;
  return hasExactKeys(section, [
    'id', 'index', 'title', 'titleSource', 'outline', 'characters',
    'summary', 'progress', 'chapters', 'chapterSummaries',
  ])
    && isSafeStoredId(sectionId)
    && Number.isSafeInteger(sequence)
    && section.id === sectionId
    && Number.isInteger(section.index)
    && section.index >= 1
    && section.index <= MAX_BOOK_SECTIONS
    // 新建从逻辑位置开始向后避让导入历史 ID；最多跨过当前全部引用。
    // 恢复文件仍只接受这个有限窗口内的纯数字 ID，拒绝任意路径或巨数。
    && sequence >= section.index
    && sequence <= section.index + MAX_BOOK_SECTIONS
    && typeof section.title === 'string'
    && section.title.length <= MAX_TITLE_CHARS
    && section.title.trim() === section.title
    && TITLE_SOURCES.has(section.titleSource)
    && hasExactKeys(section.outline, ['content', 'history'])
    && typeof section.outline.content === 'string'
    && section.outline.content.length <= MAX_VERSION_TEXT_CHARS
    && section.outline.content.trim() === section.outline.content
    && Array.isArray(section.outline.history)
    && section.outline.history.length === 0
    && Array.isArray(section.characters)
    && section.characters.length === 0
    && section.summary === ''
    && section.progress === ''
    && Array.isArray(section.chapters)
    && section.chapters.length === 0
    && hasExactKeys(section.chapterSummaries, []);
}

function isEmptyPendingChapterHandoff(value) {
  if (value === undefined) return true;
  try {
    return !chapterHandoffHasContent(value);
  } catch {
    return false;
  }
}

function isValidPendingChapter(chapter, chapterId) {
  const legacyKeys = [
    'id', 'index', 'title', 'titleSource', 'body', 'content',
    'bodyFingerprint', 'characters', 'summary', 'progress', 'status',
  ];
  const modernKeys = [...legacyKeys, 'handoff'];
  // 升级前已经落盘、但尚未清理的新增章事务没有 memoryCandidates。
  // 事务版本仍为 1，必须兼容重放；除此之外仍坚持精确字段白名单。
  return (hasExactKeys(chapter, legacyKeys)
    || hasExactKeys(chapter, modernKeys)
    || hasExactKeys(chapter, [...legacyKeys, 'memoryCandidates'])
    || hasExactKeys(chapter, [...modernKeys, 'memoryCandidates'])
    || hasExactKeys(chapter, [...legacyKeys, 'plan'])
    || hasExactKeys(chapter, [...modernKeys, 'plan'])
    || hasExactKeys(chapter, [...legacyKeys, 'memoryCandidates', 'plan'])
    || hasExactKeys(chapter, [...modernKeys, 'memoryCandidates', 'plan']))
    && isSafeStoredId(chapterId)
    && INTERNAL_CHAPTER_ID_PATTERN.test(chapterId)
    && chapter.id === chapterId
    && Number.isInteger(chapter.index)
    && chapter.index >= 1
    && chapter.index <= MAX_SECTION_CHAPTERS
    && typeof chapter.title === 'string'
    && chapter.title.length <= MAX_TITLE_CHARS
    && chapter.title.trim() === chapter.title
    && TITLE_SOURCES.has(chapter.titleSource)
    && hasExactKeys(chapter.body, ['versions', 'cursor'])
    && Array.isArray(chapter.body.versions)
    && chapter.body.versions.length === 1
    && chapter.body.versions[0] === ''
    && chapter.body.cursor === 0
    && chapter.content === ''
    && chapter.bodyFingerprint === contentFingerprint('')
    && Array.isArray(chapter.characters)
    && chapter.characters.length === 0
    && chapter.summary === ''
    && chapter.progress === ''
    && isEmptyPendingChapterHandoff(chapter.handoff)
    && chapter.status === 'done'
    && (chapter.memoryCandidates === undefined
      || (Array.isArray(chapter.memoryCandidates)
        && chapter.memoryCandidates.length === 0))
    && (chapter.plan === undefined
      || (hasExactKeys(chapter.plan, CHAPTER_PLAN_FIELDS)
        && CHAPTER_PLAN_FIELDS.every((field) => chapter.plan[field] === ''))
      || (hasExactKeys(chapter.plan, [...CHAPTER_PLAN_FIELDS, 'scenes'])
        && CHAPTER_PLAN_FIELDS.every((field) => chapter.plan[field] === '')
        && Array.isArray(chapter.plan.scenes) && chapter.plan.scenes.length === 0));
}

function isValidBookStructureTransaction(value, bookId) {
  return structureTransactionBase(value, 'add-section', bookId)
    && hasExactKeys(value, [
      'format', 'version', 'type', 'bookId', 'sectionId', 'section',
    ])
    && typeof value.sectionId === 'string'
    && isValidPendingSection(value.section, value.sectionId);
}

function isValidSectionStructureTransaction(value, bookId, sectionId) {
  const isAdd = structureTransactionBase(value, 'add-chapter', bookId, sectionId)
    && hasExactKeys(value, [
      'format', 'version', 'type', 'bookId', 'sectionId', 'chapterId', 'chapter',
    ])
    && typeof value.chapterId === 'string'
    && isValidPendingChapter(value.chapter, value.chapterId);
  const isDelete = structureTransactionBase(value, 'delete-chapter', bookId, sectionId)
    && hasExactKeys(value, [
      'format', 'version', 'type', 'bookId', 'sectionId', 'chapterId',
    ])
    && typeof value.chapterId === 'string'
    // 备份允许保留任意安全的历史 ID；删除事务也必须能恢复这些章节，
    // 否则一次合法删除会留下永久阻塞该分部的无效事务。
    && isSafeStoredId(value.chapterId);
  return isAdd || isDelete;
}

function isValidChapterDigestTransaction(value, bookId, sectionId) {
  return isObjectRecord(value)
    && hasExactKeys(value, [
      'format', 'version', 'bookId', 'sectionId', 'chapterId', 'bodyFingerprint',
    ])
    && value.format === CHAPTER_DIGEST_TRANSACTION_FORMAT
    && value.version === CHAPTER_DIGEST_TRANSACTION_VERSION
    && value.bookId === bookId
    && value.sectionId === sectionId
    && isSafeStoredId(value.chapterId)
    && typeof value.bodyFingerprint === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(value.bodyFingerprint);
}

async function readStructureTransaction(absPath, validate) {
  const inspected = await inspectJsonFile(absPath);
  if (inspected.status === 'missing') return null;
  if (inspected.status === 'unsafe') throw new Error('STORAGE_PATH_UNSAFE');
  if (inspected.status !== 'ok') throw new Error(`STRUCTURE_TRANSACTION_${inspected.status.toUpperCase()}`);
  if (!validate(inspected.value)) throw new Error('STRUCTURE_TRANSACTION_INVALID');
  return inspected.value;
}

async function clearCommittedTransaction(absPath, parent) {
  try {
    await rm(absPath, { force: true });
    await syncDirectory(parent, { afterCommit: true });
  } catch (err) {
    // 业务文件已提交；保留事务可在下次启动时幂等重放，不能把成功伪装成失败。
    console.warn(`[store] committed transaction cleanup failed (${err?.code || 'UNKNOWN'})`);
  }
}

async function recoverBookStructureTransaction(bookId) {
  const safeBookId = safeId(bookId);
  const transactionPath = bookStructureTransactionPath(safeBookId);
  const tx = await readStructureTransaction(
    transactionPath,
    (value) => isValidBookStructureTransaction(value, safeBookId),
  );
  if (!tx) return null;

  const book = await readBook(safeBookId);
  const sectionIds = bookSectionIds(book);
  const needsReference = !sectionIds.includes(tx.sectionId);
  if (needsReference && sectionIds.length >= MAX_BOOK_SECTIONS) {
    throw new Error('BOOK_SECTIONS_LIMIT_EXCEEDED');
  }
  const sectionRoot = join(bookDir(safeBookId), tx.sectionId);
  const inspectedSection = await inspectJsonFile(join(sectionRoot, 'section.json'));
  if (inspectedSection.status !== 'missing' && (inspectedSection.status !== 'ok'
    || !isObjectRecord(inspectedSection.value)
    || inspectedSection.value.id !== tx.sectionId
    // 索引尚未提交时，同 ID 目标只能是本事务此前写入的精确载荷。
    // 若内容不同，不能把碰巧同名的孤立数据接入作品，更不能覆盖它。
    || (needsReference && !isDeepStrictEqual(inspectedSection.value, tx.section)))) {
    throw new Error('STRUCTURE_TRANSACTION_TARGET_CONFLICT');
  }

  // 事务重放也先推进删除锚点，再创建任何子目录或子文件。若是尚未
  // 引用的新部，先只更新时间，避免子文件失败时留下“内容变了但锚点没变”。
  await writeBookUnlocked(safeBookId, book);
  if (inspectedSection.status === 'missing') {
    await ensureDirectory(sectionRoot);
    await atomicWriteJson(join(sectionRoot, 'section.json'), tx.section);
  }
  if (needsReference) {
    book.sections.push(tx.sectionId);
    await writeBookUnlocked(safeBookId, book);
  }
  await clearCommittedTransaction(transactionPath, bookDir(safeBookId));
  // 提交边界之后不再执行可能失败的读盘。实际新建请求的载荷已经过
  // 事务校验；残留已提交事务的 result 不会被当成本次新建成功返回。
  return { type: tx.type, result: normalizeEntityTitle(structuredClone(tx.section), '部') };
}

async function recoverSectionStructureTransaction(bookId, sectionId) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  const sectionRoot = join(bookDir(safeBookId), safeSectionId);
  const transactionPath = sectionStructureTransactionPath(safeBookId, safeSectionId);
  const tx = await readStructureTransaction(
    transactionPath,
    (value) => isValidSectionStructureTransaction(
      value, safeBookId, safeSectionId,
    ),
  );
  if (!tx) return null;

  const book = await readBook(safeBookId);
  const sectionIds = bookSectionIds(book);
  if (!sectionIds.includes(safeSectionId)) throw new Error('SECTION_NOT_FOUND');
  const section = await readSection(safeBookId, safeSectionId);
  const chapterIds = sectionChapterIds(section);
  const chapterPath = join(sectionRoot, `${tx.chapterId}.json`);
  if (tx.type === 'add-chapter') {
    if (!chapterIds.includes(tx.chapterId)) {
      if (chapterIds.length >= MAX_SECTION_CHAPTERS) {
        throw new Error('SECTION_CHAPTERS_LIMIT_EXCEEDED');
      }
      const totalChapters = await countBookChapterReferences(
        safeBookId, sectionIds, section,
      );
      if (totalChapters >= MAX_TOTAL_BOOK_CHAPTERS) {
        throw new Error('BOOK_CHAPTERS_LIMIT_EXCEEDED');
      }
    }
    const inspectedChapter = await inspectJsonFile(chapterPath);
    if (inspectedChapter.status !== 'missing' && (inspectedChapter.status !== 'ok'
      || !isObjectRecord(inspectedChapter.value)
      || inspectedChapter.value.id !== tx.chapterId
      // 已被索引引用说明事务已提交，后续编辑应保留；尚未引用时则必须
      // 与事务载荷完全相同，避免自动接入同名但无关的章节文件。
      || (!chapterIds.includes(tx.chapterId)
        && !isDeepStrictEqual(inspectedChapter.value, tx.chapter)))) {
      throw new Error('STRUCTURE_TRANSACTION_TARGET_CONFLICT');
    }
    // 先持久化作品级删除锚点，再让章节或分部子文件发生任何变化。
    // 即使进程在后续写入与事务清理之间退出，旧书架也不能删除含有
    // 新结构的作品。事务重放时重复推进锚点是安全的保守冲突。
    await writeBookUnlocked(safeBookId, book);
    if (inspectedChapter.status === 'missing') {
      await atomicWriteJson(chapterPath, tx.chapter);
    }
    if (!chapterIds.includes(tx.chapterId)) {
      section.chapters.push(tx.chapterId);
      await atomicWriteJson(join(sectionRoot, 'section.json'), section);
    }
    await clearCommittedTransaction(transactionPath, sectionRoot);
    return {
      type: tx.type,
      chapterId: tx.chapterId,
      result: migrateChapterInPlace(structuredClone(tx.chapter)),
      // writeBookUnlocked 会原地推进锚点；把提交值随事务结果返回，避免
      // 调用方在不可逆提交后再做一次可能因断连而失败的读盘。
      bookUpdatedAt: book.updatedAt,
    };
  }

  // 删除同样先推进作品锚点；随后删除引用或正文文件即使只完成一半，
  // 残留事务仍可恢复，而旧删除请求必然因锚点变化被拒绝。
  // 章节文件一旦删除就无法再从候选反查来源，因此必须在删除正文之前，
  // 把该章已确认的活动事实标记为失效，并清掉该章的拒绝记录。该变化与
  // 第一次 book.json 写入一起提交；即使随后在删引用/删文件时中断，
  // 重放也不会留下仍参与生成、但来源章节已经不存在的“幽灵事实”。
  const inspectedDeletedChapter = await inspectJsonFile(chapterPath);
  const removedReference = chapterIds.includes(tx.chapterId);
  if (removedReference) {
    section.chapters = section.chapters.filter((cid) => cid !== tx.chapterId);
    if (section.chapterSummaries && typeof section.chapterSummaries === 'object') {
      delete section.chapterSummaries[tx.chapterId];
      section.summary = buildSectionSummary(section);
    }
    updateBookSectionSummary(book, section);
  }
  invalidateDeletedChapterMemory(
    book, safeSectionId, tx.chapterId,
    inspectedDeletedChapter.status === 'ok' ? inspectedDeletedChapter.value : null,
    chapterIds.filter((id) => id !== tx.chapterId),
  );
  await writeBookUnlocked(safeBookId, book);
  if (removedReference) {
    await atomicWriteJson(join(sectionRoot, 'section.json'), section);
  }
  await rm(chapterPath, { force: true });
  await clearCommittedTransaction(transactionPath, sectionRoot);
  return { type: tx.type, chapterId: tx.chapterId, result: section };
}

// 调用方必须已持有 book-json 锁。作品树与备份都是跨多层文件的逻辑快照；
// 若直接读取已落盘但尚未重放的结构事务，就会展示或导出随后必然被恢复
// 删除的章节，也可能漏掉随后必然接入的分部/章节。先恢复作品级事务，再
// 依据最新 book 索引恢复所有受引用分部，确保快照对应可恢复的最终状态。
async function recoverReferencedStructureTransactions(bookId, {
  signal,
  invalidBookReferencesError,
  invalidSectionReferencesError,
} = {}) {
  const safeBookId = safeId(bookId);
  try {
    throwIfAborted(signal);
    let recovered = Boolean(await recoverBookStructureTransaction(safeBookId));
    throwIfAborted(signal);
    const book = await readBook(safeBookId, { signal });
    for (const sectionId of bookSectionIds(book)) {
      throwIfAborted(signal);
      if (await recoverSectionStructureTransaction(safeBookId, sectionId)) {
        recovered = true;
      }
      throwIfAborted(signal);
      // 派生聚合恢复会自行推进 book.updatedAt；这里的布尔值专门保留给
      // deleteBook 的结构恢复提示，避免把摘要恢复误报成新增/删章事务。
      await recoverChapterDigestTransaction(safeBookId, sectionId, { signal });
    }
    throwIfAborted(signal);
    return recovered;
  } catch (err) {
    if (err?.message === 'BOOK_SECTIONS_INVALID' && invalidBookReferencesError) {
      throw new Error(invalidBookReferencesError);
    }
    if (err?.message === 'SECTION_CHAPTERS_INVALID' && invalidSectionReferencesError) {
      throw new Error(invalidSectionReferencesError);
    }
    throw err;
  }
}

async function recoverInterruptedTransactions({
  maxFailures = MAX_STRUCTURE_RECOVERY_FAILURES,
} = {}) {
  return withStoreLock('storage:structure-recovery', async () => {
    const failureLimit = Number.isSafeInteger(maxFailures) && maxFailures > 0
      ? Math.min(maxFailures, MAX_STRUCTURE_RECOVERY_FAILURES)
      : MAX_STRUCTURE_RECOVERY_FAILURES;
    let bookEntries;
    try {
      bookEntries = await readSafeDirectory(booksDir(), { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return { recovered: 0, failures: [], truncated: false };
      throw err;
    }
    let recovered = 0;
    const failures = [];
    let truncated = false;
    const recordFailure = (failure) => {
      failures.push(failure);
      if (failures.length < failureLimit) return true;
      truncated = true;
      return false;
    };
    bookScan: for (const bookEntry of bookEntries) {
      if (!bookEntry.isDirectory() || !/^[\w-]+$/.test(bookEntry.name)) continue;
      const bookId = bookEntry.name;
      try {
        if (await recoverBookStructureTransaction(bookId)) recovered += 1;
      } catch (err) {
        if (!recordFailure({ bookId, error: String(err?.message || err) })) break;
      }
      let sectionEntries = [];
      try {
        sectionEntries = await readSafeDirectory(
          bookDir(bookId), { withFileTypes: true }, MAX_BOOK_DIRECTORY_ENTRIES,
        );
      }
      catch (err) {
        if (!recordFailure({ bookId, error: String(err?.message || err) })) break;
        continue;
      }
      for (const sectionEntry of sectionEntries) {
        // 备份会原样保留任意安全的历史分部 ID；运行时又允许在这些分部中
        // 新增/删除章节。因此不能只扫描当前默认生成的 `section-*` 名称，
        // 否则自定义 ID 下的崩溃事务会越过启动恢复，之后才被结构操作重放。
        if (!sectionEntry.isDirectory() || !isSafeStoredId(sectionEntry.name)) continue;
        try {
          if (await recoverSectionStructureTransaction(bookId, sectionEntry.name)) {
            recovered += 1;
          }
          if (await recoverChapterDigestTransaction(bookId, sectionEntry.name)) {
            recovered += 1;
          }
        } catch (err) {
          if (!recordFailure({
            bookId, sectionId: sectionEntry.name, error: String(err?.message || err),
          })) break bookScan;
        }
      }
    }
    return { recovered, failures, truncated };
  });
}

// ——— section ———
async function addSection(bookId, {
  title, titleSource, outline, expectedLastSectionId,
} = {}) {
  const safeBookId = safeId(bookId);
  let safeExpectedLastSectionId = expectedLastSectionId;
  if (expectedLastSectionId !== undefined && expectedLastSectionId !== null) {
    if (typeof expectedLastSectionId !== 'string') throw new Error('BAD_NEXT_SECTION_ANCHOR');
    safeExpectedLastSectionId = safeId(expectedLastSectionId);
  }
  return withStoreLock(`book:${safeBookId}:sections`, async () => {
    return withStoreLock(bookJsonLockKey(safeBookId), async () => {
      const pending = await recoverBookStructureTransaction(safeBookId);
      if (pending?.type === 'add-section') {
        // 没有请求标识时，无法判断调用方是在重试上一笔响应丢失的请求，
        // 还是确实要再建一个部。不能把上一笔结果冒充成本次成功，也不能
        // 贸然继续制造重复；明确要求调用方刷新后再决定。
        throw new Error('STRUCTURE_TRANSACTION_RECOVERED');
      }
      const book = await readBook(safeBookId);
      const sectionIds = bookSectionIds(book);
      if (safeExpectedLastSectionId !== undefined) {
        const currentLastSectionId = sectionIds.length
          ? sectionIds[sectionIds.length - 1]
          : null;
        if (currentLastSectionId !== safeExpectedLastSectionId) {
          throw new Error('NEXT_SECTION_CONFLICT');
        }
      }
      if (sectionIds.length >= MAX_BOOK_SECTIONS) throw new Error('BOOK_SECTION_LIMIT');
      const index = sectionIds.length + 1;
      const id = allocateSectionId(index, sectionIds);
      const cleanTitle = normalizeTitleInput(title);
      if (outline !== undefined && typeof outline !== 'string') {
        throw new Error('BAD_SECTION_OUTLINE');
      }
      if (typeof outline === 'string' && outline.length > MAX_VERSION_TEXT_CHARS) {
        throw new Error('TEXT_TOO_LARGE');
      }
      const cleanOutline = typeof outline === 'string' ? outline.trim() : '';
      const source = cleanTitle ? (TITLE_SOURCES.has(titleSource) ? titleSource : 'manual') : 'default';
      const section = {
        id, index,
        title: source === 'ai' ? stripGeneratedTitleDescription(cleanTitle) : cleanTitle,
        titleSource: source,
        outline: { content: cleanOutline, history: [] },
        characters: [], summary: '', progress: '', chapters: [], chapterSummaries: {},
      };
      // 事务文件本身也是作品目录变化；必须先推进删除锚点，避免事务
      // 成功而后续恢复失败时，旧书架仍能删除包含待恢复内容的作品。
      await writeBookUnlocked(safeBookId, book);
      await atomicWriteJson(bookStructureTransactionPath(safeBookId), {
        format: STRUCTURE_TRANSACTION_FORMAT,
        version: STRUCTURE_TRANSACTION_VERSION,
        type: 'add-section',
        bookId: safeBookId,
        sectionId: id,
        section,
      });
      return (await recoverBookStructureTransaction(safeBookId)).result;
    });
  });
}
async function readSection(bookId, sectionId, { signal } = {}) {
  const section = assertStoredRecord(await readStoredJson(
    join(bookDir(bookId), safeId(sectionId), 'section.json'), { signal }));
  return normalizeEntityTitle(section, '部');
}
async function readReferencedSection(bookId, sectionId, { signal } = {}) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  const book = await readBook(safeBookId, { signal });
  const validatedBook = validateStoredBook(book, safeBookId);
  if (!validatedBook.referencedSections.has(safeSectionId)) {
    throw new Error('SECTION_NOT_FOUND');
  }
  try {
    const section = await readSection(safeBookId, safeSectionId, { signal });
    return validateStoredSection(section, validatedBook).section;
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error('SECTION_NOT_FOUND');
    throw err;
  }
}
async function writeSection(bookId, sectionId, obj, { preserveExistingChapters = true } = {}) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  return withStoreLock(sectionFileLockKey(safeBookId, safeSectionId), () =>
    withStoreLock(bookJsonLockKey(safeBookId), async () => {
      if (preserveExistingChapters) {
        try {
          const current = await readSection(safeBookId, safeSectionId);
          obj.chapters = sectionChapterIds(current);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
      sectionChapterIds(obj);
      // 删除锚点必须先于子文件变化落盘；后续写失败只会产生一次
      // 保守的书架刷新，不会让新内容继续沿用旧删除锚点。
      await touchBookUnlocked(safeBookId);
      await atomicWriteJson(join(bookDir(safeBookId), safeSectionId, 'section.json'), obj);
    }));
}
// ——— chapter ———
async function addChapter(bookId, sectionId, {
  title,
  expectedLastChapterId,
  includeRollbackMetadata = false,
  signal,
} = {}) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  let safeExpectedLastChapterId = expectedLastChapterId;
  if (expectedLastChapterId !== undefined && expectedLastChapterId !== null) {
    if (typeof expectedLastChapterId !== 'string') throw new Error('BAD_NEXT_CHAPTER_ANCHOR');
    safeExpectedLastChapterId = safeId(expectedLastChapterId);
  }
  return withStoreLock(`book:${safeBookId}:section:${safeSectionId}:chapters`, async () => {
    return withStoreLock(sectionFileLockKey(safeBookId, safeSectionId), () =>
      withStoreLock(bookJsonLockKey(safeBookId), async () => {
      throwIfAborted(signal);
      const pending = await recoverSectionStructureTransaction(safeBookId, safeSectionId);
      if (pending) {
        if (pending.type === 'add-chapter') {
          throw new Error('STRUCTURE_TRANSACTION_RECOVERED');
        }
      }
      const book = await readBook(safeBookId, { signal });
      const previousBookUpdatedAt = book.updatedAt;
      const sectionIds = bookSectionIds(book);
      if (!sectionIds.includes(safeSectionId)) throw new Error('SECTION_NOT_FOUND');
      let section;
      try { section = await readSection(safeBookId, safeSectionId, { signal }); }
      catch (err) {
        if (err?.code === 'ENOENT') throw new Error('SECTION_NOT_FOUND');
        throw err;
      }
      const chapterIds = sectionChapterIds(section);
      if (safeExpectedLastChapterId !== undefined) {
        const currentLastChapterId = chapterIds.length
          ? chapterIds[chapterIds.length - 1]
          : null;
        if (currentLastChapterId !== safeExpectedLastChapterId) {
          throw new Error('NEXT_CHAPTER_CONFLICT');
        }
      }
      if (chapterIds.length >= MAX_SECTION_CHAPTERS) throw new Error('SECTION_CHAPTER_LIMIT');
      const totalChapters = await countBookChapterReferences(
        safeBookId, sectionIds, section, { signal },
      );
      if (totalChapters >= MAX_TOTAL_BOOK_CHAPTERS) throw new Error('BOOK_CHAPTER_LIMIT');
      const index = chapterIds.length + 1;
      const id = allocateChapterId(chapterIds);
      const cleanTitle = normalizeTitleInput(title);
      const chapter = {
        id, index,
        title: cleanTitle,
        titleSource: cleanTitle ? 'manual' : 'default',
        body: emptyVersioned(), content: '', bodyFingerprint: contentFingerprint(''),
        characters: [], summary: '', progress: '', handoff: emptyChapterHandoff(),
        status: 'done', memoryCandidates: [],
        plan: emptyChapterPlan(),
      };
      // 事务文件是不可逆提交链的起点；取消只能在写入它之前生效。
      // 一旦开始写事务，就必须完成恢复，避免留下只有一半结构的新章。
      throwIfAborted(signal);
      await writeBookUnlocked(safeBookId, book);
      // 锚点写入后取消仍可安全停止：只有时间戳发生保守推进，尚无结构内容。
      throwIfAborted(signal);
      await atomicWriteJson(sectionStructureTransactionPath(safeBookId, safeSectionId), {
        format: STRUCTURE_TRANSACTION_FORMAT,
        version: STRUCTURE_TRANSACTION_VERSION,
        type: 'add-chapter',
        bookId: safeBookId,
        sectionId: safeSectionId,
        chapterId: id,
        chapter,
      });
      const applied = await recoverSectionStructureTransaction(safeBookId, safeSectionId);
      if (!includeRollbackMetadata) return applied.result;
      return {
        chapter: applied.result,
        rollback: {
          previousBookUpdatedAt,
          expectedBookUpdatedAt: applied.bookUpdatedAt,
        },
      };
      }, { signal }), { signal });
  }, { signal });
}
async function readChapter(bookId, sectionId, chapterId, { signal } = {}) {
  const ch = assertStoredRecord(await readStoredJson(
    join(bookDir(bookId), safeId(sectionId), `${safeId(chapterId)}.json`), { signal }));
  return migrateChapterInPlace(ch);
}
async function readChapterSummary(bookId, sectionId, chapterId) {
  const chapter = await readChapter(bookId, sectionId, chapterId);
  return {
    id: chapter.id,
    index: chapter.index,
    title: chapter.title,
    titleSource: chapter.titleSource,
    status: chapter.status,
    hasContent: Boolean(currentText(chapter.body).trim()),
  };
}

function nonWhitespaceCharacterCount(value) {
  let count = 0;
  for (const character of value) {
    if (/\S/u.test(character)) count += 1;
  }
  return count;
}

function chapterTreePublicationFields(bodyFingerprint, published) {
  if (!published) return { publicationStatus: 'unpublished' };
  return {
    publicationStatus: published.bodyFingerprint === bodyFingerprint
      ? 'published'
      : 'modified',
    publishedAt: published.publishedAt,
    publicationNumber: published.publicationNumber,
    publishedCharacterCount: published.characterCount,
  };
}

async function readChapterTreeSummary(
  bookId, sectionId, chapterId, validatedSection, seenChapters, { signal } = {},
) {
  const chapterPath = join(bookDir(bookId), sectionId, `${chapterId}.json`);
  let projected;
  try {
    projected = await readStoredJsonProjection(
      chapterPath,
      CHAPTER_TREE_JSON_PROJECTION,
      { signal, projectionInvalidError: 'STORAGE_PROJECTED_DATA_INVALID' },
    );
  } catch (error) {
    if (error?.message !== 'STORAGE_PROJECTED_DATA_INVALID') throw error;
    // 旧文件的 body/titleSource 可能缺失或使用早期结构；
    // 保留原有完整读取+迁移路径，不因性能优化破坏兼容性。
    projected = null;
  }
  throwIfAborted(signal);

  const canUseProjection = isObjectRecord(projected)
    && projected.id === chapterId
    && typeof projected.title === 'string'
    && projected.title.length <= MAX_TITLE_CHARS
    && isObjectRecord(projected.body)
    && typeof projected.body.hasContent === 'boolean'
    && Number.isSafeInteger(projected.body.characterCount)
    && projected.body.characterCount >= 0
    && typeof projected.body.fingerprint === 'string'
    && projected.body.fingerprint === projected.bodyFingerprint
    && /^[A-Za-z0-9_-]{43}$/.test(projected.bodyFingerprint)
    && (projected.published === undefined
      || (isObjectRecord(projected.published)
        && typeof projected.published.bodyFingerprint === 'string'
        && typeof projected.published.publishedAt === 'string'
        && Number.isSafeInteger(projected.published.publicationNumber)
        && Number.isSafeInteger(projected.published.characterCount)));
  if (canUseProjection) {
    if (!validatedSection.referencedChapters.has(chapterId)
      || seenChapters.has(chapterId)) {
      throw new Error('STORAGE_DATA_INVALID');
    }
    seenChapters.add(chapterId);
    const titled = normalizeEntityTitle({
      title: projected.title,
      titleSource: projected.titleSource,
    }, '章');
    return {
      id: chapterId,
      index: validatedSection.chapterIndexes.get(chapterId),
      title: titled.title,
      titleSource: titled.titleSource,
      status: 'done',
      hasContent: projected.body.hasContent,
      characterCount: projected.body.characterCount,
      reviewCurrent: projected.review?.sourceFingerprint === projected.bodyFingerprint,
      ...chapterTreePublicationFields(projected.bodyFingerprint, projected.published),
    };
  }

  const rawChapter = await readChapter(bookId, sectionId, chapterId, { signal });
  throwIfAborted(signal);
  const chapter = normalizeStoredChapter(rawChapter, validatedSection, seenChapters);
  const body = currentText(chapter.body);
  const published = chapter.published
    ? {
      ...chapter.published,
      characterCount: nonWhitespaceCharacterCount(chapter.published.content),
    }
    : undefined;
  return {
    id: chapter.id,
    index: chapter.index,
    title: chapter.title,
    titleSource: chapter.titleSource,
    status: chapter.status,
    hasContent: Boolean(body.trim()),
    characterCount: nonWhitespaceCharacterCount(body),
    reviewCurrent: chapter.review?.sourceFingerprint === chapter.bodyFingerprint,
    ...chapterTreePublicationFields(chapter.bodyFingerprint, published),
  };
}

async function readSectionTreeMetadata(
  bookId, sectionId, validatedBook, seenSections, { signal } = {},
) {
  const sectionPath = join(bookDir(bookId), sectionId, 'section.json');
  let projected;
  try {
    projected = await readStoredJsonProjection(
      sectionPath,
      SECTION_TREE_JSON_PROJECTION,
      { signal, projectionInvalidError: 'STORAGE_PROJECTED_DATA_INVALID' },
    );
  } catch (error) {
    if (error?.message !== 'STORAGE_PROJECTED_DATA_INVALID') throw error;
    // 早期文件可能没有 titleSource，或留下了可由原有
    // 规范化逻辑兼容的类型；异常路径回退到完整读取。
    projected = await readSection(bookId, sectionId, { signal });
  }
  throwIfAborted(signal);
  return validateStoredSection(projected, validatedBook, seenSections);
}

async function readBookStructureUnlocked(bookId, { signal } = {}) {
  throwIfAborted(signal);
  const book = await readBook(bookId, { signal });
  throwIfAborted(signal);
  const validatedBook = validateStoredBook(book, bookId);
  const seenSections = new Set();
  const sectionEntries = await mapWithConcurrency(
    validatedBook.sectionIds, 4, async (sectionId) => {
    throwIfAborted(signal);
    const validatedSection = await readSectionTreeMetadata(
      bookId, sectionId, validatedBook, seenSections, { signal },
    );
    return { sectionId, validatedSection };
  });
  throwIfAborted(signal);
  const totalChapters = sectionEntries.reduce(
    (sum, entry) => sum + entry.validatedSection.chapterIds.length, 0,
  );
  if (totalChapters > MAX_TOTAL_BOOK_CHAPTERS) {
    throw new Error('BOOK_CHAPTERS_LIMIT_EXCEEDED');
  }
  // 避免“分部并发 × 章节并发”成倍放大；正常路径下
  // 分部和章节都仅保留树所需的有界投影，同时扫描完整 JSON。
  const seenChapters = new Map(sectionEntries.map(
    ({ sectionId }) => [sectionId, new Set()],
  ));
  const chapterTargets = sectionEntries.flatMap(({ sectionId, validatedSection }) =>
    validatedSection.chapterIds.map((chapterId) => ({
      sectionId, chapterId, validatedSection,
    })));
  const chapterSummaries = await mapWithConcurrency(
    chapterTargets, 4, async ({ sectionId, chapterId, validatedSection }) => {
      throwIfAborted(signal);
      return readChapterTreeSummary(
        bookId,
        sectionId,
        chapterId,
        validatedSection,
        seenChapters.get(sectionId),
        { signal },
      );
    },
  );
  throwIfAborted(signal);
  let summaryIndex = 0;
  const sections = sectionEntries.map(({ validatedSection }) => {
    const { section, chapterIds } = validatedSection;
    const chapters = chapterSummaries.slice(summaryIndex, summaryIndex + chapterIds.length);
    summaryIndex += chapterIds.length;
    return {
      id: section.id,
      index: section.index,
      title: section.title,
      titleSource: section.titleSource,
      chapters,
    };
  });
  return {
    book: {
      id: validatedBook.book.id,
      title: validatedBook.book.title,
      titleSource: validatedBook.book.titleSource,
      outline: validatedBook.book.outline,
      settings: {
        ...validatedBook.book.settings,
        serialization: serializationSettingsView(validatedBook.book.settings.serialization),
      },
      sectionPlanContextRevision: sectionPlanContextRevision(validatedBook.book),
    },
    sections,
  };
}

async function readBookStructure(id, { signal } = {}) {
  throwIfAborted(signal);
  const bookId = safeId(id);
  // 作品树由 book / section / chapter 多层文件拼装。所有运行时写入都会取得
  // book-json 锁；读取也进入同一锁域，避免并发删章时先读到旧引用、随后却
  // 发现章节文件已删除，或把一次多文件 digest 的新旧字段拼成混合快照。
  return withStoreLock(bookJsonLockKey(bookId), async () => {
    await recoverReferencedStructureTransactions(bookId, {
      signal,
      invalidBookReferencesError: 'STORAGE_DATA_INVALID',
      invalidSectionReferencesError: 'STORAGE_DATA_INVALID',
    });
    return readBookStructureUnlocked(bookId, { signal });
  }, { signal });
}
async function readReferencedChapter(bookId, sectionId, chapterId, { signal } = {}) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  const safeChapterId = safeId(chapterId);
  const section = await readReferencedSection(safeBookId, safeSectionId, { signal });
  const chapterIds = sectionChapterIds(section);
  if (!chapterIds.includes(safeChapterId)) {
    throw new Error('CHAPTER_NOT_FOUND');
  }
  try {
    const chapter = await readChapter(safeBookId, safeSectionId, safeChapterId, { signal });
    return normalizeStoredChapter(chapter, {
      referencedChapters: new Set(chapterIds),
      chapterIndexes: new Map(chapterIds.map((id, index) => [id, index + 1])),
    });
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error('CHAPTER_NOT_FOUND');
    throw err;
  }
}
async function writeChapterFile(bookId, sectionId, chapterId, obj) {
  if (obj.body) {
    obj.content = currentText(obj.body);  // 派生 content 与 body 保持同步
    obj.bodyFingerprint = contentFingerprint(obj.content);
  }
  await atomicWriteJson(join(bookDir(bookId), safeId(sectionId), `${safeId(chapterId)}.json`), obj);
}
async function withChapterWriteLocks(bookId, sectionId, chapterId, fn, { signal } = {}) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  const safeChapterId = safeId(chapterId);
  return withStoreLock(sectionFileLockKey(safeBookId, safeSectionId), () =>
    withStoreLock(bookJsonLockKey(safeBookId), () =>
      withStoreLock(chapterFileLockKey(safeBookId, safeSectionId, safeChapterId), async () => {
        // 删除事务已经落盘、后续写入却失败时，服务仍可能继续运行。若这里
        // 直接接受新正文/审稿，稍后的事务恢复会删除刚保存的内容。所有章节
        // 读写在取得同一分部和作品锁后先完成残留事务，让目标删除立即表现为
        // CHAPTER_NOT_FOUND；其它章节则在最新结构上继续，不留下“保存成功后
        // 又被旧事务静默删除”的窗口。
        const pendingStructure = await recoverSectionStructureTransaction(
          safeBookId, safeSectionId,
        );
        await recoverChapterDigestTransaction(
          safeBookId, safeSectionId, { signal },
        );
        return fn(safeBookId, safeSectionId, safeChapterId, pendingStructure);
      }, { signal }), { signal }), { signal });
}
async function assertChapterReferenced(bookId, sectionId, chapterId, { signal } = {}) {
  const section = await readReferencedSection(bookId, sectionId, { signal });
  if (!sectionChapterIds(section).includes(chapterId)) throw new Error('CHAPTER_NOT_FOUND');
  return section;
}
async function writeChapter(bookId, sectionId, chapterId, obj) {
  return withChapterWriteLocks(bookId, sectionId, chapterId, async (safeBookId, safeSectionId, safeChapterId) => {
    await assertChapterReferenced(safeBookId, safeSectionId, safeChapterId);
    await touchBookUnlocked(safeBookId);
    await writeChapterFile(safeBookId, safeSectionId, safeChapterId, obj);
  });
}
async function deleteChapter(bookId, sectionId, chapterId, {
  expectedRevision,
  restoreBookUpdatedAt,
} = {}) {
  const safeBookId = safeId(bookId);
  const safeSectionId = safeId(sectionId);
  const safeChapterId = safeId(chapterId);
  return withChapterWriteLocks(safeBookId, safeSectionId, safeChapterId, async (
    _lockedBookId, _lockedSectionId, _lockedChapterId, pending,
  ) => {
    if (pending?.type === 'delete-chapter' && pending.chapterId === safeChapterId) {
      return pending.result;
    }
    if (expectedRevision !== undefined) {
      await assertChapterReferenced(safeBookId, safeSectionId, safeChapterId);
      const chapter = await readChapter(safeBookId, safeSectionId, safeChapterId);
      assertExpectedVersionRevision(chapter.body, expectedRevision);
    }
    let previousBookUpdatedAt = null;
    if (restoreBookUpdatedAt !== undefined) {
      if (!isObjectRecord(restoreBookUpdatedAt)
        || typeof restoreBookUpdatedAt.previousBookUpdatedAt !== 'string'
        || typeof restoreBookUpdatedAt.expectedBookUpdatedAt !== 'string') {
        throw new Error('BAD_BOOK_UPDATED_AT_ROLLBACK');
      }
      const currentBook = await readBook(safeBookId);
      if (currentBook.updatedAt === restoreBookUpdatedAt.expectedBookUpdatedAt) {
        previousBookUpdatedAt = restoreBookUpdatedAt.previousBookUpdatedAt;
      }
    }
    await touchBookUnlocked(safeBookId);
    await atomicWriteJson(sectionStructureTransactionPath(safeBookId, safeSectionId), {
      format: STRUCTURE_TRANSACTION_FORMAT,
      version: STRUCTURE_TRANSACTION_VERSION,
      type: 'delete-chapter',
      bookId: safeBookId,
      sectionId: safeSectionId,
      chapterId: safeChapterId,
    });
    const applied = await recoverSectionStructureTransaction(safeBookId, safeSectionId);
    if (previousBookUpdatedAt !== null) {
      const book = await readBook(safeBookId);
      book.updatedAt = previousBookUpdatedAt;
      await atomicWriteJson(join(bookDir(safeBookId), 'book.json'), book);
    }
    return applied.result;
  });
}

// ——— 连载设置与平台治理 ———

  return Object.freeze({
    addChapter,
    addSection,
    assertChapterReferenced,
    bookStructureTransactionPath,
    chapterDigestTransactionPath,
    clearCommittedTransaction,
    deleteChapter,
    isValidBookStructureTransaction,
    isValidChapterDigestTransaction,
    isValidSectionStructureTransaction,
    readBookStructure,
    readChapter,
    readChapterSummary,
    readReferencedChapter,
    readReferencedSection,
    readSection,
    recoverInterruptedTransactions,
    recoverReferencedStructureTransactions,
    sectionStructureTransactionPath,
    withChapterWriteLocks,
    writeChapter,
    writeChapterFile,
    writeSection,
  });
}
