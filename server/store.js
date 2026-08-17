import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MAX_BOOK_BACKUP_BYTES, MAX_BOOK_SECTIONS, MAX_DAILY_WORD_GOAL, MAX_ID_CHARS,
  MAX_DIGEST_PROGRESS_CHARS, MAX_DIGEST_SUMMARY_CHARS, MAX_PREMISE_CHARS,
  MAX_SECTION_CHAPTERS, MAX_TITLE_CHARS, MAX_TOTAL_BOOK_CHAPTERS,
  MAX_VERSION_HISTORY_ITEMS, MAX_VERSION_TEXT_CHARS,
} from './limits.js';
import {
  MAX_PLATFORM_CONFIRMATIONS, PLATFORM_CONFIRMATION_ID_PATTERN,
  normalizePlatformConfirmationInput, normalizePlatformConfirmations,
  platformGovernanceView,
} from './platform-governance-schema.js';
import { createApiProfileStore } from './store/api-profiles.js';
import { createConfigStore, isValidStoredConfig } from './store/config.js';
import {
  mapWithConcurrency, resetStoreLocks, withJsonReadSlot, withStoreLock,
} from './store/concurrency.js';
import { createStoreContext } from './store/context.js';
import { throwIfAborted } from './store/abort.js';
import { createBackupSchema } from './store/backup-schema.js';
import { createBackupStore } from './store/backups.js';
import { diagnoseStorage as runStorageDiagnostics } from './store/diagnostics.js';
import { createStoreIo } from './store/io.js';
import { createStorageInspector } from './store/inspection.js';
import { createMemoryStore } from './store/memory.js';
import { createChapterWorkflowStore } from './store/chapter-workflows.js';
import { createStructureStore } from './store/structure.js';
import { createTrashStore } from './store/trash.js';
import { createInstanceLockStore } from './store/instance-lock.js';
import {
  contentFingerprint, currentText, emptyVersioned, jsonFingerprint, migrateVersioned,
  versionRevision,
} from './store/versioned.js';
import { createWritingAssetStore } from './store/writing-assets.js';
import { createPromiseLedgerStore } from './store/promise-ledger.js';
import { createCharacterCraftStore } from './store/character-craft.js';
import { createGoldenThreeReviewStore } from './store/golden-three-review.js';
import { normalizeChapterPlan } from './chapter-plan-schema.js';
import { normalizeChapterHandoff } from './chapter-handoff-schema.js';
import {
  emptyStoryEngine, normalizeStoryEngine, storyEngineRevision, storyEngineView,
} from './story-engine-schema.js';
import { emptyPromiseLedger, normalizePromiseLedger } from './promise-ledger-schema.js';
import { emptyCharacterCraft, normalizeCharacterCraft } from './character-craft-schema.js';
import { normalizeStoredGoldenThreeReview } from './golden-three-review-schema.js';
import {
  emptyWorldProgressState, normalizeWorldProgressState,
} from './world-progress-schema.js';

export { mapWithConcurrency, withJsonReadSlot, withStoreLock } from './store/concurrency.js';
export {
  assertExpectedVersionRevision, commitVersion, contentFingerprint, currentText,
  emptyVersioned, migrateVersioned, moveCursor, pushHistory, rollback, versionRevision,
} from './store/versioned.js';
export { writingAssetContextForLibrary } from './store/writing-assets.js';
export { createStageSummaryId } from './stage-summary-schema.js';
export { chapterPlanRevision, chapterPlanView } from './chapter-plan-schema.js';
export { storyEngineView } from './story-engine-schema.js';
export { throwIfAborted } from './store/abort.js';
export {
  createCachedProcessStartedAtResolver, isProcessAlive, processOwnerIsAlive,
  processStartedAtMsForPid,
} from './store/instance-lock.js';

let DATA_ROOT = join(process.cwd(), 'data');
const storeIo = createStoreIo({ getDataRoot: () => DATA_ROOT, throwIfAborted });
const {
  assertSafeStoragePath, assertStorageDirectoryCapacity, atomicWriteJson,
  durableRename, ensureDataSubdirectory, ensureDirectory, readSafeDirectory,
  readStoredJson, readStoredJsonProjection, syncCommittedDirectories, syncDirectory,
} = storeIo;
const {
  inspectFileEntry, inspectJsonFile, inspectJsonProjection,
} = createStorageInspector({ readStoredJson, readStoredJsonProjection, throwIfAborted });
const instanceLockStore = createInstanceLockStore({
  getDataRoot: () => DATA_ROOT,
  ensureDirectory,
  syncDirectory,
});
const storeContext = createStoreContext({
  getDataRoot: () => DATA_ROOT,
  ensureDirectory,
  readStoredJson,
  atomicWriteJson,
  withStoreLock,
  throwIfAborted,
  safeId,
  readBook,
});
const configStore = createConfigStore(storeContext);
const apiProfileStore = createApiProfileStore(storeContext, configStore);
const writingAssetStore = createWritingAssetStore(storeContext);

export { atomicWriteJson, ensureDataSubdirectory, syncCommittedDirectories };
export const acquireDataRootLease = instanceLockStore.acquireDataRootLease;

export const configRevision = configStore.configRevision;
export const readConfig = configStore.readConfig;
export const writeConfig = configStore.writeConfig;
export const activateApiProfile = apiProfileStore.activateApiProfile;
export const apiProfilesRevision = apiProfileStore.apiProfilesRevision;
export const deleteApiProfile = apiProfileStore.deleteApiProfile;
export const readApiProfiles = apiProfileStore.readApiProfiles;
export const readConfigForTask = apiProfileStore.readConfigForTask;
export const readConfigForTaskSelection = apiProfileStore.readConfigForTaskSelection;
export const saveApiBookBinding = apiProfileStore.saveApiBookBinding;
export const saveApiProfile = apiProfileStore.saveApiProfile;
export const saveApiTaskRoutes = apiProfileStore.saveApiTaskRoutes;
export const addWritingAsset = writingAssetStore.addWritingAsset;
export const addWritingAssetReference = writingAssetStore.addWritingAssetReference;
export const deleteWritingAsset = writingAssetStore.deleteWritingAsset;
export const exportWritingAssets = writingAssetStore.exportWritingAssets;
export const findWritingAssetDuplicate = writingAssetStore.findWritingAssetDuplicate;
export const readWritingAssetContext = writingAssetStore.readWritingAssetContext;
export const readWritingAssets = writingAssetStore.readWritingAssets;
export const saveWritingAssetBookBinding = writingAssetStore.saveWritingAssetBookBinding;
export const writingAssetsRevision = writingAssetStore.writingAssetsRevision;

