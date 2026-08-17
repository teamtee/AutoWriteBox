import { open, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openIndexedBookBackup } from '../backup-json.js';
import { stringifyJsonChunks } from '../json-stream.js';
import {
  MAX_BOOK_JSON_BYTES, MAX_BOOK_SECTIONS, MAX_CHAPTER_JSON_BYTES,
  MAX_SECTION_CHAPTERS, MAX_SECTION_JSON_BYTES, MAX_TOTAL_BACKUP_CHAPTERS,
  MAX_VERSION_TEXT_CHARS,
} from '../limits.js';
import { normalizePlatformConfirmations } from '../platform-governance-schema.js';
import { currentText, isValidVersioned } from './versioned.js';
import { createLimitedJsonWriter } from './json-writer.js';
import { mapWithConcurrency, withStoreLock } from './concurrency.js';
import { throwIfAborted } from './abort.js';
import {
  createCachedProcessStartedAtResolver, isProcessAlive, PROCESS_STARTED_AT,
  PROCESS_STARTED_AT_MS, processOwnerIsAlive, processStartedAtMsForPid,
} from './instance-lock.js';
import {
  IMPORT_STAGE_FORMAT, IMPORT_STAGE_OWNER_FILE,
} from './structure-constants.js';

export function createBackupStore(dependencies) {
  const {
    BOOK_BACKUP_FORMAT, BOOK_BACKUP_MAX_BYTES, BOOK_BACKUP_VERSION,
    BOOK_SECTION_REFERENCES_JSON_PROJECTION, MANUSCRIPT_EXPORT_MAX_BYTES,
    SECTION_SUMMARY_JSON_PROJECTION, assertStorageDirectoryCapacity,
    atomicWriteJson, backupSchema, bookDir, bookJsonLockKey, booksDir,
    createBookId, durableRename, ensureDirectory, getDataRoot, inspectJsonFile,
    isObjectRecord, migrateBookInPlace, normalizeRequestedBookId,
    readBook, readChapter, readSafeDirectory, readSection,
    readStoredJsonProjection, recoverReferencedStructureTransactions, safeId,
    storageIdPathKey, syncDirectory, validDailyWordGoal,
  } = dependencies;
  const {
    canonicalizeBookBackup, createActiveMemorySourceValidator,
    createActivePromiseEvidenceSourceValidator,
    createActiveWorldGateSourceValidator, invalidBackup,
    normalizeBackupBook, normalizeBackupChapter, normalizeBackupSection,
    validateBackupBook, validateBackupChapter, validateBackupSection,
    validateBookBackup, validateBookSectionSummaryEntry,
  } = backupSchema;

const IMPORT_STAGE_NAME = /^book_(?:\d{17}_[0-9a-f]{12}|[0-9a-f]{32})_[0-9a-f]{32}$/;
const DEFAULT_IMPORT_STAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;


async function cleanupAbandonedImports({
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_IMPORT_STAGE_MAX_AGE_MS,
  processAlive = isProcessAlive,
  processStartedAtForPid,
  currentPid = process.pid,
  currentProcessStartedAtMs = PROCESS_STARTED_AT_MS,
} = {}) {
  const tempParent = join(getDataRoot(), '.imports');
  const currentProcessStartedAt = new Date(currentProcessStartedAtMs).toISOString();
  let entries;
  try {
    entries = await readSafeDirectory(tempParent, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return { removed: 0 };
    throw err;
  }

  let removed = 0;
  const resolveProcessStartedAt = createCachedProcessStartedAtResolver(
    processStartedAtForPid
      ?? (processAlive === isProcessAlive ? processStartedAtMsForPid : null),
  );
  for (const entry of entries) {
    // Dirent.isDirectory() 不跟随符号链接；名称还必须完全符合内部生成格式。
    if (!entry.isDirectory() || !IMPORT_STAGE_NAME.test(entry.name)) continue;
    const stageRoot = join(tempParent, entry.name);
    const owner = await inspectJsonFile(join(stageRoot, IMPORT_STAGE_OWNER_FILE));
    let metadata;
    try {
      metadata = await stat(stageRoot);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    const startedAtMs = owner.status === 'ok' && isObjectRecord(owner.value)
      ? Date.parse(owner.value.startedAt)
      : Number.NaN;
    const validOwner = owner.status === 'ok'
      && isObjectRecord(owner.value)
      && owner.value.format === IMPORT_STAGE_FORMAT
      && Number.isInteger(owner.value.pid)
      && owner.value.pid > 0
      && Number.isFinite(startedAtMs)
      && (owner.value.processStartedAt === undefined
        || (typeof owner.value.processStartedAt === 'string'
          && Number.isFinite(Date.parse(owner.value.processStartedAt))));
    const createdAtMs = validOwner ? startedAtMs : metadata.mtimeMs;
    const expired = Number.isFinite(createdAtMs)
      && Math.max(0, nowMs - createdAtMs) >= Math.max(0, maxAgeMs);
    if (validOwner) {
      const belongsToPriorCurrentPid = owner.value.pid === currentPid
        && (owner.value.processStartedAt !== undefined
          ? owner.value.processStartedAt !== currentProcessStartedAt
          : startedAtMs < currentProcessStartedAtMs);
      // 活跃所有者优先于年龄阈值：休眠或系统时钟前跳不能让另一个操作删除
      // 仍在写入的目录。同 PID 但进程启动身份不同则是可安全识别的旧残留。
      if (!belongsToPriorCurrentPid && await processOwnerIsAlive(owner.value, {
        processAlive,
        processStartedAtForPid: resolveProcessStartedAt,
      })) continue;
    }
    if (!validOwner && !expired) continue;

    await rm(stageRoot, { recursive: true, force: true });
    removed += 1;
  }
  if (removed) await syncDirectory(tempParent, { afterCommit: true });
  return { removed };
}

async function createBookBackup(id) {
  const bookId = safeId(id);
  // 所有运行时作品写入最终都会取得 book-json 锁。导出在同一把锁内完成，
  // 才能保证 book / section / chapter 来自同一个已提交状态，而不是把并发
  // 保存前后的多层数据拼成一个表面合法、语义却不一致的备份。
  return withStoreLock(bookJsonLockKey(bookId), async () => {
    await recoverReferencedStructureTransactions(bookId, {
      invalidBookReferencesError: 'BACKUP_BOOK_INVALID',
      invalidSectionReferencesError: 'BACKUP_SECTION_INVALID',
    });
    const book = await readBook(bookId);
    const sectionIds = backupReferenceIds(
      book.sections, 'BACKUP_BOOK_INVALID', MAX_BOOK_SECTIONS,
    );
    let totalChapters = 0;
    const sections = await mapWithConcurrency(sectionIds, 4, async (sectionId) => {
      const section = await readSection(bookId, sectionId);
      const chapterIds = backupReferenceIds(
        section.chapters, 'BACKUP_SECTION_INVALID', MAX_SECTION_CHAPTERS,
      );
      totalChapters += chapterIds.length;
      if (totalChapters > MAX_TOTAL_BACKUP_CHAPTERS) throw new Error('BACKUP_SECTION_INVALID');
      const chapters = await mapWithConcurrency(chapterIds, 16, (chapterId) =>
        readChapter(bookId, sectionId, chapterId));
      return { section, chapters };
    });
    const snapshot = canonicalizeBookBackup({
      format: BOOK_BACKUP_FORMAT,
      version: BOOK_BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      book,
      sections,
    });
    // 兼容仍直接消费对象的内部调用，但不要为了计数再构造一份最高 100 MB
    // 的完整 JSON 字符串；与文件导出共用分片序列化边界即可精确计算 UTF-8。
    let snapshotBytes = 0;
    for (const chunk of stringifyJsonChunks(snapshot)) {
      snapshotBytes += Buffer.byteLength(chunk, 'utf8');
      if (snapshotBytes > BOOK_BACKUP_MAX_BYTES) throw new Error('BACKUP_TOO_LARGE');
    }
    return snapshot;
  });
}

const BACKUP_SNAPSHOT_CHANGED = 'BACKUP_SNAPSHOT_CHANGED';

function backupReferenceIds(values, errorCode, maxItems) {
  if (!Array.isArray(values) || values.length > maxItems) throw new Error(errorCode);
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    let id;
    try { id = safeId(value); }
    catch { throw new Error(errorCode); }
    const pathKey = storageIdPathKey(id);
    if (seen.has(pathKey)) throw new Error(errorCode);
    seen.add(pathKey);
    ids.push(id);
  }
  return ids;
}

function sameReferences(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}


function assertExportableBook(book, bookId) {
  if (!isObjectRecord(book) || book.id !== bookId
    || typeof book.title !== 'string' || typeof book.premise !== 'string'
    || !isValidVersioned(book.outline)
    || !isObjectRecord(book.settings) || !isObjectRecord(book.settings.core)) {
    throw new Error('BACKUP_BOOK_INVALID');
  }
  for (const field of ['world', 'style', 'constraints', 'pacing']) {
    if (!isValidVersioned(book.settings.core[field])) throw new Error('BACKUP_BOOK_INVALID');
  }
  if (!isObjectRecord(book.settings.serialization)
    || !validDailyWordGoal(book.settings.serialization.dailyWordGoal)) {
    throw new Error('BACKUP_BOOK_INVALID');
  }
  try {
    normalizePlatformConfirmations(book.settings.serialization.platformConfirmations, {
      errorCode: 'BACKUP_BOOK_INVALID',
    });
  } catch { throw new Error('BACKUP_BOOK_INVALID'); }
}

async function writeBookBackupAttempt(bookId, absPath, maxBytes, signal) {
  throwIfAborted(signal);
  let book = await readBook(bookId, { signal });
  throwIfAborted(signal);
  assertExportableBook(book, bookId);
  const sectionIds = backupReferenceIds(book.sections, 'BACKUP_BOOK_INVALID', MAX_BOOK_SECTIONS);
  let exportedBook = normalizeBackupBook(book, bookId, sectionIds);
  book = null;
  const capturedChapters = new Map();
  let totalChapters = 0;
  let handle;
  try {
    handle = await open(absPath, 'wx', 0o600);
    const writer = createLimitedJsonWriter(handle, maxBytes, signal);
    await writer.writeText(`{"format":${JSON.stringify(BOOK_BACKUP_FORMAT)},"version":${BOOK_BACKUP_VERSION},"exportedAt":${JSON.stringify(new Date().toISOString())},"book":`);
    await writer.writeJson(exportedBook);
    exportedBook = null;
    await writer.writeText(',"sections":[');

    for (let sectionIndex = 0; sectionIndex < sectionIds.length; sectionIndex += 1) {
      throwIfAborted(signal);
      const sectionId = sectionIds[sectionIndex];
      let section;
      try {
        section = await readSection(bookId, sectionId, { signal });
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
        const latestBook = await readBook(bookId, { signal });
        if (!sameReferences(latestBook.sections, sectionIds)) throw new Error(BACKUP_SNAPSHOT_CHANGED);
        throw new Error('BACKUP_SECTION_INVALID');
      }
      if (!isObjectRecord(section) || section.id !== sectionId || typeof section.title !== 'string') {
        throw new Error('BACKUP_SECTION_INVALID');
      }
      const chapterIds = backupReferenceIds(
        section.chapters, 'BACKUP_SECTION_INVALID', MAX_SECTION_CHAPTERS,
      );
      capturedChapters.set(sectionId, chapterIds);
      totalChapters += chapterIds.length;
      if (totalChapters > MAX_TOTAL_BACKUP_CHAPTERS) throw new Error('BACKUP_SECTION_INVALID');

      let exportedSection = normalizeBackupSection(
        section, sectionId, sectionIndex + 1, chapterIds,
      );
      const sectionOutline = exportedSection.outline?.content;
      section = null;
      await writer.writeText(`${sectionIndex ? ',' : ''}{"section":`);
      await writer.writeJson(exportedSection);
      exportedSection = null;
      await writer.writeText(',"chapters":[');
      for (let chapterIndex = 0; chapterIndex < chapterIds.length; chapterIndex += 1) {
        throwIfAborted(signal);
        const chapterId = chapterIds[chapterIndex];
        let chapter;
        try {
          chapter = await readChapter(bookId, sectionId, chapterId, { signal });
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
          const latestSection = await readSection(bookId, sectionId, { signal });
          if (!sameReferences(latestSection.chapters, chapterIds)) throw new Error(BACKUP_SNAPSHOT_CHANGED);
          throw new Error('BACKUP_SECTION_INVALID');
        }
        if (!isObjectRecord(chapter) || chapter.id !== chapterId
          || typeof chapter.title !== 'string' || !isValidVersioned(chapter.body)) {
          throw new Error('BACKUP_SECTION_INVALID');
        }
        const exportedChapter = normalizeBackupChapter(
          chapter, chapterId, chapterIndex + 1, sectionOutline,
        );
        chapter = null;
        if (chapterIndex) await writer.writeText(',');
        await writer.writeJson(exportedChapter);
      }
      await writer.writeText(']}');
    }
    await writer.writeText(']}');
    await writer.flush();
    await handle.sync();
    throwIfAborted(signal);
    await handle.close();
    handle = undefined;

    throwIfAborted(signal);
    const latestBook = await readStoredJsonProjection(
      join(bookDir(bookId), 'book.json'),
      BOOK_SECTION_REFERENCES_JSON_PROJECTION,
      { signal, projectionInvalidError: BACKUP_SNAPSHOT_CHANGED },
    );
    throwIfAborted(signal);
    if (!sameReferences(latestBook.sections, sectionIds)) throw new Error(BACKUP_SNAPSHOT_CHANGED);
    for (const sectionId of sectionIds) {
      throwIfAborted(signal);
      let latestSection;
      try {
        latestSection = await readStoredJsonProjection(
          join(bookDir(bookId), sectionId, 'section.json'),
          SECTION_SUMMARY_JSON_PROJECTION,
          { signal, projectionInvalidError: BACKUP_SNAPSHOT_CHANGED },
        );
      }
      catch (err) {
        if (err?.code === 'ENOENT') throw new Error(BACKUP_SNAPSHOT_CHANGED);
        throw err;
      }
      if (!sameReferences(latestSection.chapters, capturedChapters.get(sectionId))) {
        throw new Error(BACKUP_SNAPSHOT_CHANGED);
      }
    }
    return { bookId };
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(absPath, { force: true }).catch(() => {});
    throw err;
  }
}

// 完整生成临时文件后再交给 HTTP 层：内存只保留当前章节，失败时不会下载半截 JSON。
async function writeBookBackupFile(id, absPath, {
  maxAttempts = 3,
  maxBytes = BOOK_BACKUP_MAX_BYTES,
  signal,
} = {}) {
  throwIfAborted(signal);
  const bookId = safeId(id);
  const attempts = Math.max(1, Math.min(5, Number.isInteger(maxAttempts) ? maxAttempts : 3));
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, BOOK_BACKUP_MAX_BYTES)
    : BOOK_BACKUP_MAX_BYTES;
  return withStoreLock(bookJsonLockKey(bookId), async () => {
    await recoverReferencedStructureTransactions(bookId, {
      signal,
      invalidBookReferencesError: 'BACKUP_BOOK_INVALID',
      invalidSectionReferencesError: 'BACKUP_SECTION_INVALID',
    });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await writeBookBackupAttempt(bookId, absPath, byteLimit, signal);
      } catch (err) {
        await rm(absPath, { force: true }).catch(() => {});
        throwIfAborted(signal);
        if (err?.message !== BACKUP_SNAPSHOT_CHANGED) throw err;
        if (attempt === attempts - 1) throw new Error('BACKUP_CHANGED_DURING_EXPORT');
      }
    }
    throw new Error('BACKUP_CHANGED_DURING_EXPORT');
  }, { signal });
}

