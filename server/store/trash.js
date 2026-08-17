import { lstat, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  MAX_ID_CHARS, MAX_TITLE_CHARS, MAX_TOTAL_BACKUP_CHAPTERS,
} from '../limits.js';
import {
  IMPORT_STAGE_FORMAT, IMPORT_STAGE_OWNER_FILE,
} from './structure-constants.js';
import { PROCESS_STARTED_AT } from './instance-lock.js';
import { withStoreLock } from './concurrency.js';
import { throwIfAborted } from './abort.js';

const MAX_TRASH_ID_CHARS = MAX_ID_CHARS + 80;
const TRASH_LIST_FULL_VALIDATION_BYTES = 2 * 1024 * 1024;

export function createTrashStore(dependencies) {
  const {
    BOOK_BACKUP_FORMAT, BOOK_BACKUP_VERSION, BOOK_DIAGNOSTIC_JSON_PROJECTION,
    advanceBookUpdatedAt, assertStorageDirectoryCapacity, atomicWriteJson,
    bookDir, bookJsonLockKey, bookSectionIds, booksDir, cleanupAbandonedImports,
    createBookId, durableRename, ensureDirectory, getDataRoot, inspectFileEntry,
    inspectJsonFile, inspectJsonProjection, isObjectRecord, migrateBookInPlace,
    migrateChapterInPlace, normalizeBackupChapter, normalizeEntityTitle, readBook,
    readSafeDirectory, recoverReferencedStructureTransactions, safeId,
    storageIdPathKey, syncDirectory, trashBooksDir, validateBackupBook,
    validateBackupChapter, validateBackupSection,
  } = dependencies;

function parseTrashId(trashId) {
  if (typeof trashId !== 'string' || trashId.length > MAX_TRASH_ID_CHARS
    || !/^[\w-]+$/.test(trashId)) {
    throw new Error('BAD_ID');
  }
  const match = trashId.match(/^(.+)__deleted_(\d{1,20})_([0-9a-f]{32})$/);
  if (!match) throw new Error('BAD_ID');
  const bookId = safeId(match[1]);
  const deletedAtMs = Number(match[2]);
  if (!Number.isSafeInteger(deletedAtMs) || deletedAtMs < 0
    || !Number.isFinite(new Date(deletedAtMs).getTime())) {
    throw new Error('BAD_ID');
  }
  return { trashId, bookId, deletedAtMs };
}

async function deleteBook(id, { expectedUpdatedAt } = {}) {
  const safeBookId = safeId(id);
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt
    || expectedUpdatedAt.length > 100) {
    throw new Error('BAD_BOOK_DELETE_ANCHOR');
  }
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    // 已提交结构事务的标记清理失败时，原操作仍会按成功返回并保留标记供
    // 幂等重放。若直接把这种目录移进回收站，恢复时会把内部标记视为额外
    // 数据并拒绝整本书。删除前先恢复所有受引用分部；只要本次发现过事务，
    // 就要求书架刷新后重试，避免把恢复中新出现的章节随旧确认一起删除。
    const recoveredStructure = await recoverReferencedStructureTransactions(safeBookId);
    const book = await readBook(safeBookId);
    if (recoveredStructure) throw new Error('STRUCTURE_TRANSACTION_RECOVERED');
    if (book.updatedAt !== expectedUpdatedAt) throw new Error('BOOK_DELETE_CONFLICT');
    return withStoreLock('trash:books', async () => {
      const deletedAt = new Date().toISOString();
      const trashId = `${safeBookId}__deleted_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
      await ensureDirectory(trashBooksDir());
      // 回收站列表使用同一个目录枚举上限；必须在移动前拒绝，否则一次
      // 表面成功的删除会让整个回收站接口随后无法读取。
      await assertStorageDirectoryCapacity(trashBooksDir(), 'TRASH_BOOK_LIMIT');
      try {
        await durableRename(bookDir(safeBookId), join(trashBooksDir(), trashId));
      } catch (err) {
        if (err?.code === 'ENOENT') throw new Error('BOOK_NOT_FOUND');
        throw err;
      }
      return { ok: true, recoverable: true, trashId, deletedAt };
    });
  });
}

async function listDeletedBooks({ signal } = {}) {
  throwIfAborted(signal);
  let entries;
  try { entries = await readSafeDirectory(trashBooksDir(), { withFileTypes: true }); }
  catch (err) { if (err?.code === 'ENOENT') return []; throw err; }
  throwIfAborted(signal);
  const deleted = [];
  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.isSymbolicLink()) {
      deleted.push({
        trashId: entry.name,
        bookId: '',
        title: '',
        deletedAt: '',
        invalid: true,
        issueCode: 'TRASH_DIRECTORY_UNSAFE',
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    let parsedTrash;
    try { parsedTrash = parseTrashId(entry.name); }
    catch {
      // 名称损坏或被人工改名的目录仍可能包含唯一的作品副本。保持可见但
      // 禁止自动恢复，避免“磁盘上存在、界面却完全消失”诱导用户误删。
      deleted.push({
        trashId: entry.name,
        bookId: '',
        title: '',
        deletedAt: '',
        invalid: true,
        issueCode: 'TRASH_DIRECTORY_NAME_INVALID',
      });
      continue;
    }
    const deletedBookPath = join(trashBooksDir(), entry.name, 'book.json');
    const fileEntry = await inspectFileEntry(deletedBookPath);
    throwIfAborted(signal);
    const validationDeferred = fileEntry.status === 'ok'
      && fileEntry.size > TRASH_LIST_FULL_VALIDATION_BYTES;
    const inspected = fileEntry.status !== 'ok'
      ? fileEntry
      : validationDeferred
        ? await inspectJsonProjection(
          deletedBookPath, BOOK_DIAGNOSTIC_JSON_PROJECTION, { signal },
        )
        : await inspectJsonFile(deletedBookPath, { signal });
    throwIfAborted(signal);
    const base = {
      trashId: entry.name,
      bookId: parsedTrash.bookId,
      deletedAt: new Date(parsedTrash.deletedAtMs).toISOString(),
    };
    // 恢复提交后若源副本清理失败，活动书与回收站副本会同时存在；后来
    // 重新创建相同 ID 也会形成同一状态。保留并显式标记副本，不能自动
    // 删除，也不要让前端继续提供一个必然 BOOK_ALREADY_EXISTS 的恢复按钮。
    let restoreBlockedByActiveBook = false;
    try {
      await lstat(bookDir(parsedTrash.bookId));
      restoreBlockedByActiveBook = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    throwIfAborted(signal);
    if (restoreBlockedByActiveBook) base.restoreBlockedByActiveBook = true;
    if (inspected.status === 'data_invalid') {
      deleted.push({
        ...base,
        title: '',
        invalid: true,
        issueCode: 'TRASH_BOOK_DATA_INVALID',
      });
      continue;
    }
    if (inspected.status !== 'ok' || !isObjectRecord(inspected.value)) {
      deleted.push({
        ...base,
        title: '',
        invalid: true,
        issueCode: `TRASH_BOOK_METADATA_${inspected.status.toUpperCase()}`,
      });
      continue;
    }
    const book = inspected.value;
    if (book.id !== parsedTrash.bookId) {
      deleted.push({
        ...base, title: '', invalid: true, issueCode: 'TRASH_BOOK_ID_MISMATCH',
      });
      continue;
    }
    if (validationDeferred) {
      try {
        bookSectionIds(book);
        if (typeof book.title !== 'string' || book.title.length > MAX_TITLE_CHARS) {
          throw new Error('TRASH_BOOK_DATA_INVALID');
        }
      } catch {
        deleted.push({
          ...base,
          title: '',
          invalid: true,
          issueCode: 'TRASH_BOOK_DATA_INVALID',
        });
        continue;
      }
      deleted.push({
        ...base,
        title: book.title,
        validationDeferred: true,
      });
      continue;
    }
    let validatedBook;
    try {
      // inspectJsonFile 返回本轮私有的解析对象；这里只做展示校验，直接
      // 惰性迁移可避免大型主数据再产生一份无意义的深副本。
      const migrated = migrateBookInPlace(book);
      validatedBook = validateBackupBook(
        BOOK_BACKUP_FORMAT, BOOK_BACKUP_VERSION, migrated,
      ).book;
    } catch {
      deleted.push({
        ...base,
        title: typeof book.title === 'string' && book.title.length <= MAX_TITLE_CHARS
          ? book.title
          : '',
        invalid: true,
        issueCode: 'TRASH_BOOK_DATA_INVALID',
      });
      continue;
    }
    deleted.push({
      ...base,
      title: validatedBook.title,
    });
  }
  return deleted.sort((a, b) => {
    const left = Date.parse(a.deletedAt);
    const right = Date.parse(b.deletedAt);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left;
    if (Number.isFinite(left) !== Number.isFinite(right)) return Number.isFinite(left) ? -1 : 1;
    return b.trashId.localeCompare(a.trashId);
  });
}

function trashInvalid() {
  throw new Error('TRASH_BOOK_INVALID');
}

function normalizeTrashData(factory) {
  try { return factory(); }
  catch (err) {
    if (err?.message === 'BACKUP_INVALID' || err?.message === 'BAD_ID'
      || err instanceof TypeError) {
      return trashInvalid();
    }
    throw err;
  }
}

async function assertOnlyExpectedEntries(absRoot, expectedNames, optionalFiles = new Set()) {
  let entries;
  try { entries = await readSafeDirectory(absRoot, { withFileTypes: true }); }
  catch (err) {
    if (err?.code === 'ENOENT') return trashInvalid();
    throw err;
  }
  const present = new Set();
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    if (optionalFiles.has(entry.name) && entry.isFile()) continue;
    const expectedType = expectedNames.get(entry.name);
    if (!expectedType
      || (expectedType === 'file' && !entry.isFile())
      || (expectedType === 'directory' && !entry.isDirectory())) {
      return trashInvalid();
    }
    present.add(entry.name);
  }
  for (const expectedName of expectedNames.keys()) {
    if (!present.has(expectedName)) return trashInvalid();
  }
}

async function stageRestoredBook(source, destination, bookId, { signal } = {}) {
  throwIfAborted(signal);
  const inspectedBook = await inspectJsonFile(join(source, 'book.json'), { signal });
  throwIfAborted(signal);
  if (inspectedBook.status !== 'ok' || !isObjectRecord(inspectedBook.value)
    || inspectedBook.value.id !== bookId) {
    return trashInvalid();
  }
  // 每个 inspected*.value 都是刚从对应文件解析出的私有对象，后续不会
  // 暴露给调用方；就地兼容迁移后再构造规范化对象，避免恢复大文件时
  // 同时保留解析对象、structuredClone 深副本和规范化对象三份数据。
  const migratedBook = normalizeTrashData(() =>
    migrateBookInPlace(inspectedBook.value));
  const validatedBook = normalizeTrashData(() =>
    validateBackupBook(BOOK_BACKUP_FORMAT, BOOK_BACKUP_VERSION, migratedBook));
  const restoredBook = validatedBook.book;
  // 恢复是一次新的作品生命周期。若继续沿用删除前的 updatedAt，另一个
  // 旧书架页仍可用原删除锚点再次删除刚恢复的作品。
  advanceBookUpdatedAt(restoredBook);

  const expectedTopEntries = new Map([['book.json', 'file']]);
  for (const sectionId of validatedBook.sectionIds) {
    expectedTopEntries.set(sectionId, 'directory');
  }
  await assertOnlyExpectedEntries(
    source, expectedTopEntries, new Set([IMPORT_STAGE_OWNER_FILE]),
  );
  throwIfAborted(signal);

  const tempParent = join(getDataRoot(), '.imports');
  const tempRoot = join(tempParent, `${createBookId()}_${randomUUID().replaceAll('-', '')}`);
  let committed = false;
  try {
    await ensureDirectory(tempRoot);
    throwIfAborted(signal);
    const startedAt = new Date().toISOString();
    await atomicWriteJson(join(tempRoot, IMPORT_STAGE_OWNER_FILE), {
      format: IMPORT_STAGE_FORMAT,
      pid: process.pid,
      startedAt,
      processStartedAt: PROCESS_STARTED_AT,
    });
    throwIfAborted(signal);
    await atomicWriteJson(join(tempRoot, 'book.json'), restoredBook);
    throwIfAborted(signal);

    const seenSections = new Set();
    let totalChapters = 0;
    for (const sectionId of validatedBook.sectionIds) {
      throwIfAborted(signal);
      const sourceSectionRoot = join(source, sectionId);
      const inspectedSection = await inspectJsonFile(
        join(sourceSectionRoot, 'section.json'), { signal },
      );
      throwIfAborted(signal);
      if (inspectedSection.status !== 'ok' || !isObjectRecord(inspectedSection.value)) {
        return trashInvalid();
      }
      const migratedSection = normalizeTrashData(() =>
        normalizeEntityTitle(inspectedSection.value, '部'));
      const validatedSection = normalizeTrashData(() =>
        validateBackupSection(migratedSection, validatedBook, seenSections));
      if (validatedSection.sectionId !== sectionId) return trashInvalid();
      totalChapters += validatedSection.chapterIds.length;
      if (totalChapters > MAX_TOTAL_BACKUP_CHAPTERS) return trashInvalid();

      const expectedSectionEntries = new Map([['section.json', 'file']]);
      for (const chapterId of validatedSection.chapterIds) {
        expectedSectionEntries.set(`${chapterId}.json`, 'file');
      }
      await assertOnlyExpectedEntries(sourceSectionRoot, expectedSectionEntries);
      throwIfAborted(signal);

      const stagedSectionRoot = join(tempRoot, sectionId);
      await ensureDirectory(stagedSectionRoot);
      await atomicWriteJson(join(stagedSectionRoot, 'section.json'), validatedSection.section);
      throwIfAborted(signal);
      const seenChapters = new Set();
      for (const chapterId of validatedSection.chapterIds) {
        throwIfAborted(signal);
        const inspectedChapter = await inspectJsonFile(
          join(sourceSectionRoot, `${chapterId}.json`), { signal },
        );
        throwIfAborted(signal);
        if (inspectedChapter.status !== 'ok' || !isObjectRecord(inspectedChapter.value)) {
          return trashInvalid();
        }
        const migratedChapter = normalizeTrashData(() =>
          migrateChapterInPlace(inspectedChapter.value));
        const storedChapterId = normalizeTrashData(() => validateBackupChapter(
          migratedChapter, validatedSection.referencedChapters, seenChapters,
        ));
        if (storedChapterId !== chapterId) return trashInvalid();
        const chapter = normalizeTrashData(() => normalizeBackupChapter(
          migratedChapter, chapterId, validatedSection.chapterIndexes.get(chapterId),
          validatedSection.section.outline?.content,
        ));
        await atomicWriteJson(join(stagedSectionRoot, `${chapterId}.json`), chapter);
        throwIfAborted(signal);
      }
      if (seenChapters.size !== validatedSection.chapterIds.length) return trashInvalid();
    }
    if (seenSections.size !== validatedBook.sectionIds.length) return trashInvalid();

    await withStoreLock('books:commit-new', async () => {
      await ensureDirectory(booksDir());
      throwIfAborted(signal);
      try {
        await stat(destination);
        throw new Error('BOOK_ALREADY_EXISTS');
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      // 恢复和新建/导入必须在同一容量锁内检查并提交；否则两个各自看到
      // 最后一个空位的操作仍可能一起把活动书架推过扫描上限。
      await assertStorageDirectoryCapacity(booksDir(), 'BOOK_LIBRARY_LIMIT');
      await syncDirectory(tempRoot);
      // 最后一个可取消点。整书改名是提交边界；提交后即使客户端断开，也必须
      // 完成标记和回收站源副本清理，不能制造半恢复状态或诱导重复恢复。
      throwIfAborted(signal);
      await durableRename(tempRoot, destination);
    }, { signal });
    committed = true;
    await rm(join(destination, IMPORT_STAGE_OWNER_FILE), { force: true })
      .then(() => syncDirectory(destination, { afterCommit: true }))
      .catch((err) => {
        console.warn(`[store] restored book marker cleanup failed (${err?.code || 'UNKNOWN'})`);
      });
    await rm(source, { recursive: true, force: true })
      .then(() => syncDirectory(trashBooksDir(), { afterCommit: true }))
      .catch((err) => {
        console.warn(`[store] restored trash cleanup failed (${err?.code || 'UNKNOWN'})`);
      });
    return restoredBook;
  } finally {
    if (!committed) {
      await rm(tempRoot, { recursive: true, force: true })
        .then(() => syncDirectory(tempParent, { afterCommit: true }))
        .catch(() => {});
    }
  }
}

async function restoreDeletedBook(trashId, { signal } = {}) {
  throwIfAborted(signal);
  const parsedTrash = parseTrashId(trashId);
  const source = join(trashBooksDir(), parsedTrash.trashId);
  const inspected = await inspectJsonFile(join(source, 'book.json'), { signal });
  throwIfAborted(signal);
  if (inspected.status === 'missing') throw new Error('TRASH_BOOK_NOT_FOUND');
  if (inspected.status !== 'ok' || !isObjectRecord(inspected.value)
    || inspected.value.id !== parsedTrash.bookId) {
    throw new Error('TRASH_BOOK_INVALID');
  }
  const bookId = parsedTrash.bookId;
  return withStoreLock(bookJsonLockKey(bookId), () =>
    withStoreLock('trash:books', async () => {
      throwIfAborted(signal);
      await cleanupAbandonedImports().catch((err) => {
        console.warn(`[store] abandoned restore cleanup failed (${err?.code || 'UNKNOWN'})`);
      });
      throwIfAborted(signal);
      try {
        await stat(bookDir(bookId));
        throw new Error('BOOK_ALREADY_EXISTS');
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      const latest = await inspectJsonFile(join(source, 'book.json'), { signal });
      throwIfAborted(signal);
      if (latest.status === 'missing') throw new Error('TRASH_BOOK_NOT_FOUND');
      if (latest.status !== 'ok' || !isObjectRecord(latest.value)
        || latest.value.id !== bookId) {
        throw new Error('TRASH_BOOK_INVALID');
      }
      return stageRestoredBook(source, bookDir(bookId), bookId, { signal });
    }, { signal }), { signal });
}

  return Object.freeze({
    deleteBook,
    listDeletedBooks,
    restoreDeletedBook,
  });
}