export function setDataRoot(p) {
  DATA_ROOT = p;
  resetStoreLocks();
}
export function getDataRoot() { return DATA_ROOT; }
const booksDir = () => join(DATA_ROOT, 'books');
const trashBooksDir = () => join(DATA_ROOT, 'trash', 'books');
// 白名单校验：防止 '../' 之类路径遍历。合法 id 只允许字母/数字/下划线/连字符。
// `section` 作为章节 ID 时会把 `<id>.json` 映射到分部元数据 `section.json`；
// 大小写不敏感文件系统上其变体同样冲突。Windows 设备名即使带 `.json`
// 扩展名也不是普通文件名，因此统一拒绝，避免导入后覆盖元数据或无法迁移。
const RESERVED_STORAGE_ID_PATTERN = /^(?:section|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export function safeId(id) {
  if (typeof id !== 'string' || id.length > MAX_ID_CHARS || !/^[\w-]+$/.test(id)
    || RESERVED_STORAGE_ID_PATTERN.test(id)) {
    throw new Error('BAD_ID');
  }
  return id;
}

function normalizeTitleInput(title) {
  if (title === undefined) return '';
  if (typeof title !== 'string') throw new Error('BAD_TITLE');
  if (title.length > MAX_TITLE_CHARS) throw new Error('TITLE_TOO_LARGE');
  return title.trim();
}
const bookDir = (id) => join(booksDir(), safeId(id));
const bookJsonLockKey = (bookId) => `book:${safeId(bookId)}:book-json`;
const sectionFileLockKey = (bookId, sectionId) =>
  `book:${safeId(bookId)}:section:${safeId(sectionId)}:section-file`;
const chapterFileLockKey = (bookId, sectionId, chapterId) =>
  `book:${safeId(bookId)}:section:${safeId(sectionId)}:chapter:${safeId(chapterId)}:file`;




function emptyOutline() { return emptyVersioned(); }
export const DEFAULT_DAILY_WORD_GOAL = 2_000;
const TITLE_SOURCES = new Set(['default', 'ai', 'manual']);
const CN_NUM = '零一二三四五六七八九十百千两';

function validDailyWordGoal(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_DAILY_WORD_GOAL;
}

function serializationSettings(value, { errorCode = 'BAD_PLATFORM_CONFIRMATION' } = {}) {
  return {
    dailyWordGoal: validDailyWordGoal(value?.dailyWordGoal)
      ? value.dailyWordGoal
      : DEFAULT_DAILY_WORD_GOAL,
    platformConfirmations: normalizePlatformConfirmations(
      value?.platformConfirmations, { errorCode },
    ),
  };
}

function emptyCore() {
  return { core: {
    world: emptyVersioned(), style: emptyVersioned(),
    constraints: emptyVersioned(), pacing: emptyVersioned(),
  }, storyEngine: emptyStoryEngine(), promiseLedger: emptyPromiseLedger(),
  characterCraft: emptyCharacterCraft(),
  worldProgressState: emptyWorldProgressState(),
  history: [], serialization: serializationSettings() };
}

function createBookId() {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  return `book_${ts}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

const REQUESTED_BOOK_ID_PATTERN = /^book_[0-9a-f]{32}$/;

function normalizeRequestedBookId(requestedBookId) {
  if (requestedBookId === undefined) return undefined;
  if (typeof requestedBookId !== 'string' || !REQUESTED_BOOK_ID_PATTERN.test(requestedBookId)) {
    throw new Error('BAD_BOOK_CREATION_ID');
  }
  return requestedBookId;
}

function defaultBookTitleFromPremise(value) {
  const premise = typeof value === 'string' ? value.trim() : '';
  return Array.from(premise).slice(0, 20).join('');
}

function assertStoredRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('STORAGE_DATA_INVALID');
  }
  return value;
}

export async function createBook({ premise, title, requestedBookId }) {
  if (typeof premise !== 'string' || !premise.trim()) throw new Error('BAD_PREMISE');
  if (premise.length > MAX_PREMISE_CHARS) throw new Error('PREMISE_TOO_LARGE');
  const cleanPremise = premise.trim();
  const cleanTitle = normalizeTitleInput(title);
  const targetBookId = normalizeRequestedBookId(requestedBookId);
  const hasExplicitTitle = cleanTitle !== '';
  const book = {
    title: hasExplicitTitle ? cleanTitle : defaultBookTitleFromPremise(cleanPremise),
    titleSource: hasExplicitTitle ? 'manual' : 'default',
    premise: cleanPremise, outline: emptyOutline(), settings: emptyCore(),
    characters: [], summary: '', sectionSummaries: {}, stageSummaries: [],
    progress: '', sections: [],
    memory: { facts: [], rejectedCandidateIds: [] },
  };
  // 与备份导入共用“暂存完整目录 → fsync → 整目录原子改名”提交原语，
  // 避免在最终 books/ 下留下只有目录、没有 book.json 的半本新书。
  return commitNewBookDirectory({
    book,
    sectionIds: [],
    requestedBookId: targetBookId,
    writeSections: async () => {},
  });
}

export async function readBook(id, { signal } = {}) {
  try {
    const book = assertStoredRecord(
      await readStoredJson(join(bookDir(id), 'book.json'), { signal }),
    );
    return migrateBookInPlace(book);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('BOOK_NOT_FOUND');
    throw err;  // 权限/磁盘/JSON 解析等真实故障原样上抛，不掩盖
  }
}

function advanceBookUpdatedAt(book) {
  const now = Date.now();
  const previous = typeof book.updatedAt === 'string' ? Date.parse(book.updatedAt) : NaN;
  // 同一毫秒内的连续写入也必须产生不同锚点，否则旧书架可能无法识别
  // 另一标签页刚完成的保存。正常 ISO 时间按至少 1ms 单调递增。
  const next = Number.isFinite(previous) && previous >= now ? previous + 1 : now;
  const nextDate = new Date(next);
  book.updatedAt = Number.isFinite(nextDate.getTime())
    ? nextDate.toISOString()
    : new Date(now).toISOString();
  return book.updatedAt;
}

async function writeBookUnlocked(id, book) {
  advanceBookUpdatedAt(book);
  await atomicWriteJson(join(bookDir(id), 'book.json'), book);
}

export async function writeBook(id, book) {
  const safeBookId = safeId(id);
  return withStoreLock(bookJsonLockKey(safeBookId), () => writeBookUnlocked(safeBookId, book));
}

const promiseLedgerStore = createPromiseLedgerStore({
  bookJsonLockKey, readBook, safeId, throwIfAborted, withStoreLock, writeBookUnlocked,
});
export const deletePromiseLedgerEntry = promiseLedgerStore.deletePromiseLedgerEntry;
export const readPromiseLedger = promiseLedgerStore.readPromiseLedger;
export const savePromiseLedgerEntry = promiseLedgerStore.savePromiseLedgerEntry;

const characterCraftStore = createCharacterCraftStore({
  bookJsonLockKey, readBook, safeId, throwIfAborted, withStoreLock, writeBookUnlocked,
});
export const deleteCharacterCraftEntry = characterCraftStore.deleteCharacterCraftEntry;
export const readCharacterCraft = characterCraftStore.readCharacterCraft;
export const saveCharacterGuide = characterCraftStore.saveCharacterGuide;
export const saveRelationshipGuide = characterCraftStore.saveRelationshipGuide;

async function touchBookUnlocked(id) {
  const book = await readBook(id);
  await writeBookUnlocked(id, book);
}

async function touchBook(id) {
  const safeBookId = safeId(id);
  return withStoreLock(bookJsonLockKey(safeBookId), () => touchBookUnlocked(safeBookId));
}

function hasReadableBookSummaryMetadata(book) {
  return typeof book?.title === 'string'
    && book.title.length <= MAX_TITLE_CHARS
    && typeof book?.updatedAt === 'string'
    && book.updatedAt.length <= 100
    && Number.isFinite(Date.parse(book.updatedAt));
}

const maxJsonStringBytes = (maxChars) => maxChars * 6 + 2;
const BOOK_SECTION_REFERENCES_JSON_PROJECTION = Object.freeze({
  sections: {
    type: 'stringArray',
    maxItems: MAX_BOOK_SECTIONS,
    itemMaxBytes: maxJsonStringBytes(MAX_ID_CHARS),
  },
});
const BOOK_SUMMARY_JSON_PROJECTION = Object.freeze({
  ...BOOK_SECTION_REFERENCES_JSON_PROJECTION,
  title: { type: 'string', maxBytes: maxJsonStringBytes(MAX_TITLE_CHARS) },
  updatedAt: { type: 'string', maxBytes: maxJsonStringBytes(100) },
});
const SECTION_SUMMARY_JSON_PROJECTION = Object.freeze({
  chapters: {
    type: 'stringArray',
    maxItems: MAX_SECTION_CHAPTERS,
    itemMaxBytes: maxJsonStringBytes(MAX_ID_CHARS),
  },
});
const BOOK_DIAGNOSTIC_JSON_PROJECTION = Object.freeze({
  ...BOOK_SUMMARY_JSON_PROJECTION,
  id: { type: 'string', maxBytes: maxJsonStringBytes(MAX_ID_CHARS) },
});
const SECTION_DIAGNOSTIC_JSON_PROJECTION = Object.freeze({
  ...SECTION_SUMMARY_JSON_PROJECTION,
  id: { type: 'string', maxBytes: maxJsonStringBytes(MAX_ID_CHARS) },
  title: {
    type: 'string', maxBytes: maxJsonStringBytes(MAX_TITLE_CHARS), maxChars: MAX_TITLE_CHARS,
  },
});
const SECTION_TREE_JSON_PROJECTION = Object.freeze({
  ...SECTION_DIAGNOSTIC_JSON_PROJECTION,
  titleSource: { type: 'string', maxBytes: maxJsonStringBytes(20) },
});
const VERSIONED_TEXT_PRESENCE_JSON_FIELD = Object.freeze({
  type: 'versionedTextPresence',
  maxItems: MAX_VERSION_HISTORY_ITEMS,
  itemMaxBytes: maxJsonStringBytes(MAX_VERSION_TEXT_CHARS),
  itemMaxChars: MAX_VERSION_TEXT_CHARS,
});
const VERSIONED_TEXT_STATS_JSON_FIELD = Object.freeze({
  type: 'versionedTextStats',
  maxItems: MAX_VERSION_HISTORY_ITEMS,
  itemMaxBytes: maxJsonStringBytes(MAX_VERSION_TEXT_CHARS),
  itemMaxChars: MAX_VERSION_TEXT_CHARS,
});
const CHAPTER_TREE_JSON_PROJECTION = Object.freeze({
  id: {
    type: 'string', maxBytes: maxJsonStringBytes(MAX_ID_CHARS), maxChars: MAX_ID_CHARS,
  },
  title: {
    type: 'string', maxBytes: maxJsonStringBytes(MAX_TITLE_CHARS), maxChars: MAX_TITLE_CHARS,
  },
  titleSource: { type: 'string', maxBytes: maxJsonStringBytes(20) },
  body: VERSIONED_TEXT_STATS_JSON_FIELD,
  bodyFingerprint: { type: 'string', maxBytes: maxJsonStringBytes(43), maxChars: 43 },
  review: {
    type: 'currentReviewSummary', fingerprintMaxBytes: maxJsonStringBytes(43),
  },
  published: {
    type: 'publishedChapterSummary',
    contentMaxBytes: maxJsonStringBytes(MAX_VERSION_TEXT_CHARS),
    contentMaxChars: MAX_VERSION_TEXT_CHARS,
    fingerprintMaxBytes: maxJsonStringBytes(43),
    publishedAtMaxBytes: maxJsonStringBytes(100),
  },
});
const CHAPTER_PREFLIGHT_JSON_PROJECTION = Object.freeze({
  id: {
    type: 'string', maxBytes: maxJsonStringBytes(MAX_ID_CHARS), maxChars: MAX_ID_CHARS,
  },
  title: {
    type: 'string', maxBytes: maxJsonStringBytes(MAX_TITLE_CHARS), maxChars: MAX_TITLE_CHARS,
  },
  bodyFingerprint: { type: 'string', maxBytes: maxJsonStringBytes(43), maxChars: 43 },
});
const CHAPTER_COMPLETION_JSON_PROJECTION = Object.freeze({
  id: {
    type: 'string', maxBytes: maxJsonStringBytes(MAX_ID_CHARS), maxChars: MAX_ID_CHARS,
  },
  body: VERSIONED_TEXT_PRESENCE_JSON_FIELD,
  progress: {
    type: 'string',
    maxBytes: maxJsonStringBytes(MAX_DIGEST_PROGRESS_CHARS),
    maxChars: MAX_DIGEST_PROGRESS_CHARS,
  },
});
const CHAPTER_DIGEST_SUMMARY_JSON_PROJECTION = Object.freeze({
  id: {
    type: 'string', maxBytes: maxJsonStringBytes(MAX_ID_CHARS), maxChars: MAX_ID_CHARS,
  },
  // 摘要上限按 Unicode 码点计数；200 个辅助平面字符
  // 会占 400 个 UTF-16 单元，字节投影需要覆盖这个合法最坏值。
  summary: {
    type: 'string',
    maxBytes: maxJsonStringBytes(MAX_DIGEST_SUMMARY_CHARS * 2),
  },
});

async function readBookSummaryUnlocked(id, { signal } = {}) {
  // 书架只依赖三个顶层字段。严格扫描完整 JSON 以继续发现非法 UTF-8、
  // 重复键和尾随损坏，但不再把最高 128 MiB 的版本历史整体物化进内存。
  const b = await readStoredJsonProjection(
    join(bookDir(id), 'book.json'), BOOK_SUMMARY_JSON_PROJECTION, { signal },
  );
  throwIfAborted(signal);
  const sectionIds = bookSectionIds(b);
  if (!hasReadableBookSummaryMetadata(b)) return null;
  const counts = await mapWithConcurrency(sectionIds, 8, async (sid) => {
    throwIfAborted(signal);
    try {
      const sec = await readStoredJsonProjection(
        join(bookDir(id), safeId(sid), 'section.json'),
        SECTION_SUMMARY_JSON_PROJECTION,
        { signal },
      );
      throwIfAborted(signal);
      return sectionChapterIds(sec).length;
    } catch {
      throwIfAborted(signal);
      // 缺失或损坏的部由完整性诊断报告，书架摘要继续加载其它作品。
    }
    return 0;
  });
  throwIfAborted(signal);
  const chapterCount = counts.reduce((sum, count) => sum + count, 0);
  if (chapterCount > MAX_TOTAL_BOOK_CHAPTERS) return null;
  return {
    // 目录名才是后续 API 的寻址依据；内部 id 不一致由完整性诊断提示。
    id,
    title: b.title,
    updatedAt: b.updatedAt,
    sectionCount: sectionIds.length,
    chapterCount,
  };
}

export async function listBooks({ signal } = {}) {
  throwIfAborted(signal);
  let entries = [];
  try { entries = await readSafeDirectory(booksDir(), { withFileTypes: true }); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  throwIfAborted(signal);
  // 与完整性诊断一致：普通文件不是作品，符号链接由诊断单独告警。
  const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const rows = await mapWithConcurrency(ids, 8, async (id) => {
    throwIfAborted(signal);
    try {
      return await withStoreLock(
        bookJsonLockKey(id),
        () => readBookSummaryUnlocked(id, { signal }),
        { signal },
      );
    } catch (err) {
      if (err.code === 'ENOENT') return null;  // 非书目录（无 book.json）跳过
      if (err.message === 'BAD_ID') return null;  // 非法目录名（如 .DS_Store）跳过
      if (err instanceof SyntaxError) return null;  // 损坏的书目录跳过，避免拖垮整个书架
      if (err.message === 'STORAGE_FILE_TOO_LARGE') return null;
      if (err.message === 'STORAGE_PATH_UNSAFE') return null;
      // book.json 被误建为目录、FIFO 等非普通文件时，完整性诊断会报告
      // BOOK_METADATA_INVALID_SHAPE；摘要列表应隔离这一册，不能让其它健康
      // 作品也从书架消失。books/ 根本身的形态异常在进入 mapper 前仍会抛出。
      if (err.message === 'STORAGE_PATH_INVALID') return null;
      if (STORAGE_REFERENCE_ERRORS.has(err.message)) return null;
      throw err;  // 其余错误上抛
    }
  });
  throwIfAborted(signal);
  return rows.filter(Boolean).sort((a, b) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id.localeCompare(a.id));
}

const isObjectRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const storageIdPathKey = (id) => id.toLowerCase();

const STORAGE_REFERENCE_ERRORS = new Set([
  'BOOK_SECTIONS_INVALID', 'BOOK_SECTIONS_LIMIT_EXCEEDED',
  'SECTION_CHAPTERS_INVALID', 'SECTION_CHAPTERS_LIMIT_EXCEEDED',
  'BOOK_CHAPTERS_LIMIT_EXCEEDED',
]);

function storedReferenceIds(values, { invalidCode, limitCode, maxItems }) {
  if (!Array.isArray(values)) throw new Error(invalidCode);
  if (values.length > maxItems) throw new Error(limitCode);
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    let id;
    try { id = safeId(value); }
    catch { throw new Error(invalidCode); }
    const pathKey = storageIdPathKey(id);
    if (seen.has(pathKey)) throw new Error(invalidCode);
    seen.add(pathKey);
    ids.push(id);
  }
  return ids;
}

function bookSectionIds(book) {
  return storedReferenceIds(book?.sections, {
    invalidCode: 'BOOK_SECTIONS_INVALID',
    limitCode: 'BOOK_SECTIONS_LIMIT_EXCEEDED',
    maxItems: MAX_BOOK_SECTIONS,
  });
}

function sectionChapterIds(section) {
  return storedReferenceIds(section?.chapters, {
    invalidCode: 'SECTION_CHAPTERS_INVALID',
    limitCode: 'SECTION_CHAPTERS_LIMIT_EXCEEDED',
    maxItems: MAX_SECTION_CHAPTERS,
  });
}

async function readSectionChapterReferences(bookId, sectionId, { signal } = {}) {
  let projected;
  try {
    projected = await readStoredJsonProjection(
      join(bookDir(bookId), sectionId, 'section.json'),
      SECTION_SUMMARY_JSON_PROJECTION,
      { signal, projectionInvalidError: 'STORAGE_PROJECTED_DATA_INVALID' },
    );
  } catch (error) {
    if (error?.message !== 'STORAGE_PROJECTED_DATA_INVALID') throw error;
    // 引用本身异常时保留原有错误分类（超量 / 非法 ID）；
    // 正常的大型聚合分部始终走流式投影。
    projected = await readSection(bookId, sectionId, { signal });
  }
  throwIfAborted(signal);
  return sectionChapterIds(projected);
}

async function countBookChapterReferences(bookId, sectionIds, knownSection, { signal } = {}) {
  throwIfAborted(signal);
  const counts = await mapWithConcurrency(sectionIds, 4, async (sectionId) => {
    throwIfAborted(signal);
    const chapterIds = knownSection?.id === sectionId
      ? sectionChapterIds(knownSection)
      : await readSectionChapterReferences(bookId, sectionId, { signal });
    return chapterIds.length;
  });
  throwIfAborted(signal);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total > MAX_TOTAL_BOOK_CHAPTERS) throw new Error('BOOK_CHAPTERS_LIMIT_EXCEEDED');
  return total;
}

export function diagnoseStorage(options = {}) {
  return runStorageDiagnostics({
    BOOK_DIAGNOSTIC_JSON_PROJECTION,
    SECTION_DIAGNOSTIC_JSON_PROJECTION,
    backupFormat: BOOK_BACKUP_FORMAT,
    backupVersion: BOOK_BACKUP_VERSION,
    bookJsonLockKey,
    booksDir,
    getDataRoot: () => DATA_ROOT,
    hasReadableBookSummaryMetadata,
    inspectFileEntry,
    inspectJsonFile,
    inspectJsonProjection,
    isObjectRecord,
    isValidBookStructureTransaction,
    isValidChapterDigestTransaction,
    isValidSectionStructureTransaction,
    migrateBookInPlace,
    migrateChapterInPlace,
    normalizeBackupChapter,
    normalizeEntityTitle,
    readSafeDirectory,
    readStoredJson,
    readStoredJsonProjection,
    safeId,
    storageIdPathKey,
    validateBackupBook,
    validateBackupChapter,
    validateBackupSection,
  }, options);
}


export const BOOK_BACKUP_FORMAT = 'auto-novel-box-book-backup';
const BOOK_BACKUP_VERSION = 1;
export const BOOK_BACKUP_MAX_BYTES = MAX_BOOK_BACKUP_BYTES;
export const MANUSCRIPT_EXPORT_MAX_BYTES = MAX_BOOK_BACKUP_BYTES;
const backupSchema = createBackupSchema({
  backupFormat: BOOK_BACKUP_FORMAT,
  backupVersion: BOOK_BACKUP_VERSION,
  isObjectRecord,
  migrateBookTitleInPlace,
  migrateChapterInPlace,
  normalizeEntityTitle,
  safeId,
  serializationSettings,
  storageIdPathKey,
  titleSources: TITLE_SOURCES,
  validDailyWordGoal,
});
const {
  backupText, normalizeBackupBookMemory, normalizeBackupChapter,
  normalizeBackupStageSummaries,
  normalizeStoredChapter, validateBackupBook, validateBackupChapter,
  validateBackupSection, validateStoredBook, validateStoredData,
  validateStoredSection,
} = backupSchema;
const structureStore = createStructureStore({
  CHAPTER_TREE_JSON_PROJECTION,
  SECTION_TREE_JSON_PROJECTION,
  TITLE_SOURCES,
  assertStoredRecord,
  atomicWriteJson,
  bookDir,
  bookJsonLockKey,
  bookSectionIds,
  booksDir,
  buildSectionSummary: (...args) => memoryStore.buildSectionSummary(...args),
  chapterFileLockKey,
  countBookChapterReferences,
  ensureDirectory,
  inspectJsonFile,
  invalidateDeletedChapterMemory: (...args) =>
    memoryStore.invalidateDeletedChapterMemory(...args),
  isObjectRecord,
  migrateChapterInPlace,
  normalizeEntityTitle,
  normalizeStoredChapter,
  normalizeTitleInput,
  readBook,
  readSafeDirectory,
  readSectionChapterReferences,
  readStoredJson,
  readStoredJsonProjection,
  recoverChapterDigestTransaction: (...args) =>
    memoryStore.recoverChapterDigestTransaction(...args),
  safeId,
  sectionChapterIds,
  sectionFileLockKey,
  sectionPlanContextRevision: (...args) =>
    chapterWorkflowStore.sectionPlanContextRevision(...args),
  serializationSettingsView,
  storageIdPathKey,
  stripGeneratedTitleDescription,
  syncDirectory,
  touchBookUnlocked,
  updateBookSectionSummary: (...args) => memoryStore.updateBookSectionSummary(...args),
  validateStoredBook,
  validateStoredSection,
  writeBookUnlocked,
});
const {
  assertChapterReferenced,
  bookStructureTransactionPath,
  chapterDigestTransactionPath,
  clearCommittedTransaction,
  isValidBookStructureTransaction,
  isValidChapterDigestTransaction,
  isValidSectionStructureTransaction,
  readChapter,
  readReferencedChapter,
  readReferencedSection,
  readSection,
  recoverReferencedStructureTransactions,
  sectionStructureTransactionPath,
  withChapterWriteLocks,
  writeChapterFile,
} = structureStore;
export { readChapter, readReferencedChapter, readReferencedSection, readSection };
export const addChapter = structureStore.addChapter;
export const addSection = structureStore.addSection;
export const deleteChapter = structureStore.deleteChapter;
export const readBookStructure = structureStore.readBookStructure;
export const readChapterSummary = structureStore.readChapterSummary;
export const recoverInterruptedTransactions = structureStore.recoverInterruptedTransactions;
export const writeChapter = structureStore.writeChapter;
export const writeSection = structureStore.writeSection;
const backupStore = createBackupStore({
  BOOK_BACKUP_FORMAT,
  BOOK_BACKUP_MAX_BYTES,
  BOOK_BACKUP_VERSION,
  BOOK_SECTION_REFERENCES_JSON_PROJECTION,
  MANUSCRIPT_EXPORT_MAX_BYTES,
  SECTION_SUMMARY_JSON_PROJECTION,
  assertStorageDirectoryCapacity,
  atomicWriteJson,
  backupSchema,
  bookDir,
  bookJsonLockKey,
  booksDir,
  createBookId,
  durableRename,
  ensureDirectory,
  getDataRoot: () => DATA_ROOT,
  inspectJsonFile,
  isObjectRecord,
  migrateBookInPlace,
  normalizeRequestedBookId,
  readBook,
  readChapter,
  readSafeDirectory,
  readSection,
  readStoredJsonProjection,
  recoverReferencedStructureTransactions,
  safeId,
  storageIdPathKey,
  syncDirectory,
  validDailyWordGoal,
});
const { commitNewBookDirectory } = backupStore;
export const cleanupAbandonedImports = backupStore.cleanupAbandonedImports;
export const createBookBackup = backupStore.createBookBackup;
export const importBookBackup = backupStore.importBookBackup;
export const importBookBackupFile = backupStore.importBookBackupFile;
export const writeBookBackupFile = backupStore.writeBookBackupFile;
export const writeBookManuscriptFile = backupStore.writeBookManuscriptFile;

const trashStore = createTrashStore({
  BOOK_BACKUP_FORMAT,
  BOOK_BACKUP_VERSION,
  BOOK_DIAGNOSTIC_JSON_PROJECTION,
  advanceBookUpdatedAt,
  assertStorageDirectoryCapacity,
  atomicWriteJson,
  bookDir,
  bookJsonLockKey,
  bookSectionIds,
  booksDir,
  cleanupAbandonedImports,
  createBookId,
  durableRename,
  ensureDirectory,
  getDataRoot: () => DATA_ROOT,
  inspectFileEntry,
  inspectJsonFile,
  inspectJsonProjection,
  isObjectRecord,
  migrateBookInPlace,
  migrateChapterInPlace,
  normalizeBackupChapter,
  normalizeEntityTitle,
  readBook,
  readSafeDirectory,
  recoverReferencedStructureTransactions,
  safeId,
  storageIdPathKey,
  syncDirectory,
  trashBooksDir,
  validateBackupBook,
  validateBackupChapter,
  validateBackupSection,
});
export const deleteBook = trashStore.deleteBook;
export const listDeletedBooks = trashStore.listDeletedBooks;
export const restoreDeletedBook = trashStore.restoreDeletedBook;

function stripGeneratedTitleDescription(title) {
  const raw = typeof title === 'string' ? title.trim() : '';
  const pure = raw.split(/[:：]/, 1)[0].trim();
  return pure || raw;
}

function normalizeEntityTitle(entity, unit) {
  if (TITLE_SOURCES.has(entity.titleSource)) {
    if (entity.titleSource === 'ai') entity.title = stripGeneratedTitleDescription(entity.title);
    return entity;
  }
  const raw = typeof entity.title === 'string' ? entity.title.trim() : '';
  const ordinal = `第\\s*(?:\\d+|[${CN_NUM}]+)\\s*${unit}`;
  const onlyOrdinal = new RegExp(`^${ordinal}$`);
  const withPrefix = new RegExp(`^${ordinal}\\s*[·:：\\-—]?\\s*(.*)$`);
  if (!raw || onlyOrdinal.test(raw)) {
    entity.title = '';
    entity.titleSource = 'default';
    return entity;
  }
  const m = raw.match(withPrefix);
  entity.title = (m ? m[1] : raw).trim();
  entity.titleSource = 'manual';
  return entity;
}

function migrateBookTitleInPlace(book) {
  if (!TITLE_SOURCES.has(book.titleSource)) {
    const premise = typeof book.premise === 'string' ? book.premise : '';
    // 只按旧版规则识别缺少 titleSource 的历史默认书名，避免把用户恰好
    // 取成“清理后设想前 20 字”的人工标题误判为可自动覆盖的默认标题。
    const legacyFallback = premise.slice(0, 20);
    book.titleSource = book.title === legacyFallback ? 'default' : 'manual';
  }
  return book;
}

export function serializationSettingsRevision(value) {
  return jsonFingerprint(serializationSettings(value));
}
export async function saveStoryEngine(bookId, value, {
  expectedRevision, signal,
} = {}) {
  if (typeof expectedRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedRevision)) {
    throw new Error('BAD_STORY_ENGINE_REVISION');
  }
  const storyEngine = normalizeStoryEngine(value);
  const safeBookId = safeId(bookId);
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId, { signal });
    if (storyEngineRevision(book.settings.storyEngine) !== expectedRevision) {
      throw new Error('STORY_ENGINE_CONFLICT');
    }
    if (storyEngineRevision(storyEngine) === expectedRevision) {
      return storyEngineView(storyEngine);
    }
    throwIfAborted(signal);
    book.settings.storyEngine = storyEngine;
    await writeBookUnlocked(safeBookId, book);
    return storyEngineView(book.settings.storyEngine);
  }, { signal });
}
export function serializationSettingsView(value) {
  const normalized = serializationSettings(value);
  const governance = platformGovernanceView(normalized.platformConfirmations);
  return {
    ...normalized,
    platformConfirmations: governance.confirmations,
    syncPolicy: governance.syncPolicy,
    revision: serializationSettingsRevision(normalized),
  };
}
export async function updateBookSerializationSettings(bookId, {
  dailyWordGoal, expectedRevision, signal,
} = {}) {
  if (!validDailyWordGoal(dailyWordGoal)) throw new Error('BAD_DAILY_WORD_GOAL');
  if (typeof expectedRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedRevision)) {
    throw new Error('BAD_SERIALIZATION_REVISION');
  }
  const safeBookId = safeId(bookId);
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId, { signal });
    if (serializationSettingsRevision(book.settings.serialization) !== expectedRevision) {
      throw new Error('SERIALIZATION_CONFLICT');
    }
    throwIfAborted(signal);
    book.settings.serialization = {
      ...serializationSettings(book.settings.serialization), dailyWordGoal,
    };
    await writeBookUnlocked(safeBookId, book);
    return serializationSettingsView(book.settings.serialization);
  }, { signal });
}
export async function savePlatformConfirmation(bookId, input, {
  expectedRevision, signal,
} = {}) {
  if (typeof expectedRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedRevision)) {
    throw new Error('BAD_SERIALIZATION_REVISION');
  }
  const requestedId = input?.id;
  if (requestedId !== undefined
    && (typeof requestedId !== 'string'
      || !PLATFORM_CONFIRMATION_ID_PATTERN.test(requestedId))) {
    throw new Error('BAD_PLATFORM_CONFIRMATION_ID');
  }
  const safeBookId = safeId(bookId);
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId, { signal });
    if (serializationSettingsRevision(book.settings.serialization) !== expectedRevision) {
      throw new Error('SERIALIZATION_CONFLICT');
    }
    const settings = serializationSettings(book.settings.serialization);
    const existingIndex = requestedId === undefined
      ? -1
      : settings.platformConfirmations.findIndex((item) => item.id === requestedId);
    if (requestedId !== undefined && existingIndex < 0) {
      throw new Error('PLATFORM_CONFIRMATION_NOT_FOUND');
    }
    if (existingIndex < 0 && settings.platformConfirmations.length >= MAX_PLATFORM_CONFIRMATIONS) {
      throw new Error('PLATFORM_CONFIRMATION_LIMIT');
    }
    const id = requestedId ?? `platform_${randomUUID().replaceAll('-', '')}`;
    const confirmation = normalizePlatformConfirmationInput(input, {
      id, checkedAt: new Date().toISOString(),
    });
    const duplicate = settings.platformConfirmations.find((item, index) =>
      index !== existingIndex
      && item.platform.toLocaleLowerCase('zh-CN')
        === confirmation.platform.toLocaleLowerCase('zh-CN'));
    if (duplicate) throw new Error('PLATFORM_CONFIRMATION_DUPLICATE');
    if (existingIndex < 0) settings.platformConfirmations.push(confirmation);
    else settings.platformConfirmations[existingIndex] = confirmation;
    throwIfAborted(signal);
    book.settings.serialization = settings;
    await writeBookUnlocked(safeBookId, book);
    return serializationSettingsView(settings);
  }, { signal });
}
export async function deletePlatformConfirmation(bookId, confirmationId, {
  expectedRevision, signal,
} = {}) {
  if (typeof confirmationId !== 'string'
    || !PLATFORM_CONFIRMATION_ID_PATTERN.test(confirmationId)) {
    throw new Error('BAD_PLATFORM_CONFIRMATION_ID');
  }
  if (typeof expectedRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedRevision)) {
    throw new Error('BAD_SERIALIZATION_REVISION');
  }
  const safeBookId = safeId(bookId);
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId, { signal });
    if (serializationSettingsRevision(book.settings.serialization) !== expectedRevision) {
      throw new Error('SERIALIZATION_CONFLICT');
    }
    const settings = serializationSettings(book.settings.serialization);
    const index = settings.platformConfirmations.findIndex(
      (item) => item.id === confirmationId,
    );
    if (index < 0) throw new Error('PLATFORM_CONFIRMATION_NOT_FOUND');
    settings.platformConfirmations.splice(index, 1);
    throwIfAborted(signal);
    book.settings.serialization = settings;
    await writeBookUnlocked(safeBookId, book);
    return serializationSettingsView(settings);
  }, { signal });
}
// ——— 惰性迁移辅助（读盘时把老结构就地升级为新结构）———
function migrateBookInPlace(book) {
  migrateBookTitleInPlace(book);
  book.outline = migrateVersioned(book.outline);
  book.settings = book.settings || { core: {}, history: [] };
  const core = book.settings.core || {};
  for (const f of ['world', 'style', 'constraints', 'pacing']) core[f] = migrateVersioned(core[f]);
  book.settings.core = core;
  book.settings.storyEngine = normalizeStoryEngine(book.settings.storyEngine, {
    errorCode: 'STORAGE_DATA_INVALID', sizeErrorCode: 'STORAGE_DATA_INVALID',
  });
  book.settings.promiseLedger = normalizePromiseLedger(book.settings.promiseLedger, {
    errorCode: 'STORAGE_DATA_INVALID', sizeErrorCode: 'STORAGE_DATA_INVALID',
  });
  book.settings.characterCraft = normalizeCharacterCraft(book.settings.characterCraft, {
    errorCode: 'STORAGE_DATA_INVALID', sizeErrorCode: 'STORAGE_DATA_INVALID',
  });
  book.settings.goldenThreeReview = normalizeStoredGoldenThreeReview(
    book.settings.goldenThreeReview,
  );
  book.settings.worldProgressState = normalizeWorldProgressState(
    book.settings.worldProgressState,
    { errorCode: 'STORAGE_DATA_INVALID', sizeErrorCode: 'STORAGE_DATA_INVALID' },
  );
  if (book.settings.serialization === undefined) {
    book.settings.serialization = serializationSettings();
  } else if (book.settings.serialization.platformConfirmations === undefined) {
    book.settings.serialization.platformConfirmations = [];
  }
  if (book.sectionSummaries === undefined) book.sectionSummaries = {};
  if (book.stageSummaries === undefined) book.stageSummaries = [];
  if (book.memory === undefined) book.memory = { facts: [], rejectedCandidateIds: [] };
  return book;
}
function migrateChapterInPlace(ch) {
  normalizeEntityTitle(ch, '章');
  ch.body = migrateVersioned(ch.body && Array.isArray(ch.body.versions)
    ? ch.body
    : { content: ch.content, history: ch.history });
  ch.content = currentText(ch.body);  // 派生只读
  ch.bodyFingerprint = contentFingerprint(ch.content);
  if (ch.memoryCandidates === undefined) ch.memoryCandidates = [];
  ch.handoff = normalizeChapterHandoff(ch.handoff, {
    errorCode: 'STORAGE_DATA_INVALID', sizeErrorCode: 'STORAGE_DATA_INVALID',
  });
  ch.plan = normalizeChapterPlan(ch.plan, {
    errorCode: 'STORAGE_DATA_INVALID', sizeErrorCode: 'STORAGE_DATA_INVALID',
  });
  delete ch.history;                  // 老字段清理
  return ch;
}
// 版本路径解析（白名单，防注入）
export function parseVersionPath(path) {
  if (typeof path !== 'string') throw new Error('BAD_PATH');
  if (path === 'outline') return { type: 'outline' };
  const core = path.match(/^core:(world|style|constraints|pacing)$/);
  if (core) return { type: 'core', field: core[1] };
  const ch = path.match(/^section:([\w-]+):chapter:([\w-]+)$/);
  if (ch) return { type: 'chapter', sectionId: safeId(ch[1]), chapterId: safeId(ch[2]) };
  throw new Error('BAD_PATH');
}
// 全局配置与 API 方案库由 store/config.js 和 store/api-profiles.js 提供；
// 本文件只保留兼容 facade 与跨作品领域编排。

// 创作资产库由 store/writing-assets.js 提供；生成与审稿仍通过本 facade 读取。

// ——— 书架管理 ———
export async function renameBook(id, title, { expectedTitle } = {}) {
  const safeBookId = safeId(id);
  if (expectedTitle !== undefined && typeof expectedTitle !== 'string') {
    throw new Error('BAD_BOOK_TITLE_ANCHOR');
  }
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId);
    const nextTitle = normalizeTitleInput(title);
    if (!nextTitle) return book;
    if (expectedTitle !== undefined && book.title !== expectedTitle) {
      // 同一目标的请求可能已提交但响应丢失；只有最终书名和来源都相同
      // 才可幂等确认，不能让旧页面覆盖另一页面刚写入的不同书名。
      if (book.title === nextTitle && book.titleSource === 'manual') return book;
      throw new Error('BOOK_TITLE_CONFLICT');
    }
    if (book.title === nextTitle && book.titleSource === 'manual') return book;
    book.title = nextTitle;
    book.titleSource = 'manual';
    await writeBookUnlocked(safeBookId, book);
    return book;
  });
}

export async function setGeneratedBookTitle(id, title, {
  expectedOutlineRevision,
  expectedContextRevision,
  signal,
} = {}) {
  const safeBookId = safeId(id);
  return withStoreLock(bookJsonLockKey(safeBookId), async () => {
    const book = await readBook(safeBookId, { signal });
    if (book.titleSource !== 'default') return { applied: false, book };
    if ((expectedOutlineRevision !== undefined
      && versionRevision(book.outline) !== expectedOutlineRevision)
      || (expectedContextRevision !== undefined
        && bookGenerationContextRevision(book) !== expectedContextRevision)) {
      return { applied: false, book };
    }
    const nextTitle = normalizeTitleInput(title);
    if (!nextTitle) return { applied: false, book };
    throwIfAborted(signal);
    book.title = nextTitle;
    book.titleSource = 'ai';
    await writeBookUnlocked(safeBookId, book);
    return { applied: true, book };
  }, { signal });
}

const memoryStore = createMemoryStore({
  backupText,
  CHAPTER_COMPLETION_JSON_PROJECTION,
  CHAPTER_DIGEST_SUMMARY_JSON_PROJECTION,
  assertChapterReferenced,
  atomicWriteJson,
  bookDir,
  bookJsonLockKey,
  bookSectionIds,
  chapterDigestTransactionPath,
  chapterFileLockKey,
  clearCommittedTransaction,
  inspectJsonFile,
  isObjectRecord,
  isValidChapterDigestTransaction,
  normalizeBackupBookMemory,
  normalizeBackupStageSummaries,
  normalizeStoredChapter,
  readBook,
  readChapter,
  readSection,
  readSectionChapterReferences,
  readStoredJsonProjection,
  recoverReferencedStructureTransactions,
  safeId,
  sectionChapterIds,
  sectionFileLockKey,
  validateStoredData,
  withChapterWriteLocks,
  writeBookUnlocked,
  writeChapterFile,
});
const {
  bookMemoryLibraryView, buildSectionSummary, ensureChapterSummaries,
  hasOtherCompletedChapter, invalidateChapterDerivedData,
  invalidateDeletedChapterMemory, latestCompletedChapterInSection,
  latestProgressState, normalizedStoredBookMemory, persistChapterBodyMutation,
  readChapterCompletionMetadata, recoverChapterDigestTransaction,
  updateBookSectionSummary,
} = memoryStore;
export const applyChapterDigest = memoryStore.applyChapterDigest;
export const bookMemoryRevision = memoryStore.bookMemoryRevision;
export const chapterMemoryCandidatesView = memoryStore.chapterMemoryCandidatesView;
export const deactivateMemoryFact = memoryStore.deactivateMemoryFact;
export const decideMemoryCandidate = memoryStore.decideMemoryCandidate;
export const deleteStageSummary = memoryStore.deleteStageSummary;
export const readBookMemory = memoryStore.readBookMemory;
export const readStageSummarySource = memoryStore.readStageSummarySource;
export const saveGeneratedStageSummary = memoryStore.saveGeneratedStageSummary;
export const saveStageSummary = memoryStore.saveStageSummary;
export const stageSummaryRevision = memoryStore.stageSummaryRevision;


const chapterWorkflowStore = createChapterWorkflowStore({
  CHAPTER_PREFLIGHT_JSON_PROJECTION,
  advanceBookUpdatedAt,
  assertChapterReferenced,
  bookDir,
  bookJsonLockKey,
  bookMemoryRevision,
  bookSectionIds,
  chapterFileLockKey,
  chapterMemoryCandidatesView,
  countBookChapterReferences,
  hasOtherCompletedChapter,
  invalidateChapterDerivedData,
  isObjectRecord,
  latestProgressState,
  normalizeStoredChapter,
  normalizedStoredBookMemory,
  parseVersionPath,
  persistChapterBodyMutation,
  readBook,
  readChapter,
  readChapterCompletionMetadata,
  readReferencedChapter,
  readReferencedSection,
  readSection,
  readSectionChapterReferences,
  readStoredJsonProjection,
  readWritingAssetContext,
  recoverReferencedStructureTransactions,
  safeId,
  sectionChapterIds,
  sectionFileLockKey,
  touchBookUnlocked,
  updateBookSectionSummary,
  withChapterWriteLocks,
  writeBookUnlocked,
  writeChapterFile,
});

export const bookGenerationContextRevision = chapterWorkflowStore.bookGenerationContextRevision;
export const applyChapterReviewPromiseCandidate = chapterWorkflowStore.applyChapterReviewPromiseCandidate;
export const applyChapterReviewWorldGateCandidate =
  chapterWorkflowStore.applyChapterReviewWorldGateCandidate;
export const chapterGenerationContextRevision = chapterWorkflowStore.chapterGenerationContextRevision;
export const chapterPublicationView = chapterWorkflowStore.chapterPublicationView;
export const chapterReviewContextRevision = chapterWorkflowStore.chapterReviewContextRevision;
export const commitGeneratedBookVersion = chapterWorkflowStore.commitGeneratedBookVersion;
export const commitGeneratedChapter = chapterWorkflowStore.commitGeneratedChapter;
export const publishChapterVersion = chapterWorkflowStore.publishChapterVersion;
export const readChapterGenerationContext = chapterWorkflowStore.readChapterGenerationContext;
export const readChapterPublicationPreflight = chapterWorkflowStore.readChapterPublicationPreflight;
export const readChapterReviewContext = chapterWorkflowStore.readChapterReviewContext;
export const saveChapterPlan = chapterWorkflowStore.saveChapterPlan;
export const saveChapterReview = chapterWorkflowStore.saveChapterReview;
export const sectionPlanContextRevision = chapterWorkflowStore.sectionPlanContextRevision;
export const versionMove = chapterWorkflowStore.versionMove;
export const versionSet = chapterWorkflowStore.versionSet;

const goldenThreeReviewStore = createGoldenThreeReviewStore({
  bookJsonLockKey, bookSectionIds, readBook, readChapter, readSection, safeId,
  sectionChapterIds, withStoreLock, writeBookUnlocked,
});
export const goldenThreeReviewState = goldenThreeReviewStore.goldenThreeReviewState;
export const readGoldenThreeReviewContext = goldenThreeReviewStore.readGoldenThreeReviewContext;
export const saveGoldenThreeReview = goldenThreeReviewStore.saveGoldenThreeReview;