function manuscriptHeadingText(value, invalidCode) {
  if (typeof value !== 'string') throw new Error(invalidCode);
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function manuscriptBodyText(value) {
  if (typeof value !== 'string' || value.length > MAX_VERSION_TEXT_CHARS) {
    throw new Error('BACKUP_SECTION_INVALID');
  }
  return value.replace(/\r\n?/g, '\n').trim();
}

function numberedManuscriptHeading(kind, index, title) {
  const marker = kind === 'section' ? '部' : '章';
  const alreadyNumbered = new RegExp(`^第.{1,12}${marker}(?:\\s|[·:：—-]|$)`);
  if (title && alreadyNumbered.test(title)) return title;
  return title ? `第${index}${marker} ${title}` : `第${index}${marker}`;
}

// 发布辅助只导出可直接复制的 UTF-8 纯文本，不夹带大纲、摘要、审稿、
// 记忆、配置或创作资产。整次遍历持有作品提交锁，因此章序和正文来自
// 同一已提交状态；先写完私有临时文件，失败时不会交付半截稿件。
async function writeBookManuscriptFile(id, absPath, {
  source = 'current', maxBytes = MANUSCRIPT_EXPORT_MAX_BYTES, signal,
} = {}) {
  throwIfAborted(signal);
  if (!['current', 'published'].includes(source)) throw new Error('BAD_MANUSCRIPT_SOURCE');
  const bookId = safeId(id);
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, MANUSCRIPT_EXPORT_MAX_BYTES)
    : MANUSCRIPT_EXPORT_MAX_BYTES;
  return withStoreLock(bookJsonLockKey(bookId), async () => {
    await recoverReferencedStructureTransactions(bookId, {
      signal,
      invalidBookReferencesError: 'BACKUP_BOOK_INVALID',
      invalidSectionReferencesError: 'BACKUP_SECTION_INVALID',
    });
    let handle;
    try {
      const book = await readBook(bookId, { signal });
      assertExportableBook(book, bookId);
      const sectionIds = backupReferenceIds(
        book.sections, 'BACKUP_BOOK_INVALID', MAX_BOOK_SECTIONS,
      );
      const bookTitle = manuscriptHeadingText(book.title, 'BACKUP_BOOK_INVALID')
        || '未命名作品';
      handle = await open(absPath, 'wx', 0o600);
      const writer = createLimitedJsonWriter(
        handle, byteLimit, signal, 'MANUSCRIPT_TOO_LARGE',
      );
      // BOM 让 Windows 常见文本编辑器也能稳定识别 UTF-8 中文。
      await writer.writeText(`\uFEFF${bookTitle}\n`);
      let totalChapterCount = 0;
      let exportedChapterCount = 0;
      let skippedChapterCount = 0;

      for (let sectionIndex = 0; sectionIndex < sectionIds.length; sectionIndex += 1) {
        throwIfAborted(signal);
        const sectionId = sectionIds[sectionIndex];
        const section = await readSection(bookId, sectionId, { signal });
        if (!isObjectRecord(section) || section.id !== sectionId) {
          throw new Error('BACKUP_SECTION_INVALID');
        }
        const sectionTitle = manuscriptHeadingText(
          section.title, 'BACKUP_SECTION_INVALID',
        );
        const chapterIds = backupReferenceIds(
          section.chapters, 'BACKUP_SECTION_INVALID', MAX_SECTION_CHAPTERS,
        );
        totalChapterCount += chapterIds.length;
        if (totalChapterCount > MAX_TOTAL_BACKUP_CHAPTERS) {
          throw new Error('BACKUP_SECTION_INVALID');
        }
        let wroteSectionHeading = false;
        for (let chapterIndex = 0; chapterIndex < chapterIds.length; chapterIndex += 1) {
          throwIfAborted(signal);
          const chapterId = chapterIds[chapterIndex];
          const chapter = await readChapter(bookId, sectionId, chapterId, { signal });
          if (!isObjectRecord(chapter) || chapter.id !== chapterId
            || !isValidVersioned(chapter.body)) {
            throw new Error('BACKUP_SECTION_INVALID');
          }
          const rawBody = source === 'published'
            ? chapter.published?.content
            : currentText(chapter.body);
          if (source === 'published' && rawBody === undefined) {
            skippedChapterCount += 1;
            continue;
          }
          const body = manuscriptBodyText(rawBody);
          if (!body) {
            skippedChapterCount += 1;
            continue;
          }
          if (!wroteSectionHeading) {
            const heading = numberedManuscriptHeading(
              'section', sectionIndex + 1, sectionTitle,
            );
            await writer.writeText(`\n${heading}\n`);
            wroteSectionHeading = true;
          }
          const globalChapterIndex = totalChapterCount - chapterIds.length + chapterIndex + 1;
          const chapterTitle = manuscriptHeadingText(
            chapter.title, 'BACKUP_SECTION_INVALID',
          );
          const heading = numberedManuscriptHeading(
            'chapter', globalChapterIndex, chapterTitle,
          );
          await writer.writeText(`\n${heading}\n\n${body}\n`);
          exportedChapterCount += 1;
        }
      }
      if (!exportedChapterCount) throw new Error('MANUSCRIPT_EMPTY');
      await writer.flush();
      await handle.sync();
      throwIfAborted(signal);
      await handle.close();
      handle = undefined;
      return {
        bookId, source, totalChapterCount, exportedChapterCount, skippedChapterCount,
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(absPath, { force: true }).catch(() => {});
      throw error;
    }
  }, { signal });
}


async function commitNewBookDirectory({
  book, sectionIds, writeSections, signal, requestedBookId,
}) {
  return withStoreLock('books:commit-new', async () => {
    throwIfAborted(signal);
    await cleanupAbandonedImports().catch((err) => {
      console.warn(`[store] abandoned import cleanup failed (${err?.code || 'UNKNOWN'})`);
    });
    throwIfAborted(signal);
    const id = normalizeRequestedBookId(requestedBookId) ?? createBookId();
    const destination = bookDir(id);
    try {
      await stat(destination);
      throw new Error('BOOK_ALREADY_EXISTS');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    // 新提交不能把 books/ 从“仍可完整枚举”推成超限目录。所有新建和
    // 导入共用 books:commit-new 锁，恢复也在最终提交前取得同一把锁。
    await assertStorageDirectoryCapacity(booksDir(), 'BOOK_LIBRARY_LIMIT');

    const tempParent = join(getDataRoot(), '.imports');
    const tempRoot = join(tempParent, `${id}_${randomUUID().replaceAll('-', '')}`);
    try {
      throwIfAborted(signal);
      await ensureDirectory(tempRoot);
      const now = new Date().toISOString();
      await atomicWriteJson(join(tempRoot, IMPORT_STAGE_OWNER_FILE), {
        format: IMPORT_STAGE_FORMAT,
        pid: process.pid,
        startedAt: now,
        processStartedAt: PROCESS_STARTED_AT,
      });
      throwIfAborted(signal);
      // 三个调用方都传入本次新建或校验器刚生成的私有规范化对象；提交层
      // 取得其所有权并就地补齐新生命周期字段，避免大型版本历史再深克隆。
      const importedBook = migrateBookInPlace(book);
      importedBook.id = id;
      importedBook.createdAt = now;
      importedBook.updatedAt = now;
      importedBook.sections = [...sectionIds];
      await atomicWriteJson(join(tempRoot, 'book.json'), importedBook);
      throwIfAborted(signal);
      await writeSections(tempRoot);
      throwIfAborted(signal);
      await ensureDirectory(booksDir());
      // 各文件已 fsync；再刷新顶层目录，确保新建的部目录先于整书改名落盘。
      await syncDirectory(tempRoot);
      // 这是导入的提交边界：取消只在整书目录对外可见之前生效；提交后返回成功，
      // 避免客户端因一个实际成功的导入而重试并制造重复副本。
      throwIfAborted(signal);
      await durableRename(tempRoot, destination);
      // 作品已经提交成功；所有者标记不属于作品内容，失败时只告警而不诱导重试。
      await rm(join(destination, IMPORT_STAGE_OWNER_FILE), { force: true })
        .then(() => syncDirectory(destination, { afterCommit: true }))
        .catch((err) => {
          console.warn(`[store] committed book marker cleanup failed (${err?.code || 'UNKNOWN'})`);
        });
      return importedBook;
    } catch (err) {
      await rm(tempRoot, { recursive: true, force: true })
        .then(() => syncDirectory(tempParent, { afterCommit: true }))
        .catch(() => {});
      throw err;
    }
  }, { signal });
}

async function importBookBackup(snapshot, { signal, requestedBookId } = {}) {
  throwIfAborted(signal);
  const targetBookId = normalizeRequestedBookId(requestedBookId);
  const validated = validateBookBackup(snapshot);
  throwIfAborted(signal);
  return commitNewBookDirectory({
    book: validated.book,
    sectionIds: validated.sectionIds,
    signal,
    requestedBookId: targetBookId,
    writeSections: async (tempRoot) => {
      for (const sectionId of validated.sectionIds) {
        throwIfAborted(signal);
        const bundle = validated.bundles.get(sectionId);
        const sectionRoot = join(tempRoot, sectionId);
        await ensureDirectory(sectionRoot);
        const section = bundle.section;
        await atomicWriteJson(join(sectionRoot, 'section.json'), section);
        for (const chapterId of section.chapters) {
          throwIfAborted(signal);
          const chapter = bundle.chapters.get(chapterId);
          await atomicWriteJson(join(sectionRoot, `${chapterId}.json`), chapter);
        }
      }
    },
  });
}

async function writeIndexedChapter(
  reader, span, sectionRoot, validatedSection, seenChapters, signal,
  validateChapterSource, sectionOutline,
) {
  throwIfAborted(signal);
  // 在 readExact 分配缓冲区前就应用日常章节文件上限，
  // 避免整份 100 MiB 备份被伪装成一个超大章节对象。
  let rawChapter = await reader.read(span, { maxBytes: MAX_CHAPTER_JSON_BYTES });
  throwIfAborted(signal);
  const chapterId = validateBackupChapter(
    rawChapter, validatedSection.referencedChapters, seenChapters,
  );
  const chapter = normalizeBackupChapter(
    rawChapter, chapterId, validatedSection.chapterIndexes.get(chapterId),
    sectionOutline,
  );
  validateChapterSource?.(chapter);
  // 规范化对象已经与备份解析结果隔离；写盘期间不再保留可能接近
  // 32 MiB 的原始章节对象。
  rawChapter = null;
  await atomicWriteJson(join(sectionRoot, `${chapterId}.json`), chapter);
  throwIfAborted(signal);
}

async function importBookBackupFile(absPath, {
  highWaterMark, signal, requestedBookId,
} = {}) {
  throwIfAborted(signal);
  const targetBookId = normalizeRequestedBookId(requestedBookId);
  const metadata = await stat(absPath);
  throwIfAborted(signal);
  if (!metadata.isFile() || metadata.size === 0) throw new Error('BACKUP_INVALID');
  if (metadata.size > BOOK_BACKUP_MAX_BYTES) throw new Error('BACKUP_TOO_LARGE');

  let reader;
  try {
    // 初始 stat 只用于快速拒绝；打开后的流式索引仍必须独立执行同一上限，
    // 覆盖检查与 open/read 之间文件被替换或原地增长的情况。
    reader = await openIndexedBookBackup(absPath, {
      highWaterMark, signal, maxBytes: BOOK_BACKUP_MAX_BYTES,
    });
    throwIfAborted(signal);
    const topLevelValues = await Promise.all([
      reader.read(reader.index.top.format, { maxBytes: 256 }),
      reader.read(reader.index.top.version, { maxBytes: 128 }),
      reader.read(reader.index.top.book, { maxBytes: MAX_BOOK_JSON_BYTES }),
    ]);
    throwIfAborted(signal);
    const validatedBook = validateBackupBook(...topLevelValues);
    const memorySources = createActiveMemorySourceValidator(validatedBook.book);
    const worldGateSources = createActiveWorldGateSourceValidator(validatedBook.book);
    const promiseEvidenceSources = createActivePromiseEvidenceSourceValidator(validatedBook.book);
    // validatedBook.book 是新的规范化对象；整书暂存期间不应继续持有原始
    // 主数据解析树。数组槽显式清空，避免依赖引擎的局部变量活跃性分析。
    topLevelValues.fill(null);
    if (reader.index.bundles.length !== validatedBook.sectionIds.length) return invalidBackup();

    return await commitNewBookDirectory({
      book: validatedBook.book,
      sectionIds: validatedBook.sectionIds,
      signal,
      requestedBookId: targetBookId,
      writeSections: async (tempRoot) => {
        const seenSections = new Set();
        let totalChapters = 0;
        // 分部可各自接近 100 MiB。读取、规范化后立即写入
        // 对外不可见的私有暂存目录，避免在 Map 中同时保留
        // 全书所有分部；任一后续校验失败仍会整目录回滚。
        for (const indexedBundle of reader.index.bundles) {
          throwIfAborted(signal);
          let rawSection = await reader.read(
            indexedBundle.section, { maxBytes: MAX_SECTION_JSON_BYTES },
          );
          throwIfAborted(signal);
          const validatedSection = validateBackupSection(
            rawSection, validatedBook, seenSections,
          );
          validateBookSectionSummaryEntry(validatedBook.book, validatedSection.section);
          rawSection = null;
          if (indexedBundle.chapters.length !== validatedSection.referencedChapters.size) {
            return invalidBackup();
          }
          totalChapters += indexedBundle.chapters.length;
          if (totalChapters > MAX_TOTAL_BACKUP_CHAPTERS) return invalidBackup();
          const sectionId = validatedSection.sectionId;
          const sectionRoot = join(tempRoot, sectionId);
          await ensureDirectory(sectionRoot);
          await atomicWriteJson(join(sectionRoot, 'section.json'), validatedSection.section);
          const sectionOutline = validatedSection.section.outline?.content;
          // 后续逐章校验只需要引用集合和逻辑序号；大型聚合摘要等分部
          // 元数据已经落盘，可以在处理最多万章前释放。
          validatedSection.section = null;
          const seenChapters = new Set();
          for (const span of indexedBundle.chapters) {
            await writeIndexedChapter(
              reader, span, sectionRoot, validatedSection, seenChapters, signal,
              (chapter) => {
                memorySources.acceptChapter(sectionId, chapter);
                worldGateSources.acceptChapter(sectionId, chapter);
                promiseEvidenceSources.acceptChapter(sectionId, chapter);
              },
              sectionOutline,
            );
          }
          if (seenChapters.size !== validatedSection.referencedChapters.size) invalidBackup();
        }
        if (seenSections.size !== validatedBook.sectionIds.length) invalidBackup();
        memorySources.assertComplete();
        worldGateSources.assertComplete();
        promiseEvidenceSources.assertComplete();
      },
    });
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error('BACKUP_INVALID');
    if (err?.message === 'STORAGE_FILE_TOO_LARGE') throw new Error('BACKUP_TOO_LARGE');
    throw err;
  } finally {
    await reader?.close().catch(() => {});
  }
}

// ——— 序号格式化 ———

  return Object.freeze({
    cleanupAbandonedImports,
    commitNewBookDirectory,
    createBookBackup,
    importBookBackup,
    importBookBackupFile,
    writeBookBackupFile,
    writeBookManuscriptFile,
  });
}
