import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normalizeApiProfileLibrary } from '../api-profile-schema.js';
import { normalizeWritingAssetLibrary } from '../writing-asset-schema.js';
import {
  MAX_BOOK_DIRECTORY_ENTRIES, MAX_BOOK_SECTIONS, MAX_SECTION_CHAPTERS,
  MAX_SECTION_DIRECTORY_ENTRIES, MAX_STORAGE_DIAGNOSTIC_ISSUES, MAX_TITLE_CHARS,
  MAX_TOTAL_BOOK_CHAPTERS,
} from '../limits.js';
import { isValidStoredConfig } from './config.js';
import { mapWithConcurrency, withStoreLock } from './concurrency.js';
import { throwIfAborted } from './abort.js';
import { isValidVersioned } from './versioned.js';
import {
  BOOK_STRUCTURE_TRANSACTION_FILE, CHAPTER_DIGEST_TRANSACTION_FILE,
  SECTION_STRUCTURE_TRANSACTION_FILE,
} from './structure-constants.js';

export async function diagnoseStorage(dependencies, options = {}) {
  const {
    BOOK_DIAGNOSTIC_JSON_PROJECTION, SECTION_DIAGNOSTIC_JSON_PROJECTION,
    backupFormat, backupVersion, bookJsonLockKey, booksDir, getDataRoot,
    hasReadableBookSummaryMetadata, isObjectRecord, isValidBookStructureTransaction,
    isValidChapterDigestTransaction, isValidSectionStructureTransaction,
    inspectFileEntry, inspectJsonFile, inspectJsonProjection,
    migrateBookInPlace, migrateChapterInPlace, normalizeBackupChapter,
    normalizeEntityTitle, readSafeDirectory, readStoredJson,
    readStoredJsonProjection, safeId, storageIdPathKey, validateBackupBook,
    validateBackupChapter, validateBackupSection,
  } = dependencies;
  const dataRoot = getDataRoot();


// atomicWriteJson 的临时名包含目标文件名、PID、毫秒时间戳和随机 UUID。
// 诊断只识别这个高约束格式及当前层允许的目标，避免把用户普通文件误报。
const ATOMIC_WRITE_TEMP_NAME = /^(.*)\.(\d{1,10})\.(\d{10,16})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;

function atomicWriteTempTarget(name) {
  const match = ATOMIC_WRITE_TEMP_NAME.exec(name);
  return match?.[1] || null;
}

function isBookAtomicWriteTarget(target) {
  return target === 'book.json' || target === BOOK_STRUCTURE_TRANSACTION_FILE;
}

function isDataRootAtomicWriteTarget(target) {
  return target === 'config.json' || target === 'writing-assets.json'
    || target === 'api-profiles.json';
}

function isSectionAtomicWriteTarget(target) {
  if (target === 'section.json' || target === SECTION_STRUCTURE_TRANSACTION_FILE
    || target === CHAPTER_DIGEST_TRANSACTION_FILE) return true;
  const match = target.match(/^([\w-]+)\.json$/);
  if (!match) return false;
  try { safeId(match[1]); return true; }
  catch { return false; }
}

function atomicWriteTempIssue(entry, targetValidator) {
  const target = atomicWriteTempTarget(entry.name);
  if (!target || !targetValidator(target)) return null;
  return entry.isSymbolicLink()
    ? 'ATOMIC_WRITE_TEMP_UNSAFE'
    : entry.isFile() ? 'ATOMIC_WRITE_TEMP_PENDING' : null;
}

function compareStorageIssues(a, b) {
  const left = `${a.bookId}\0${a.sectionId ?? ''}\0${a.chapterId ?? ''}\0${a.code}\0${a.path ?? ''}`;
  const right = `${b.bookId}\0${b.sectionId ?? ''}\0${b.chapterId ?? ''}\0${b.code}\0${b.path ?? ''}`;
  return left.localeCompare(right);
}

async function bookStructureTransactionDiagnosticCode({
  inspected, bookId, bookRoot, book, signal,
}) {
  if (inspected.status === 'missing') return null;
  if (inspected.status !== 'ok') {
    return `BOOK_STRUCTURE_TRANSACTION_${inspected.status.toUpperCase()}`;
  }
  const tx = inspected.value;
  if (!isValidBookStructureTransaction(tx, bookId)) {
    return 'BOOK_STRUCTURE_TRANSACTION_INVALID';
  }
  if (!isObjectRecord(book) || !Array.isArray(book.sections)
    || book.sections.includes(tx.sectionId)) {
    return 'BOOK_STRUCTURE_TRANSACTION_PENDING';
  }
  const target = await inspectJsonFile(
    join(bookRoot, tx.sectionId, 'section.json'), { signal },
  );
  throwIfAborted(signal);
  if (target.status !== 'missing'
    && !(target.status === 'ok' && isDeepStrictEqual(target.value, tx.section))) {
    return 'BOOK_STRUCTURE_TRANSACTION_TARGET_CONFLICT';
  }
  return 'BOOK_STRUCTURE_TRANSACTION_PENDING';
}

async function sectionStructureTransactionDiagnosticCode({
  inspected, bookId, sectionId, sectionRoot, section, signal,
}) {
  if (inspected.status === 'missing') return null;
  if (inspected.status !== 'ok') {
    return `SECTION_STRUCTURE_TRANSACTION_${inspected.status.toUpperCase()}`;
  }
  const tx = inspected.value;
  if (!isValidSectionStructureTransaction(tx, bookId, sectionId)) {
    return 'SECTION_STRUCTURE_TRANSACTION_INVALID';
  }
  if (tx.type !== 'add-chapter' || !isObjectRecord(section)
    || !Array.isArray(section.chapters) || section.chapters.includes(tx.chapterId)) {
    return 'SECTION_STRUCTURE_TRANSACTION_PENDING';
  }
  const target = await inspectJsonFile(
    join(sectionRoot, `${tx.chapterId}.json`), { signal },
  );
  throwIfAborted(signal);
  if (target.status !== 'missing'
    && !(target.status === 'ok' && isDeepStrictEqual(target.value, tx.chapter))) {
    return 'SECTION_STRUCTURE_TRANSACTION_TARGET_CONFLICT';
  }
  return 'SECTION_STRUCTURE_TRANSACTION_PENDING';
}

async function chapterDigestTransactionDiagnosticCode({
  inspected, bookId, sectionId, sectionRoot, section, deep, signal,
}) {
  if (inspected.status === 'missing') return null;
  if (inspected.status !== 'ok') {
    return `CHAPTER_DIGEST_TRANSACTION_${inspected.status.toUpperCase()}`;
  }
  if (!isValidChapterDigestTransaction(inspected.value, bookId, sectionId)) {
    return 'CHAPTER_DIGEST_TRANSACTION_INVALID';
  }
  if (isObjectRecord(section) && Array.isArray(section.chapters)
    && !section.chapters.includes(inspected.value.chapterId)) {
    return 'CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT';
  }
  if (deep && isObjectRecord(section) && Array.isArray(section.chapters)
    && section.chapters.includes(inspected.value.chapterId)) {
    const target = await inspectJsonFile(
      join(sectionRoot, `${inspected.value.chapterId}.json`), { signal },
    );
    throwIfAborted(signal);
    if (target.status === 'ok' && isObjectRecord(target.value)) {
      try {
        const chapter = migrateChapterInPlace(target.value);
        if (chapter.id === inspected.value.chapterId
          && isValidVersioned(chapter.body)
          && chapter.bodyFingerprint !== inspected.value.bodyFingerprint) {
          return 'CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT';
        }
      } catch {
        // 章节自身的形状错误由后续深检给出更具体的 CHAPTER_DATA_INVALID。
      }
    }
  }
  return 'CHAPTER_DIGEST_TRANSACTION_PENDING';
}

// 只读完整性检查：不修复、不删除。除损坏 JSON 外，也检查多文件更新中断后
// 可能留下的“父索引已引用但文件缺失”和“文件存在但父索引未引用”。
const runDiagnostics = async ({ deep = false, signal } = {}) => {
  throwIfAborted(signal);
  const rootIssues = [];
  const issueBudget = { remaining: MAX_STORAGE_DIAGNOSTIC_ISSUES, truncated: false };
  const addBoundedIssue = (target, code, ids) => {
    if (issueBudget.remaining <= 0) {
      issueBudget.truncated = true;
      return false;
    }
    issueBudget.remaining -= 1;
    target.push({ code, ...ids });
    return true;
  };
  const shouldStopDetailedScan = () => {
    if (issueBudget.remaining > 0) return false;
    issueBudget.truncated = true;
    return true;
  };

  let dataRootEntries;
  try {
    dataRootEntries = await readSafeDirectory(dataRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        ok: true,
        mode: deep ? 'deep' : 'quick',
        scannedBooks: 0,
        totalBooks: 0,
        truncated: false,
        issueLimit: MAX_STORAGE_DIAGNOSTIC_ISSUES,
        issues: [],
      };
    }
    throwIfAborted(signal);
    const code = err?.message === 'STORAGE_DIRECTORY_LIMIT_EXCEEDED'
      ? 'DATA_DIRECTORY_LIMIT_EXCEEDED'
      : err?.message === 'STORAGE_PATH_UNSAFE'
        ? 'DATA_DIRECTORY_UNSAFE'
        : err?.message === 'STORAGE_PATH_INVALID'
          ? 'DATA_DIRECTORY_INVALID'
          : 'DATA_DIRECTORY_UNREADABLE';
    return {
      ok: false,
      mode: deep ? 'deep' : 'quick',
      scannedBooks: 0,
      totalBooks: 0,
      truncated: false,
      issueLimit: MAX_STORAGE_DIAGNOSTIC_ISSUES,
      issues: [{ code, bookId: 'data' }],
    };
  }
  throwIfAborted(signal);
  for (const entry of dataRootEntries) {
    throwIfAborted(signal);
    const tempIssue = atomicWriteTempIssue(entry, isDataRootAtomicWriteTarget);
    if (tempIssue) {
      addBoundedIssue(rootIssues, tempIssue, { bookId: 'data', path: entry.name });
    }
  }
  const inspectedConfig = await inspectJsonFile(join(dataRoot, 'config.json'), { signal });
  throwIfAborted(signal);
  if (inspectedConfig.status !== 'missing') {
    if (inspectedConfig.status !== 'ok') {
      addBoundedIssue(
        rootIssues,
        `CONFIG_METADATA_${inspectedConfig.status.toUpperCase()}`,
        { bookId: 'data/config.json' },
      );
    } else if (!isValidStoredConfig(inspectedConfig.value)) {
      addBoundedIssue(rootIssues, 'CONFIG_DATA_INVALID', { bookId: 'data/config.json' });
    }
  }
  const inspectedWritingAssets = await inspectJsonFile(
    join(dataRoot, 'writing-assets.json'), { signal },
  );
  throwIfAborted(signal);
  if (inspectedWritingAssets.status !== 'missing') {
    if (inspectedWritingAssets.status !== 'ok') {
      addBoundedIssue(
        rootIssues,
        `WRITING_ASSETS_METADATA_${inspectedWritingAssets.status.toUpperCase()}`,
        { bookId: 'data/writing-assets.json' },
      );
    } else {
      try { normalizeWritingAssetLibrary(inspectedWritingAssets.value); }
      catch {
        addBoundedIssue(
          rootIssues, 'WRITING_ASSETS_DATA_INVALID',
          { bookId: 'data/writing-assets.json' },
        );
      }
    }
  }
  const inspectedApiProfiles = await inspectJsonFile(
    join(dataRoot, 'api-profiles.json'), { signal },
  );
  throwIfAborted(signal);
  if (inspectedApiProfiles.status !== 'missing') {
    if (inspectedApiProfiles.status !== 'ok') {
      addBoundedIssue(
        rootIssues,
        `API_PROFILES_METADATA_${inspectedApiProfiles.status.toUpperCase()}`,
        { bookId: 'data/api-profiles.json' },
      );
    } else {
      try { normalizeApiProfileLibrary(inspectedApiProfiles.value); }
      catch {
        addBoundedIssue(
          rootIssues, 'API_PROFILES_DATA_INVALID',
          { bookId: 'data/api-profiles.json' },
        );
      }
    }
  }

  let entries;
  try {
    entries = await readSafeDirectory(booksDir(), { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        ok: rootIssues.length === 0,
        mode: deep ? 'deep' : 'quick',
        scannedBooks: 0,
        totalBooks: 0,
        truncated: issueBudget.truncated,
        issueLimit: MAX_STORAGE_DIAGNOSTIC_ISSUES,
        issues: rootIssues.sort(compareStorageIssues),
      };
    }
    // 完整性检查本身必须能解释最外层作品目录为何无法扫描。若这里把
    // 枚举上限、符号链接或权限错误直接抛成 500，书架只会显示“检查
    // 失败”，用户既看不到具体风险，也可能误以为只是暂时的接口故障。
    // 与单书/单部目录保持同一原则：返回非健康的有界结果，但不跟随、
    // 修复或删除现场内容。
    throwIfAborted(signal);
    const code = err?.message === 'STORAGE_DIRECTORY_LIMIT_EXCEEDED'
      ? 'BOOKS_DIRECTORY_LIMIT_EXCEEDED'
      : err?.message === 'STORAGE_PATH_UNSAFE'
        ? 'BOOKS_DIRECTORY_UNSAFE'
        : err?.message === 'STORAGE_PATH_INVALID'
          ? 'BOOKS_DIRECTORY_INVALID'
          : 'BOOKS_DIRECTORY_UNREADABLE';
    addBoundedIssue(rootIssues, code, { bookId: 'data/books' });
    return {
      ok: false,
      mode: deep ? 'deep' : 'quick',
      scannedBooks: 0,
      totalBooks: 0,
      truncated: issueBudget.truncated,
      issueLimit: MAX_STORAGE_DIAGNOSTIC_ISSUES,
      issues: rootIssues.sort(compareStorageIssues),
    };
  }
  throwIfAborted(signal);

  // 不跟随符号链接。普通文件（如 .DS_Store）忽略，但目录和符号链接必须显式报告，
  // 避免非法超长目录让检查本身失效或悄悄藏在书架旁边。
  const bookEntries = [];
  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.isSymbolicLink()) {
      addBoundedIssue(rootIssues, 'BOOK_DIRECTORY_UNSAFE', { bookId: entry.name });
      continue;
    }
    if (!entry.isDirectory()) continue;
    try { safeId(entry.name); }
    catch {
      addBoundedIssue(rootIssues, 'BOOK_DIRECTORY_ID_INVALID', { bookId: entry.name });
      continue;
    }
    bookEntries.push(entry);
  }
  bookEntries.sort((a, b) => a.name.localeCompare(b.name));
  let scannedBooks = 0;
  const issueGroups = await mapWithConcurrency(bookEntries, 4, async (entry) => {
    throwIfAborted(signal);
    if (shouldStopDetailedScan()) return [];
    const bookId = entry.name;
    // 合法结构事务在提交期间也会短暂存在。所有运行时作品写入都持有
    // book-json 锁，诊断进入同一锁域后，只有崩溃残留事务才会被报告为 pending，
    // 不会把另一标签页正在进行的正常增删误判为数据损坏。
    return withStoreLock(bookJsonLockKey(bookId), async () => {
      throwIfAborted(signal);
      if (shouldStopDetailedScan()) return [];
      const root = join(booksDir(), bookId);
      try { await lstat(root); }
      catch (err) {
        // 目录枚举后作品可能已被另一个已加锁请求移入回收站；这不是损坏。
        if (err?.code === 'ENOENT') return [];
        throw err;
      }
      throwIfAborted(signal);
      scannedBooks += 1;
      const localIssues = [];
      const addIssue = (code, ids) => addBoundedIssue(localIssues, code, ids);

    let bookChildEntries = [];
    if (!shouldStopDetailedScan()) {
      try {
        bookChildEntries = await readSafeDirectory(
          root, { withFileTypes: true }, MAX_BOOK_DIRECTORY_ENTRIES,
        );
      } catch (err) {
        throwIfAborted(signal);
        if (err?.code !== 'ENOENT') {
          if (err?.message === 'STORAGE_DIRECTORY_LIMIT_EXCEEDED') {
            addIssue('BOOK_DIRECTORY_LIMIT_EXCEEDED', { bookId });
          } else {
            // 即使 book.json 同时损坏，枚举失败也要作为独立风险保留。
            addIssue('BOOK_DIRECTORY_UNREADABLE', { bookId });
          }
        }
      }
    }
    for (const child of bookChildEntries) {
      throwIfAborted(signal);
      if (shouldStopDetailedScan()) break;
      const tempIssue = atomicWriteTempIssue(child, isBookAtomicWriteTarget);
      if (tempIssue) addIssue(tempIssue, { bookId, path: child.name });
    }
    if (shouldStopDetailedScan()) return localIssues;

    const inspectedBookTransaction = await inspectJsonFile(
      join(root, BOOK_STRUCTURE_TRANSACTION_FILE),
      { signal },
    );
    const inspectedBook = deep
      ? await inspectJsonFile(join(root, 'book.json'), { signal })
      : await inspectJsonProjection(
        join(root, 'book.json'), BOOK_DIAGNOSTIC_JSON_PROJECTION, { signal },
      );
    const bookTransactionIssue = await bookStructureTransactionDiagnosticCode({
      inspected: inspectedBookTransaction,
      bookId,
      bookRoot: root,
      book: inspectedBook.status === 'ok' ? inspectedBook.value : null,
      signal,
    });
    if (bookTransactionIssue) addIssue(bookTransactionIssue, { bookId });
    if (inspectedBook.status === 'data_invalid') {
      addIssue('BOOK_DATA_INVALID', { bookId });
      return localIssues;
    }
    if (inspectedBook.status !== 'ok') {
      addIssue(`BOOK_METADATA_${inspectedBook.status.toUpperCase()}`, { bookId });
      return localIssues;
    }
    const book = inspectedBook.value;
    if (!isObjectRecord(book)) {
      addIssue('BOOK_METADATA_INVALID_SHAPE', { bookId });
      return localIssues;
    }
    if (book.id !== bookId) addIssue('BOOK_ID_MISMATCH', { bookId });
    if (!Array.isArray(book.sections)) {
      addIssue('BOOK_SECTIONS_INVALID', { bookId });
      return localIssues;
    }
    if (book.sections.length > MAX_BOOK_SECTIONS) {
      addIssue('BOOK_SECTIONS_LIMIT_EXCEEDED', { bookId });
    }

    // 轻检必须至少覆盖书架摘要自身的过滤条件。否则 title / updatedAt
    // 损坏会让作品从书架消失，自动诊断却仍声称健康，只能靠用户偶然手动深检发现。
    let reportedBookDataInvalid = false;
    if (!hasReadableBookSummaryMetadata(book)) {
      addIssue('BOOK_DATA_INVALID', { bookId });
      reportedBookDataInvalid = true;
    }

    let validatedBook = null;
    if (deep) {
      try {
        // 诊断读取返回的是本轮私有对象；直接迁移可避免在深检大型文件时
        // 为纯校验额外复制完整版本历史。
        const migratedBook = migrateBookInPlace(book);
        validatedBook = validateBackupBook(
          backupFormat, backupVersion, migratedBook,
        );
        if (validatedBook.originalBookId !== bookId) validatedBook = null;
      } catch {
        validatedBook = null;
      }
      if (!validatedBook && !reportedBookDataInvalid) {
        addIssue('BOOK_DATA_INVALID', { bookId });
      }
    }

    const referencedSections = new Set();
    const referencedSectionPaths = new Set();
    const deeplySeenSections = new Set();
    let totalChapterReferences = 0;
    let reportedBookChapterLimit = false;
    for (const rawSectionId of book.sections.slice(0, MAX_BOOK_SECTIONS)) {
      throwIfAborted(signal);
      if (shouldStopDetailedScan()) break;
      try { safeId(rawSectionId); }
      catch {
        addIssue('SECTION_ID_INVALID', { bookId });
        continue;
      }
      const sectionId = rawSectionId;
      const sectionPathKey = storageIdPathKey(sectionId);
      if (referencedSectionPaths.has(sectionPathKey)) {
        addIssue('SECTION_REFERENCE_DUPLICATE', { bookId, sectionId });
        continue;
      }
      referencedSections.add(sectionId);
      referencedSectionPaths.add(sectionPathKey);
      const sectionRoot = join(root, sectionId);
      let sectionEntries = [];
      let sectionEntriesReadable = false;
      try {
        sectionEntries = await readSafeDirectory(
          sectionRoot, { withFileTypes: true }, MAX_SECTION_DIRECTORY_ENTRIES,
        );
        sectionEntriesReadable = true;
      } catch (err) {
        throwIfAborted(signal);
        if (err?.code !== 'ENOENT') {
          if (err?.message === 'STORAGE_DIRECTORY_LIMIT_EXCEEDED') {
            addIssue('SECTION_DIRECTORY_LIMIT_EXCEEDED', { bookId, sectionId });
          } else {
            // 目录不可枚举时，无法证明没有孤立章节或取证临时文件。
            addIssue('SECTION_DIRECTORY_UNREADABLE', { bookId, sectionId });
          }
        }
        // 深检仍可按已知引用逐文件读取；轻检则在后面回退到 lstat。
      }
      throwIfAborted(signal);
      for (const child of sectionEntries) {
        if (shouldStopDetailedScan()) break;
        const tempIssue = atomicWriteTempIssue(child, isSectionAtomicWriteTarget);
        if (tempIssue) {
          addIssue(tempIssue, { bookId, sectionId, path: child.name });
        }
      }
      if (shouldStopDetailedScan()) break;
      const inspectedSectionTransaction = await inspectJsonFile(
        join(sectionRoot, SECTION_STRUCTURE_TRANSACTION_FILE),
        { signal },
      );
      throwIfAborted(signal);
      const inspectedDigestTransaction = await inspectJsonFile(
        join(sectionRoot, CHAPTER_DIGEST_TRANSACTION_FILE),
        { signal },
      );
      throwIfAborted(signal);
      const inspectedSection = deep
        ? await inspectJsonFile(join(sectionRoot, 'section.json'), { signal })
        : await inspectJsonProjection(
          join(sectionRoot, 'section.json'), SECTION_DIAGNOSTIC_JSON_PROJECTION, { signal },
        );
      throwIfAborted(signal);
      const sectionTransactionIssue = await sectionStructureTransactionDiagnosticCode({
        inspected: inspectedSectionTransaction,
        bookId,
        sectionId,
        sectionRoot,
        section: inspectedSection.status === 'ok' ? inspectedSection.value : null,
        signal,
      });
      if (sectionTransactionIssue) {
        addIssue(sectionTransactionIssue, { bookId, sectionId });
      }
      const digestTransactionIssue = await chapterDigestTransactionDiagnosticCode({
        inspected: inspectedDigestTransaction,
        bookId,
        sectionId,
        sectionRoot,
        section: inspectedSection.status === 'ok' ? inspectedSection.value : null,
        deep,
        signal,
      });
      if (digestTransactionIssue) {
        addIssue(digestTransactionIssue, { bookId, sectionId });
      }
      if (inspectedSection.status === 'data_invalid') {
        addIssue('SECTION_DATA_INVALID', { bookId, sectionId });
        continue;
      }
      if (inspectedSection.status !== 'ok') {
        addIssue(`SECTION_METADATA_${inspectedSection.status.toUpperCase()}`, { bookId, sectionId });
        continue;
      }
      const section = inspectedSection.value;
      if (!isObjectRecord(section)) {
        addIssue('SECTION_METADATA_INVALID_SHAPE', { bookId, sectionId });
        continue;
      }
      if (section.id !== sectionId) addIssue('SECTION_ID_MISMATCH', { bookId, sectionId });
      let reportedSectionDataInvalid = false;
      if (typeof section.title !== 'string' || section.title.length > MAX_TITLE_CHARS) {
        addIssue('SECTION_DATA_INVALID', { bookId, sectionId });
        reportedSectionDataInvalid = true;
      }
      if (!Array.isArray(section.chapters)) {
        addIssue('SECTION_CHAPTERS_INVALID', { bookId, sectionId });
        continue;
      }
      if (section.chapters.length > MAX_SECTION_CHAPTERS) {
        addIssue('SECTION_CHAPTERS_LIMIT_EXCEEDED', { bookId, sectionId });
      }
      totalChapterReferences += Math.min(section.chapters.length, MAX_SECTION_CHAPTERS);
      if (!reportedBookChapterLimit && totalChapterReferences > MAX_TOTAL_BOOK_CHAPTERS) {
        addIssue('BOOK_CHAPTERS_LIMIT_EXCEEDED', { bookId });
        reportedBookChapterLimit = true;
      }

      let validatedSection = null;
      if (deep && validatedBook) {
        try {
          const migratedSection = normalizeEntityTitle(section, '部');
          validatedSection = validateBackupSection(
            migratedSection, validatedBook, deeplySeenSections,
          );
          if (validatedSection.sectionId !== sectionId) validatedSection = null;
        } catch {
          validatedSection = null;
        }
        if (!validatedSection && !reportedSectionDataInvalid) {
          addIssue('SECTION_DATA_INVALID', { bookId, sectionId });
        }
      }

      const referencedChapters = new Set();
      const referencedChapterPaths = new Set();
      const chapterIds = [];
      for (const rawChapterId of section.chapters.slice(0, MAX_SECTION_CHAPTERS)) {
        throwIfAborted(signal);
        if (shouldStopDetailedScan()) break;
        try { safeId(rawChapterId); }
        catch {
          addIssue('CHAPTER_ID_INVALID', { bookId, sectionId });
          continue;
        }
        const chapterId = rawChapterId;
        const chapterPathKey = storageIdPathKey(chapterId);
        if (referencedChapterPaths.has(chapterPathKey)) {
          addIssue('CHAPTER_REFERENCE_DUPLICATE', { bookId, sectionId, chapterId });
          continue;
        }
        referencedChapters.add(chapterId);
        referencedChapterPaths.add(chapterPathKey);
        chapterIds.push(chapterId);
      }
      const sectionEntryByName = new Map(sectionEntries.map((entry) => [entry.name, entry]));
      const deeplySeenChapters = new Set();
      await mapWithConcurrency(chapterIds, 16, async (chapterId) => {
        throwIfAborted(signal);
        if (shouldStopDetailedScan()) return;
        const chapterPath = join(sectionRoot, `${chapterId}.json`);
        let inspectedChapter;
        if (deep) {
          inspectedChapter = await inspectJsonFile(chapterPath, { signal });
        } else if (sectionEntriesReadable) {
          const entry = sectionEntryByName.get(`${chapterId}.json`);
          inspectedChapter = {
            status: !entry
              ? 'missing'
              : entry.isSymbolicLink() ? 'unsafe' : entry.isFile() ? 'ok' : 'invalid_shape',
          };
        } else {
          inspectedChapter = await inspectFileEntry(chapterPath);
        }
        throwIfAborted(signal);
        if (inspectedChapter.status !== 'ok') {
          addIssue(
            `CHAPTER_FILE_${inspectedChapter.status.toUpperCase()}`,
            { bookId, sectionId, chapterId },
          );
          return;
        }
        if (!deep) return;
        const chapter = inspectedChapter.value;
        if (!isObjectRecord(chapter)) {
          addIssue('CHAPTER_FILE_INVALID_SHAPE', { bookId, sectionId, chapterId });
        } else if (chapter.id !== chapterId) {
          addIssue('CHAPTER_ID_MISMATCH', { bookId, sectionId, chapterId });
        } else if (validatedSection) {
          try {
            const migratedChapter = migrateChapterInPlace(chapter);
            const validatedChapterId = validateBackupChapter(
              migratedChapter, validatedSection.referencedChapters, deeplySeenChapters,
            );
            if (validatedChapterId !== chapterId) throw new Error('CHAPTER_ID_MISMATCH');
            normalizeBackupChapter(
              migratedChapter, chapterId, validatedSection.chapterIndexes.get(chapterId),
              validatedSection.section.outline?.content,
            );
          } catch {
            addIssue('CHAPTER_DATA_INVALID', { bookId, sectionId, chapterId });
          }
        }
      });

      for (const child of sectionEntries) {
        throwIfAborted(signal);
        if (shouldStopDetailedScan()) break;
        const match = child.isFile() && child.name !== 'section.json'
          ? child.name.match(/^([\w-]+)\.json$/)
          : null;
        if (match && !referencedChapters.has(match[1])) {
          addIssue('CHAPTER_FILE_ORPHANED', { bookId, sectionId, chapterId: match[1] });
        }
      }
    }

    for (const child of bookChildEntries) {
      throwIfAborted(signal);
      if (shouldStopDetailedScan()) break;
      if (child.isDirectory() && !referencedSections.has(child.name)) {
        try { safeId(child.name); }
        catch { continue; }
        addIssue('SECTION_DIRECTORY_ORPHANED', { bookId, sectionId: child.name });
      }
    }
      return localIssues;
    }, { signal });
  });

  throwIfAborted(signal);

  const issues = [...rootIssues, ...issueGroups.flat()].sort(compareStorageIssues);
  return {
    ok: issues.length === 0 && !issueBudget.truncated,
    mode: deep ? 'deep' : 'quick',
    scannedBooks,
    totalBooks: bookEntries.length,
    truncated: issueBudget.truncated,
    issueLimit: MAX_STORAGE_DIAGNOSTIC_ISSUES,
    issues,
  };
}


  return runDiagnostics(options);
}
