import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, opendir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { openIndexedBookBackup, projectTopLevelJsonFromHandle } from './backup-json.js';
import { readFileHandleBounded } from './bounded-io.js';
import { stringifyJsonChunks } from './json-stream.js';
import { normalizeLlmConfig } from './llm-config.js';
import {
  bookSectionSummaryWindow, buildBookSummaryFromSectionSummaries,
  generationBookOutlineText, generationCharacterRows, generationCoreFieldText,
  generationMemoryRelevantText, generationMemoryRows, generationSectionOutlineText,
  generationPriorSectionSummary, previousChapterEndingText, recentSectionSummary,
} from './generation-context.js';
import {
  MAX_BOOK_SECTIONS, MAX_BOOK_PROMPT_SUMMARY_CHARS,
  MAX_BOOK_SECTION_SUMMARY_CHARS, MAX_CHAPTER_WORD_TARGET, MAX_CONFIG_API_KEY_CHARS,
  MAX_DAILY_WORD_GOAL,
  MAX_CONFIG_BASE_URL_CHARS, MAX_CONFIG_MODEL_CHARS, MAX_ID_CHARS,
  MAX_CHARACTER_DESC_CHARS, MAX_CHARACTER_NAME_CHARS, MAX_CHARACTER_ROLE_CHARS,
  MAX_DIGEST_PROGRESS_CHARS, MAX_DIGEST_SUMMARY_CHARS, MAX_PREMISE_CHARS,
  MAX_REVIEW_INSTRUCTION_CHARS, MAX_SECTION_CHAPTERS, MAX_SECTION_SUMMARY_CHARS,
  MAX_STORED_CHARACTERS, MAX_TITLE_CHARS, MAX_TOTAL_BACKUP_CHAPTERS,
  MAX_TOTAL_BOOK_CHAPTERS,
  MAX_VERSION_HISTORY_ITEMS, MAX_VERSION_TEXT_CHARS, MAX_BOOK_JSON_BYTES,
  MAX_BOOK_BACKUP_BYTES, MAX_SECTION_JSON_BYTES,
  MAX_CHAPTER_JSON_BYTES, MAX_CONFIG_JSON_BYTES,
  MAX_STRUCTURE_TRANSACTION_JSON_BYTES, MAX_IMPORT_OWNER_JSON_BYTES,
  MAX_STORAGE_DIAGNOSTIC_ISSUES, MAX_STRUCTURE_RECOVERY_FAILURES,
  MAX_STORAGE_ROOT_DIRECTORY_ENTRIES, MAX_BOOK_DIRECTORY_ENTRIES,
  MAX_SECTION_DIRECTORY_ENTRIES,
  MAX_WRITING_ASSETS, MAX_WRITING_ASSET_JSON_BYTES,
  MAX_WRITING_ASSET_BOOK_BINDINGS, MAX_WRITING_ASSET_CONTEXT_CHARS,
  MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS,
  MAX_WRITING_ASSET_METADATA_TAG_CHARS, MAX_WRITING_ASSET_METADATA_TAGS,
  MAX_WRITING_ASSET_NAME_CHARS, MAX_WRITING_ASSET_SOURCE_CHARS,
  MAX_WRITING_ASSET_NOTE_CHARS, MAX_WRITING_ASSET_REFERENCE_URL_CHARS,
  MAX_WRITING_ASSET_SOURCE_NAME_CHARS, MAX_WRITING_ASSET_SOURCE_PREVIEW_CHARS,
  MAX_MEMORY_CANDIDATES_PER_CHAPTER, MAX_MEMORY_EVIDENCE_CHARS,
  MAX_MEMORY_FACTS_PER_BOOK, MAX_MEMORY_OBJECT_CHARS, MAX_MEMORY_PREDICATE_CHARS,
  MAX_MEMORY_REJECTIONS_PER_BOOK, MAX_MEMORY_SUBJECT_CHARS,
  MAX_API_BOOK_BINDINGS, MAX_API_PROFILES, MAX_API_PROFILES_JSON_BYTES,
  MAX_STAGE_SUMMARIES_PER_BOOK, MAX_STAGE_SUMMARY_CHARS,
  MAX_STAGE_SUMMARY_TITLE_CHARS,
  MAX_RECENT_REVIEW_SIGNAL_CHAPTERS, MAX_RECENT_REVIEW_SIGNAL_SCAN_CHAPTERS,
} from './limits.js';
import {
  isWritingAssetSourceKind, isWritingAssetTextSourceKind,
  normalizeWritingAssetBookBinding, normalizeWritingAssetLibrary,
  sanitizeWritingAssetAnalysis,
} from './writing-asset-schema.js';
import {
  isMemoryFactStatus, isMemoryKind, MEMORY_ID_PATTERN,
  normalizeStoredMemoryCandidate, normalizeStoredMemoryDetails, sanitizeMemoryCandidates,
} from './memory-schema.js';
import {
  API_MODEL_TASKS, API_PROFILE_ID_PATTERN, emptyApiTaskRoutes, isApiModelTask,
  normalizeApiBookBindingInput, normalizeApiProfileInput,
  normalizeApiProfileLibrary, normalizeApiTaskRoutes,
} from './api-profile-schema.js';
import {
  createStageSummaryId, normalizeStageSummaries, stageSummaryPublicView,
  stageSummaryRange, stageSummarySourceSnapshot, STAGE_SUMMARY_ID_PATTERN,
  STAGE_SUMMARY_STATUSES,
} from './stage-summary-schema.js';
import {
  normalizeChapterReviewChecks, normalizeChapterReviewSignals,
} from './chapter-review-schema.js';
import {
  MAX_PLATFORM_CONFIRMATIONS, PLATFORM_CONFIRMATION_ID_PATTERN,
  normalizePlatformConfirmationInput, normalizePlatformConfirmations,
  platformGovernanceView,
} from './platform-governance-schema.js';

let DATA_ROOT = join(process.cwd(), 'data');
const storeLocks = new Map();
const INSTANCE_LOCK_FORMAT = 'auto-novel-box-instance-lock';
const INSTANCE_LOCK_FILE = '.instance-lock.json';
const MAX_INSTANCE_LOCK_BYTES = 4096;
const PROCESS_START_IDENTITY_TOLERANCE_MS = 5_000;
const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 2_000;
const MAX_CLEANUP_PROCESS_IDENTITY_PROBES = 64;
const MAX_CLEANUP_PROCESS_IDENTITY_ELAPSED_MS = 1_000;
// 捕获一次而不是每次用 Date.now()-uptime 重算，避免运行期间系统时钟调整改变
// 当前进程的身份。它只用于区分“相同 PID 的旧进程”，不作为数据时间戳。
const PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;
const PROCESS_STARTED_AT = new Date(PROCESS_STARTED_AT_MS).toISOString();
export function setDataRoot(p) {
  DATA_ROOT = p;
  storeLocks.clear();
}
export function getDataRoot() { return DATA_ROOT; }
const booksDir = () => join(DATA_ROOT, 'books');
const trashBooksDir = () => join(DATA_ROOT, 'trash', 'books');
const MAX_TRASH_ID_CHARS = MAX_ID_CHARS + 80;
const TRASH_LIST_FULL_VALIDATION_BYTES = 2 * 1024 * 1024;
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

export async function withStoreLock(key, fn, { signal } = {}) {
  throwIfAborted(signal);
  let state = storeLocks.get(key);
  if (state) {
    await new Promise((resolveWait, rejectWait) => {
      const waiter = {
        resolve() {
          signal?.removeEventListener?.('abort', onAbort);
          resolveWait();
        },
      };
      const onAbort = () => {
        const index = state.waiters.indexOf(waiter);
        if (index < 0) return;
        state.waiters.splice(index, 1);
        signal?.removeEventListener?.('abort', onAbort);
        rejectWait(clientAbortError(signal));
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      state.waiters.push(waiter);
      // abort 可能发生在入口检查和监听器注册之间。
      if (signal?.aborted) onAbort();
    });
  } else {
    state = { waiters: [] };
    storeLocks.set(key, state);
  }
  try {
    // 若取消与锁交接同时发生，仍需进入 finally 把刚取得的锁传给下一位。
    throwIfAborted(signal);
    return await fn();
  } finally {
    const next = state.waiters.shift();
    if (next) next.resolve();
    else if (storeLocks.get(key) === state) storeLocks.delete(key);
  }
}

export async function mapWithConcurrency(items, limit, mapper) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  let hasError = false;
  let firstError;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      // 一个并发分支失败后不再领取新任务，但必须等已在执行的
      // 分支收尾后才向外抛错。否则外层作品锁会在背景读取结束前释放。
      if (hasError) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (hasError) throw firstError;
  return results;
}

const MAX_CONCURRENT_JSON_READS = 2;
const jsonReadWaiters = [];
let activeJsonReads = 0;

function clientAbortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('CLIENT_ABORTED');
}

export async function withJsonReadSlot(task, { signal } = {}) {
  throwIfAborted(signal);
  if (activeJsonReads >= MAX_CONCURRENT_JSON_READS) {
    await new Promise((resolveWait, rejectWait) => {
      const waiter = {
        resolve() {
          signal?.removeEventListener('abort', onAbort);
          resolveWait();
        },
      };
      const onAbort = () => {
        const index = jsonReadWaiters.indexOf(waiter);
        if (index < 0) return;
        jsonReadWaiters.splice(index, 1);
        signal?.removeEventListener('abort', onAbort);
        rejectWait(clientAbortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      jsonReadWaiters.push(waiter);
      // abort 可能发生在入口检查和监听器注册之间。
      if (signal?.aborted) onAbort();
    });
  } else {
    activeJsonReads += 1;
  }
  try {
    throwIfAborted(signal);
    return await task();
  } finally {
    const next = jsonReadWaiters.shift();
    if (next) next.resolve();
    else activeJsonReads -= 1;
  }
}

function storedJsonByteLimit(absPath) {
  const name = basename(absPath);
  if (name === 'book.json') return MAX_BOOK_JSON_BYTES;
  if (name === 'section.json') return MAX_SECTION_JSON_BYTES;
  if (name === 'config.json') return MAX_CONFIG_JSON_BYTES;
  if (name === 'api-profiles.json') return MAX_API_PROFILES_JSON_BYTES;
  if (name === 'writing-assets.json') return MAX_WRITING_ASSET_JSON_BYTES;
  if (name === BOOK_STRUCTURE_TRANSACTION_FILE
    || name === SECTION_STRUCTURE_TRANSACTION_FILE
    || name === CHAPTER_DIGEST_TRANSACTION_FILE) {
    return MAX_STRUCTURE_TRANSACTION_JSON_BYTES;
  }
  if (name === IMPORT_STAGE_OWNER_FILE) return MAX_IMPORT_OWNER_JSON_BYTES;
  return MAX_CHAPTER_JSON_BYTES;
}

function storageFileTooLarge() {
  throw new Error('STORAGE_FILE_TOO_LARGE');
}

function storagePathUnsafe() {
  throw new Error('STORAGE_PATH_UNSAFE');
}

function storagePathComponents(absPath) {
  const root = resolve(DATA_ROOT);
  const target = resolve(absPath);
  const rel = relative(root, target);
  if (rel === '') return { root, target, components: [] };
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    return storagePathUnsafe();
  }
  return { root, target, components: rel.split(sep).filter(Boolean) };
}

async function assertSafeStoragePath(absPath, { expect = 'any' } = {}) {
  const { root, components } = storagePathComponents(absPath);
  let current = root;
  const paths = [root];
  const directories = [];
  for (const component of components) {
    current = join(current, component);
    paths.push(current);
  }
  for (let index = 0; index < paths.length; index += 1) {
    const metadata = await lstat(paths[index]);
    if (metadata.isSymbolicLink()) return storagePathUnsafe();
    const isFinal = index === paths.length - 1;
    if (!isFinal && !metadata.isDirectory()) throw new Error('STORAGE_PATH_INVALID');
    if (isFinal && expect === 'directory' && !metadata.isDirectory()) {
      throw new Error('STORAGE_PATH_INVALID');
    }
    if (isFinal && expect === 'file' && !metadata.isFile()) {
      throw new Error('STORAGE_PATH_INVALID');
    }
    if (metadata.isDirectory()) directories.push({ path: paths[index], mode: metadata.mode });
  }
  return { directories };
}

async function assertSafeWriteTarget(absPath) {
  const checkedParent = await assertSafeStoragePath(
    dirname(absPath),
    { expect: 'directory' },
  );
  try { await assertSafeStoragePath(absPath, { expect: 'file' }); }
  catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return checkedParent;
}

function isWithinStorageRoot(absPath) {
  const rel = relative(resolve(DATA_ROOT), resolve(absPath));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

async function tightenStorageDirectories(directories) {
  if (process.platform === 'win32') return;
  for (const directory of directories) {
    if ((directory.mode & 0o777) === 0o700 || !isWithinStorageRoot(directory.path)) continue;
    let handle;
    try {
      handle = await open(
        directory.path,
        constants.O_RDONLY
          | (constants.O_NOFOLLOW ?? 0)
          | (constants.O_DIRECTORY ?? 0)
          | (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (error?.code === 'ELOOP') return storagePathUnsafe();
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isDirectory()) throw new Error('STORAGE_PATH_INVALID');
      if ((metadata.mode & 0o777) !== 0o700) await handle.chmod(0o700);
    } finally {
      await handle.close().catch(() => {});
    }
    // chmod 通过已验证的句柄完成；再核对一次路径，防止并发替换
    // 导致后续读写继续使用不安全的目录树。
    await assertSafeStoragePath(directory.path, { expect: 'directory' });
  }
}

async function readSafeDirectory(
  absDir,
  options,
  maxEntries = MAX_STORAGE_ROOT_DIRECTORY_ENTRIES,
) {
  await assertSafeStoragePath(absDir, { expect: 'directory' });
  const entries = [];
  let handle;
  try {
    handle = await opendir(absDir);
    for await (const entry of handle) {
      if (entries.length >= maxEntries) {
        throw new Error('STORAGE_DIRECTORY_LIMIT_EXCEEDED');
      }
      entries.push(options?.withFileTypes ? entry : entry.name);
    }
    return entries;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertStorageDirectoryCapacity(absDir, errorCode) {
  let entries;
  try {
    entries = await readSafeDirectory(
      absDir, { withFileTypes: true }, MAX_STORAGE_ROOT_DIRECTORY_ENTRIES,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error?.message === 'STORAGE_DIRECTORY_LIMIT_EXCEEDED') {
      throw new Error(errorCode);
    }
    throw error;
  }
  if (entries.length >= MAX_STORAGE_ROOT_DIRECTORY_ENTRIES) {
    throw new Error(errorCode);
  }
}

function parseStoredJsonBytes(bytes) {
  let text;
  try {
    // Buffer.toString('utf8') 会把损坏字节静默替换为 U+FFFD，使磁盘损坏
    // 看起来像合法用户文本，并可能在下一次保存时被永久写回。
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SyntaxError('Stored JSON contains invalid UTF-8', { cause: error });
  }
  return JSON.parse(text);
}

async function openStoredJsonForRead(absPath, { mode, signal }) {
  throwIfAborted(signal);
  const maxBytes = storedJsonByteLimit(absPath);
  let handle;
  try {
    const checkedPath = await assertSafeStoragePath(absPath, { expect: 'file' });
    // 普通读取渐进收紧旧版 755 目录；完整性诊断传 mode:null，
    // 必须保持完全只读，不修复现场。
    if (mode !== null) await tightenStorageDirectories(checkedPath.directories);
    throwIfAborted(signal);
    try {
      handle = await open(
        absPath,
        constants.O_RDONLY
          | (constants.O_NOFOLLOW ?? 0)
          | (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (error?.code === 'ELOOP') return storagePathUnsafe();
      throw error;
    }
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('STORAGE_PATH_INVALID');
    // 路径检查与 open 之间若父目录被替换，打开后再核对一次组件；读取
    // 始终通过已取得的普通文件句柄完成，不再跟随最终路径的后续变化。
    await assertSafeStoragePath(absPath, { expect: 'file' });
    // 通过已打开的句柄收紧旧文件权限，避免路径在检查后被替换。
    if (mode !== null) await handle.chmod(mode);
    if (metadata.size > maxBytes) storageFileTooLarge();
    return { handle, maxBytes, size: metadata.size };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function readStoredJson(absPath, { mode = 0o600, signal } = {}) {
  return withJsonReadSlot(async () => {
    let opened;
    try {
      opened = await openStoredJsonForRead(absPath, { mode, signal });
      const { handle, maxBytes, size } = opened;

      // 正常写入使用原子改名，因此已打开句柄的初始大小在读取
      // 期间保持稳定。直接填充一块精确缓冲，避免大型 JSON 先积累分块
      // 再 Buffer.concat 出第二份完整字节。额外读取仍覆盖人工原地
      // 增长文件的情况，并继续执行同一大小上限。
      const primary = Buffer.allocUnsafe(size);
      let primaryBytes = 0;
      while (primaryBytes < primary.length) {
        throwIfAborted(signal);
        const { bytesRead } = await handle.read(
          primary, primaryBytes, primary.length - primaryBytes, null,
        );
        if (!bytesRead) break;
        primaryBytes += bytesRead;
      }
      const chunks = primaryBytes ? [primary.subarray(0, primaryBytes)] : [];
      let totalBytes = primaryBytes;
      for (;;) {
        throwIfAborted(signal);
        const remaining = maxBytes + 1 - totalBytes;
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        totalBytes += bytesRead;
        if (totalBytes > maxBytes) return storageFileTooLarge();
        chunks.push(buffer.subarray(0, bytesRead));
      }
      throwIfAborted(signal);
      const bytes = chunks.length === 0
        ? Buffer.alloc(0)
        : chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalBytes);
      return parseStoredJsonBytes(bytes);
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }, { signal });
}

async function readStoredJsonProjection(
  absPath, specification, {
    mode = 0o600, signal, projectionInvalidError,
  } = {},
) {
  return withJsonReadSlot(async () => {
    let opened;
    try {
      opened = await openStoredJsonForRead(absPath, { mode, signal });
      try {
        return await projectTopLevelJsonFromHandle(
          absPath,
          opened.handle,
          specification,
          { signal, maxBytes: opened.maxBytes, allowBom: false },
        );
      } catch (error) {
        if (error?.message === 'BACKUP_INVALID' && projectionInvalidError) {
          throw new Error(projectionInvalidError, { cause: error });
        }
        if (error?.message === 'BACKUP_INVALID_JSON' || error?.message === 'BACKUP_INVALID') {
          throw new SyntaxError('Stored JSON is invalid or exceeds its field limits', {
            cause: error,
          });
        }
        throw error;
      }
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }, { signal });
}

const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set([
  'EBADF', 'EINVAL', 'EISDIR', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM',
]);

async function syncDirectory(absDir, { afterCommit = false } = {}) {
  let handle;
  let failure;
  try {
    handle = await open(absDir, 'r');
    await handle.sync();
  } catch (err) {
    failure = err;
  } finally {
    await handle?.close().catch(() => {});
  }
  if (!failure || DIRECTORY_SYNC_UNSUPPORTED_CODES.has(failure?.code)) return;
  if (afterCommit) {
    // 仅用于已提交后的最佳努力清理：业务结果不能因收尾失败改口。
    // 正式文件和整目录 rename 由 syncCommittedDirectories 严格上报。
    console.warn(`[store] directory durability could not be confirmed after commit (${failure?.code || 'UNKNOWN'})`);
    return;
  }
  throw failure;
}

async function assertExistingDirectory(absDir) {
  const metadata = await lstat(absDir);
  if (metadata.isSymbolicLink()) return storagePathUnsafe();
  if (!metadata.isDirectory()) throw new Error('STORAGE_PATH_INVALID');
}

async function verifyAndTightenExistingDirectory(absDir) {
  if (!isWithinStorageRoot(absDir)) {
    await assertExistingDirectory(absDir);
    return;
  }
  const checkedPath = await assertSafeStoragePath(absDir, { expect: 'directory' });
  await tightenStorageDirectories(checkedPath.directories);
}

async function ensureDirectory(absDir) {
  try {
    await verifyAndTightenExistingDirectory(absDir);
    return;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const parent = dirname(absDir);
  if (parent === absDir) throw new Error('STORAGE_PATH_INVALID');
  await ensureDirectory(parent);
  try {
    await mkdir(absDir, { mode: 0o700 });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    await verifyAndTightenExistingDirectory(absDir);
    return;
  }
  await syncDirectory(parent);
}

// 上传/导出等存储附属目录也必须沿用数据根的组件级
// 防符号链接与权限收紧，不能由路由层直接递归 mkdir。
export async function ensureDataSubdirectory(absDir) {
  if (!isWithinStorageRoot(absDir)) throw new Error('STORAGE_PATH_INVALID');
  return ensureDirectory(absDir);
}

function validInstanceLockOwner(value) {
  return isObjectRecord(value)
    && value.format === INSTANCE_LOCK_FORMAT
    && typeof value.token === 'string'
    && value.token.length >= 16
    && value.token.length <= 128
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.startedAt === 'string'
    && Number.isFinite(Date.parse(value.startedAt))
    && (value.processStartedAt === undefined
      || (typeof value.processStartedAt === 'string'
        && Number.isFinite(Date.parse(value.processStartedAt))))
    && typeof value.host === 'string'
    && value.host.length > 0
    && value.host.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(value.host)
    && Number.isInteger(value.port)
    && value.port >= 1
    && value.port <= 65535;
}

function processStartedAtCommand(pid, platform) {
  if (platform === 'win32') {
    const systemRoot = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot
      ? process.env.SystemRoot
      : 'C:\\Windows';
    return {
      file: join(
        systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
      ),
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      env: process.env,
    };
  }
  return {
    file: '/bin/ps',
    args: ['-p', String(pid), '-o', 'lstart='],
    // 固定语言和时区，使同一进程在 DST 切换或系统语言变化后仍得到
    // 稳定、无歧义的启动时间文本。
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' },
  };
}

export async function processStartedAtMsForPid(pid, {
  platform = process.platform,
  execFileImpl = execFile,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const command = processStartedAtCommand(pid, platform);
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveResult(value);
    };
    try {
      execFileImpl(command.file, command.args, {
        encoding: 'utf8',
        env: command.env,
        maxBuffer: 4096,
        timeout: PROCESS_IDENTITY_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) return finish(null);
        const output = typeof stdout === 'string' ? stdout.trim() : '';
        if (!output || output.length > 128 || /[\u0000-\u001f\u007f]/u.test(output)) {
          return finish(null);
        }
        const startedAtMs = Date.parse(platform === 'win32' ? output : `${output} UTC`);
        return finish(Number.isFinite(startedAtMs) ? startedAtMs : null);
      });
    } catch {
      finish(null);
    }
  });
}

export function createCachedProcessStartedAtResolver(
  resolver,
  maxProbes = MAX_CLEANUP_PROCESS_IDENTITY_PROBES,
  {
    maxElapsedMs = MAX_CLEANUP_PROCESS_IDENTITY_ELAPSED_MS,
    now = () => performance.now(),
  } = {},
) {
  if (typeof resolver !== 'function') return null;
  const limit = Number.isSafeInteger(maxProbes) && maxProbes > 0
    ? Math.min(maxProbes, MAX_CLEANUP_PROCESS_IDENTITY_PROBES)
    : MAX_CLEANUP_PROCESS_IDENTITY_PROBES;
  const elapsedLimit = Number.isFinite(maxElapsedMs) && maxElapsedMs >= 0
    ? Math.min(maxElapsedMs, MAX_CLEANUP_PROCESS_IDENTITY_ELAPSED_MS)
    : MAX_CLEANUP_PROCESS_IDENTITY_ELAPSED_MS;
  const clock = typeof now === 'function' ? now : () => performance.now();
  let startedAt;
  const results = new Map();
  return (pid) => {
    if (results.has(pid)) return results.get(pid);
    if (results.size >= limit) return null;
    const currentTime = Number(clock());
    if (startedAt === undefined && Number.isFinite(currentTime)) startedAt = currentTime;
    // 残留清理发生在服务监听前。操作系统查询本身还有单次硬超时；这里再
    // 限制整批查询的启动时间。预算耗尽后返回“未知”，上层会保守保留目录，
    // 让后续启动继续尝试，而不是为了非关键清理长时间阻塞应用可用性。
    if (!Number.isFinite(startedAt) || !Number.isFinite(currentTime)
      || currentTime - startedAt >= elapsedLimit) return null;
    const pending = Promise.resolve()
      .then(() => resolver(pid))
      .catch(() => null);
    results.set(pid, pending);
    return pending;
  };
}

export async function processOwnerIsAlive(owner, {
  processAlive,
  processStartedAtForPid,
} = {}) {
  if (typeof processAlive !== 'function') throw new Error('PROCESS_PROBE_INVALID');
  if (!processAlive(owner.pid)) return false;
  if (owner.processStartedAt !== undefined && processStartedAtForPid) {
    let observedStartedAtMs = null;
    try { observedStartedAtMs = await processStartedAtForPid(owner.pid); }
    catch { /* 探测失败按仍存活处理。 */ }
    if (Number.isFinite(observedStartedAtMs)
      && Math.abs(observedStartedAtMs - Date.parse(owner.processStartedAt))
        > PROCESS_START_IDENTITY_TOLERANCE_MS) {
      return false;
    }
  }
  return true;
}

async function instanceOwnerIsAlive(owner, {
  requestingPid,
  requestingProcessStartedAt,
  requestingProcessStartedAtMs,
  processAlive,
  processStartedAtForPid,
}) {
  if (owner.pid === requestingPid) {
    // 新版租约可直接比较稳定的进程启动身份。旧版租约没有该字段时，只有其
    // 获取时间明确早于当前进程启动时间才判为陈旧；无法证明时继续保守阻止。
    if (owner.processStartedAt !== undefined) {
      if (owner.processStartedAt !== requestingProcessStartedAt) return false;
    } else if (Date.parse(owner.startedAt) < requestingProcessStartedAtMs) {
      return false;
    }
  }
  // kill(pid, 0) 只能证明 PID 当前被占用，不能证明仍是锁文件里的进程。
  // 操作系统启动时间只有在成功读取且明确不匹配时才允许接管；探测失败
  // 或时间接近时继续保守阻止，避免误删一个真实活跃实例的租约。
  return processOwnerIsAlive(owner, { processAlive, processStartedAtForPid });
}

async function inspectInstanceLock(absPath) {
  let handle;
  try {
    handle = await open(
      absPath,
      constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0),
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_INSTANCE_LOCK_BYTES) {
      return { status: 'invalid' };
    }
    const bytes = await readFileHandleBounded(handle, MAX_INSTANCE_LOCK_BYTES);
    if (bytes === null) return { status: 'invalid' };
    const value = parseStoredJsonBytes(bytes);
    return validInstanceLockOwner(value)
      ? { status: 'ok', owner: value }
      : { status: 'invalid' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    if (error instanceof SyntaxError || error?.code === 'ELOOP') return { status: 'invalid' };
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function instanceLockError(code, owner) {
  const error = new Error(code);
  if (owner) error.owner = owner;
  return error;
}

async function moveAsideStaleInstanceLock(lockPath, expectedOwner, ownerIsAlive) {
  const quarantine = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  let moved;
  try {
    moved = await inspectInstanceLock(quarantine);
  } catch (error) {
    try { await rename(quarantine, lockPath); }
    catch (restoreError) {
      if (!['EEXIST', 'ENOENT'].includes(restoreError?.code)) throw restoreError;
    }
    throw error;
  }
  if (moved.status === 'ok'
    && moved.owner.token === expectedOwner.token
    && !await ownerIsAlive(moved.owner)) {
    await rm(quarantine, { force: true });
    await syncDirectory(DATA_ROOT, { afterCommit: true });
    return true;
  }

  // 另一个启动进程可能已在“读取旧租约”和 rename 之间接管。若移动到隔离区的
  // 已不是预期旧文件，必须尝试原样放回，绝不能把新租约当成陈旧文件删除。
  try {
    await rename(quarantine, lockPath);
    await syncDirectory(DATA_ROOT, { afterCommit: true });
  } catch (error) {
    if (!['EEXIST', 'ENOENT'].includes(error?.code)) throw error;
  }
  return false;
}

async function releaseDataRootLease(lockPath, token) {
  const current = await inspectInstanceLock(lockPath);
  if (current.status !== 'ok' || current.owner.token !== token) return false;
  const quarantine = `${lockPath}.release.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const moved = await inspectInstanceLock(quarantine);
  if (moved.status === 'ok' && moved.owner.token === token) {
    await rm(quarantine, { force: true });
    await syncDirectory(DATA_ROOT, { afterCommit: true });
    return true;
  }
  try { await rename(quarantine, lockPath); }
  catch (error) { if (!['EEXIST', 'ENOENT'].includes(error?.code)) throw error; }
  return false;
}

export async function acquireDataRootLease({
  pid = process.pid,
  host = '127.0.0.1',
  port = 4399,
  processAlive = isProcessAlive,
  processStartedAtForPid,
  createToken = () => randomUUID(),
  nowMs = Date.now(),
  processStartedAtMs = PROCESS_STARTED_AT_MS,
  settleMs = 25,
} = {}) {
  const startedAt = new Date(nowMs);
  const processStartedAt = new Date(processStartedAtMs);
  if (!Number.isSafeInteger(pid) || pid <= 0
    || typeof host !== 'string' || !host || host.length > 255
    || /[\u0000-\u001f\u007f]/u.test(host)
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isFinite(nowMs) || !Number.isFinite(startedAt.getTime())
    || !Number.isFinite(processStartedAtMs)
    || !Number.isFinite(processStartedAt.getTime())) {
    throw instanceLockError('INSTANCE_LOCK_ARGUMENT_INVALID');
  }
  const token = createToken();
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) {
    throw instanceLockError('INSTANCE_LOCK_ARGUMENT_INVALID');
  }
  const owner = {
    format: INSTANCE_LOCK_FORMAT,
    token,
    pid,
    startedAt: startedAt.toISOString(),
    processStartedAt: processStartedAt.toISOString(),
    host,
    port,
  };
  const payload = `${JSON.stringify(owner)}\n`;
  if (Buffer.byteLength(payload) > MAX_INSTANCE_LOCK_BYTES) {
    throw instanceLockError('INSTANCE_LOCK_ARGUMENT_INVALID');
  }

  await ensureDirectory(DATA_ROOT);
  const lockPath = join(DATA_ROOT, INSTANCE_LOCK_FILE);
  const resolveProcessStartedAt = processStartedAtForPid
    ?? (processAlive === isProcessAlive ? processStartedAtMsForPid : null);
  const ownerIsAlive = (existingOwner) => instanceOwnerIsAlive(existingOwner, {
    requestingPid: pid,
    requestingProcessStartedAt: owner.processStartedAt,
    requestingProcessStartedAtMs: processStartedAtMs,
    processAlive,
    processStartedAtForPid: resolveProcessStartedAt,
  });
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let handle;
    try {
      handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
          | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await inspectInstanceLock(lockPath);
      if (existing.status === 'missing') continue;
      if (existing.status !== 'ok') throw instanceLockError('INSTANCE_LOCK_INVALID');
      if (await ownerIsAlive(existing.owner)) {
        throw instanceLockError('INSTANCE_ALREADY_RUNNING', existing.owner);
      }
      await moveAsideStaleInstanceLock(lockPath, existing.owner, ownerIsAlive);
      continue;
    }

    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      handle = undefined;
      // 创建使用 O_EXCL；写入尚未完成时其他实例只会把它视为非法并退出，
      // 不会合法接管该路径，因此可以移除本次留下的半写租约。
      await rm(lockPath, { force: true }).catch(() => {});
      await syncDirectory(DATA_ROOT, { afterCommit: true }).catch(() => {});
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
    await syncDirectory(DATA_ROOT, { afterCommit: true });
    if (settleMs > 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, settleMs));
    }
    const settled = await inspectInstanceLock(lockPath);
    if (settled.status !== 'ok' || settled.owner.token !== token) {
      throw instanceLockError('INSTANCE_LOCK_BUSY', settled.owner);
    }
    let released = false;
    return {
      owner,
      path: lockPath,
      async release() {
        if (released) return false;
        released = true;
        return releaseDataRootLease(lockPath, token);
      },
    };
  }
  throw instanceLockError('INSTANCE_LOCK_BUSY');
}

async function durableRename(source, destination) {
  await assertSafeStoragePath(source);
  await assertSafeStoragePath(dirname(destination), { expect: 'directory' });
  try { await assertSafeStoragePath(destination); }
  catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  await rename(source, destination);
  await syncCommittedDirectories([dirname(source), dirname(destination)]);
}

export async function syncCommittedDirectories(absDirs, {
  sync = (absDir) => syncDirectory(absDir),
} = {}) {
  let firstFailure;
  for (const absDir of new Set(absDirs)) {
    try {
      await sync(absDir);
    } catch (err) {
      // rename 已生效，仍要继续尝试其余父目录，尽可能完成
      // 跨目录提交的两端落盘；全部尝试后再上报首个真实故障。
      firstFailure ??= err;
      console.warn(`[store] directory durability could not be confirmed after commit (${err?.code || 'UNKNOWN'})`);
    }
  }
  if (firstFailure) throw firstFailure;
}

export async function atomicWriteJson(absPath, obj, { mode = 0o600 } = {}) {
  const tmp = `${absPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let handle;
  try {
    const checkedParent = await assertSafeWriteTarget(absPath);
    await tightenStorageDirectories(checkedParent.directories);
    handle = await open(tmp, 'wx', mode);
    // 直接把等价的紧凑 JSON 分块写入私有临时文件。大型 book.json 不再
    // 同时保留完整对象和一份最高百兆的缩进字符串；超限仍在改名前失败。
    const writer = createLimitedJsonWriter(
      handle, storedJsonByteLimit(absPath), undefined, 'STORAGE_FILE_TOO_LARGE',
    );
    await writer.writeJson(obj);
    await writer.flush();
    await handle.sync();
    await handle.close();
    handle = undefined;
    await durableRename(tmp, absPath);
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function emptyOutline() { return emptyVersioned(); }
export const DEFAULT_DAILY_WORD_GOAL = 2_000;

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
  }, history: [], serialization: serializationSettings() };
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

export async function createBook({ premise, title, requestedBookId }) {
  if (typeof premise !== 'string' || !premise.trim()) throw new Error('BAD_PREMISE');
  if (premise.length > MAX_PREMISE_CHARS) throw new Error('PREMISE_TOO_LARGE');
  const cleanTitle = normalizeTitleInput(title);
  const targetBookId = normalizeRequestedBookId(requestedBookId);
  const hasExplicitTitle = cleanTitle !== '';
  const book = {
    title: hasExplicitTitle ? cleanTitle : premise.slice(0, 20),
    titleSource: hasExplicitTitle ? 'manual' : 'default',
    premise, outline: emptyOutline(), settings: emptyCore(),
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
    const book = await readStoredJson(join(bookDir(id), 'book.json'), { signal });
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

async function inspectJsonFile(absPath, { signal } = {}) {
  try {
    // 诊断和恢复预检必须只读；正常加载路径才渐进收紧旧文件权限。
    return { status: 'ok', value: await readStoredJson(absPath, { mode: null, signal }) };
  } catch (err) {
    // 取消是控制流，不是存储损坏；否则诊断/回收站会短暂产生伪故障。
    throwIfAborted(signal);
    if (err?.code === 'ENOENT') return { status: 'missing' };
    if (err instanceof SyntaxError) return { status: 'invalid' };
    if (err?.message === 'STORAGE_FILE_TOO_LARGE') return { status: 'too_large' };
    if (err?.message === 'STORAGE_PATH_UNSAFE') return { status: 'unsafe' };
    if (err?.message === 'STORAGE_PATH_INVALID') return { status: 'invalid_shape' };
    return { status: 'unreadable' };
  }
}

async function inspectJsonProjection(absPath, specification, { signal } = {}) {
  try {
    // 与 inspectJsonFile 一样，诊断只读且不收紧旧文件权限。
    return {
      status: 'ok',
      value: await readStoredJsonProjection(
        absPath, specification, {
          mode: null, signal, projectionInvalidError: 'STORAGE_PROJECTED_DATA_INVALID',
        },
      ),
    };
  } catch (err) {
    throwIfAborted(signal);
    if (err?.code === 'ENOENT') return { status: 'missing' };
    if (err instanceof SyntaxError) return { status: 'invalid' };
    if (err?.message === 'STORAGE_PROJECTED_DATA_INVALID') return { status: 'data_invalid' };
    if (err?.message === 'STORAGE_FILE_TOO_LARGE') return { status: 'too_large' };
    if (err?.message === 'STORAGE_PATH_UNSAFE') return { status: 'unsafe' };
    if (err?.message === 'STORAGE_PATH_INVALID') return { status: 'invalid_shape' };
    return { status: 'unreadable' };
  }
}

async function inspectFileEntry(absPath) {
  try {
    const metadata = await lstat(absPath);
    return {
      status: metadata.isSymbolicLink()
        ? 'unsafe'
        : metadata.isFile() ? 'ok' : 'invalid_shape',
      ...(metadata.isFile() ? { size: metadata.size } : {}),
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable' };
  }
}

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
export async function diagnoseStorage({ deep = false, signal } = {}) {
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
    dataRootEntries = await readSafeDirectory(DATA_ROOT, { withFileTypes: true });
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
  const inspectedConfig = await inspectJsonFile(join(DATA_ROOT, 'config.json'), { signal });
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
    join(DATA_ROOT, 'writing-assets.json'), { signal },
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
    join(DATA_ROOT, 'api-profiles.json'), { signal },
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
          BOOK_BACKUP_FORMAT, BOOK_BACKUP_VERSION, migratedBook,
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

export const BOOK_BACKUP_FORMAT = 'auto-novel-box-book-backup';
const BOOK_BACKUP_VERSION = 1;
export const BOOK_BACKUP_MAX_BYTES = MAX_BOOK_BACKUP_BYTES;
export const MANUSCRIPT_EXPORT_MAX_BYTES = MAX_BOOK_BACKUP_BYTES;
const IMPORT_STAGE_FORMAT = 'auto-novel-box-import-staging';
const IMPORT_STAGE_OWNER_FILE = '.import-owner.json';
const IMPORT_STAGE_NAME = /^book_(?:\d{17}_[0-9a-f]{12}|[0-9a-f]{32})_[0-9a-f]{32}$/;
const DEFAULT_IMPORT_STAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STRUCTURE_TRANSACTION_FORMAT = 'auto-novel-box-structure-transaction';
const STRUCTURE_TRANSACTION_VERSION = 1;
const BOOK_STRUCTURE_TRANSACTION_FILE = '.book-structure-transaction.json';
const SECTION_STRUCTURE_TRANSACTION_FILE = '.section-structure-transaction.json';
const CHAPTER_DIGEST_TRANSACTION_FORMAT = 'auto-novel-box-chapter-digest-transaction';
const CHAPTER_DIGEST_TRANSACTION_VERSION = 1;
const CHAPTER_DIGEST_TRANSACTION_FILE = '.chapter-digest-transaction.json';

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

export async function cleanupAbandonedImports({
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_IMPORT_STAGE_MAX_AGE_MS,
  processAlive = isProcessAlive,
  processStartedAtForPid,
  currentPid = process.pid,
  currentProcessStartedAtMs = PROCESS_STARTED_AT_MS,
} = {}) {
  const tempParent = join(DATA_ROOT, '.imports');
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

export async function createBookBackup(id) {
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

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('CLIENT_ABORTED');
}

const JSON_WRITE_BUFFER_BYTES = 256 * 1024;

function createLimitedJsonWriter(
  handle, maxBytes, signal, tooLargeError = 'BACKUP_TOO_LARGE',
) {
  let totalBytes = 0;
  let bufferedBytes = 0;
  let bufferedParts = [];

  const flush = () => {
    if (!bufferedParts.length) return null;
    throwIfAborted(signal);
    const payload = bufferedParts.length === 1
      ? bufferedParts[0]
      : bufferedParts.join('');
    bufferedParts = [];
    bufferedBytes = 0;
    return handle.writeFile(payload, { encoding: 'utf8' });
  };

  const enqueueAlreadyCounted = (chunk, chunkBytes) => {
    if (chunkBytes >= JSON_WRITE_BUFFER_BYTES) {
      return handle.writeFile(chunk, { encoding: 'utf8' });
    }
    bufferedParts.push(chunk);
    bufferedBytes += chunkBytes;
    return null;
  };

  const enqueue = (chunk) => {
    throwIfAborted(signal);
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    totalBytes += chunkBytes;
    if (totalBytes > maxBytes) throw new Error(tooLargeError);
    if (bufferedBytes && bufferedBytes + chunkBytes > JSON_WRITE_BUFFER_BYTES) {
      return flush().then(() => enqueueAlreadyCounted(chunk, chunkBytes));
    }
    return enqueueAlreadyCounted(chunk, chunkBytes);
  };

  return {
    async writeText(chunk) {
      const pending = enqueue(chunk);
      if (pending) await pending;
    },
    async writeJson(value) {
      for (const chunk of stringifyJsonChunks(value)) {
        const pending = enqueue(chunk);
        if (pending) await pending;
      }
    },
    async flush() {
      const pending = flush();
      if (pending) await pending;
    },
  };
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
        const exportedChapter = normalizeBackupChapter(chapter, chapterId, chapterIndex + 1);
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
export async function writeBookBackupFile(id, absPath, {
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
export async function writeBookManuscriptFile(id, absPath, {
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

function invalidBackup() {
  throw new Error('BACKUP_INVALID');
}

function isValidVersioned(value) {
  return isObjectRecord(value)
    && Array.isArray(value.versions)
    && value.versions.length >= 1
    && value.versions.length <= HISTORY_MAX
    && value.versions.every((text) =>
      typeof text === 'string' && text.length <= MAX_VERSION_TEXT_CHARS)
    && Number.isInteger(value.cursor)
    && value.cursor >= 0
    && value.cursor < value.versions.length;
}

function backupText(value, maxLength, { optional = false, codePoints = false } = {}) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') return invalidBackup();
  // codePoints 用于与模型摘要清洗逻辑一致；先用 UTF-16 长度快速拒绝明显超限输入。
  const length = codePoints
    ? (value.length > maxLength * 2 ? value.length : Array.from(value).length)
    : value.length;
  if (length > maxLength) return invalidBackup();
  return value;
}

function cloneBackupVersioned(value) {
  if (!isValidVersioned(value)) return invalidBackup();
  return { versions: [...value.versions], cursor: value.cursor };
}

function normalizeBackupCharacters(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_STORED_CHARACTERS) return invalidBackup();
  const characters = [];
  const seen = new Set();
  for (const character of value) {
    if (!isObjectRecord(character)) return invalidBackup();
    const name = backupText(character.name, MAX_CHARACTER_NAME_CHARS, { codePoints: true });
    const role = backupText(character.role, MAX_CHARACTER_ROLE_CHARS, { codePoints: true });
    const desc = backupText(character.desc, MAX_CHARACTER_DESC_CHARS, { codePoints: true });
    if (!name.trim() || !role.trim()) return invalidBackup();
    const key = `${name}\0${role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    characters.push({ name, role, desc });
  }
  return characters;
}

function normalizeBackupMemoryFact(value) {
  if (!isObjectRecord(value) || typeof value.id !== 'string'
    || !MEMORY_ID_PATTERN.test(value.id) || !isMemoryKind(value.kind)
    || !isMemoryFactStatus(value.status) || !Number.isInteger(value.importance)
    || value.importance < 1 || value.importance > 5 || !isObjectRecord(value.source)) {
    return invalidBackup();
  }
  const source = {
    sectionId: backupId(value.source.sectionId),
    chapterId: backupId(value.source.chapterId),
    chapterIndex: value.source.chapterIndex,
    bodyFingerprint: backupText(value.source.bodyFingerprint, 43),
  };
  if (!Number.isInteger(source.chapterIndex) || source.chapterIndex < 1
    || source.chapterIndex > MAX_TOTAL_BOOK_CHAPTERS
    || !/^[A-Za-z0-9_-]{43}$/.test(source.bodyFingerprint)) return invalidBackup();
  const details = normalizeStoredMemoryDetails(value.details, value.kind);
  if (details === null) return invalidBackup();
  const fact = {
    id: value.id,
    kind: value.kind,
    subject: backupText(value.subject, MAX_MEMORY_SUBJECT_CHARS, { codePoints: true }),
    predicate: backupText(value.predicate, MAX_MEMORY_PREDICATE_CHARS, { codePoints: true }),
    object: backupText(value.object, MAX_MEMORY_OBJECT_CHARS, { codePoints: true }),
    evidence: backupText(value.evidence, MAX_MEMORY_EVIDENCE_CHARS, {
      optional: true, codePoints: true,
    }),
    importance: value.importance,
    status: value.status,
    source,
    confirmedAt: backupText(value.confirmedAt, 100),
    updatedAt: backupText(value.updatedAt, 100),
    ...(details ? { details } : {}),
  };
  if (!fact.subject.trim() || !fact.predicate.trim() || !fact.object.trim()
    || !Number.isFinite(Date.parse(fact.confirmedAt))
    || !Number.isFinite(Date.parse(fact.updatedAt))) return invalidBackup();
  return fact;
}

function normalizeBackupBookMemory(value) {
  if (value === undefined) return { facts: [], rejectedCandidateIds: [] };
  if (!isObjectRecord(value) || !Array.isArray(value.facts)
    || value.facts.length > MAX_MEMORY_FACTS_PER_BOOK
    || !Array.isArray(value.rejectedCandidateIds)
    || value.rejectedCandidateIds.length > MAX_MEMORY_REJECTIONS_PER_BOOK) {
    return invalidBackup();
  }
  const facts = value.facts.map(normalizeBackupMemoryFact);
  if (new Set(facts.map((fact) => fact.id)).size !== facts.length) return invalidBackup();
  const rejectedCandidateIds = [];
  const rejectedSeen = new Set();
  for (const id of value.rejectedCandidateIds) {
    if (typeof id !== 'string' || !MEMORY_ID_PATTERN.test(id)) return invalidBackup();
    if (!rejectedSeen.has(id)) rejectedCandidateIds.push(id);
    rejectedSeen.add(id);
  }
  return { facts, rejectedCandidateIds };
}

function normalizeBackupBookSectionSummaries(value, sectionIds) {
  if (value === undefined) return {};
  if (!isObjectRecord(value) || Object.keys(value).length > sectionIds.length) {
    return invalidBackup();
  }
  const referenced = new Set(sectionIds);
  const normalized = {};
  for (const [rawSectionId, item] of Object.entries(value)) {
    const sectionId = backupId(rawSectionId);
    if (!referenced.has(sectionId) || !isObjectRecord(item)) return invalidBackup();
    const summary = backupText(
      item.summary, MAX_BOOK_SECTION_SUMMARY_CHARS, { codePoints: true },
    );
    if (!summary) continue;
    Object.defineProperty(normalized, sectionId, {
      value: {
        index: sectionIds.indexOf(sectionId) + 1,
        title: backupText(item.title, MAX_TITLE_CHARS, { optional: true }),
        summary,
      },
      enumerable: true, writable: true, configurable: true,
    });
  }
  return normalized;
}

function normalizeBackupStageSummaries(value, sectionIds) {
  const normalized = normalizeStageSummaries(value, sectionIds);
  return normalized === null ? invalidBackup() : normalized;
}

function normalizeBackupMemoryCandidates(value, bodyFingerprint) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MEMORY_CANDIDATES_PER_CHAPTER) {
    return invalidBackup();
  }
  const candidates = value.map(normalizeStoredMemoryCandidate);
  if (candidates.some((candidate) => !candidate
    || candidate.sourceFingerprint !== bodyFingerprint)) return invalidBackup();
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    return invalidBackup();
  }
  return candidates;
}

function createActiveMemorySourceValidator(book) {
  const pending = new Map();
  for (const fact of book?.memory?.facts ?? []) {
    if (fact.status !== 'active') continue;
    const key = `${fact.source.sectionId}\0${fact.source.chapterId}`;
    const facts = pending.get(key) ?? [];
    facts.push(fact);
    pending.set(key, facts);
  }
  return {
    acceptChapter(sectionId, chapter) {
      const key = `${sectionId}\0${chapter.id}`;
      const facts = pending.get(key);
      if (!facts) return;
      if (facts.some((fact) =>
        (fact.source.bodyFingerprint !== chapter.bodyFingerprint
          && fact.source.bodyFingerprint !== chapter.published?.bodyFingerprint)
        || fact.source.chapterIndex !== chapter.index)) {
        invalidBackup();
      }
      pending.delete(key);
    },
    assertComplete() {
      if (pending.size) invalidBackup();
    },
  };
}

function validateBookSectionSummaryEntry(book, section) {
  const item = book?.sectionSummaries?.[section.id];
  if (!item) return;
  const expectedIndex = book.sections.indexOf(section.id) + 1;
  if (expectedIndex < 1
    || item.index !== expectedIndex
    || item.title !== section.title
    || item.summary !== bookSectionSummaryWindow(section.summary)) {
    invalidBackup();
  }
}

function normalizeBackupSectionOutline(value) {
  if (value === undefined) return { content: '', history: [] };
  if (!isObjectRecord(value)
    || typeof value.content !== 'string'
    || value.content.length > MAX_VERSION_TEXT_CHARS
    || !Array.isArray(value.history)
    || value.history.length > HISTORY_MAX
    || !value.history.every((text) =>
      typeof text === 'string' && text.length <= MAX_VERSION_TEXT_CHARS)) {
    return invalidBackup();
  }
  return { content: value.content, history: [...value.history] };
}

function normalizeBackupReview(value, body) {
  if (value === undefined || value === null) return undefined;
  if (!isObjectRecord(value)
    || !Number.isInteger(value.score) || value.score < 0 || value.score > 100) {
    return invalidBackup();
  }
  const verdict = backupText(value.verdict, 40, { codePoints: true });
  if (!verdict.trim() || !Array.isArray(value.issues)
    || value.issues.length < 1 || value.issues.length > 5
    || !Array.isArray(value.suggestions)
    || value.suggestions.length < 1 || value.suggestions.length > 3) {
    return invalidBackup();
  }
  const issues = value.issues.map((issue) => {
    if (!isObjectRecord(issue)) return invalidBackup();
    const title = backupText(issue.title, 15, { codePoints: true });
    const detail = backupText(issue.detail, 80, { codePoints: true });
    if (!title.trim() || !detail.trim()) return invalidBackup();
    return { title, detail };
  });
  const suggestions = value.suggestions.map((suggestion) => {
    if (!isObjectRecord(suggestion)) return invalidBackup();
    const label = backupText(suggestion.label, 8, { codePoints: true });
    const instruction = backupText(
      suggestion.instruction, MAX_REVIEW_INSTRUCTION_CHARS, { codePoints: true },
    );
    if (!label.trim() || !instruction.trim()) return invalidBackup();
    return { label, instruction };
  });
  const webFictionChecks = normalizeChapterReviewChecks(value.webFictionChecks);
  if (webFictionChecks === null) return invalidBackup();
  const webFictionSignals = normalizeChapterReviewSignals(value.webFictionSignals);
  if (webFictionSignals === null) return invalidBackup();
  const sourceCursor = value.sourceCursor === undefined ? body.cursor : value.sourceCursor;
  if (!Number.isInteger(sourceCursor) || sourceCursor < 0 || sourceCursor >= body.versions.length) {
    return invalidBackup();
  }
  const sourceFingerprint = value.sourceFingerprint === undefined
    ? contentFingerprint(body.versions[sourceCursor])
    : backupText(value.sourceFingerprint, 128);
  const sourceContextRevision = value.sourceContextRevision === undefined
    ? undefined
    : backupText(value.sourceContextRevision, 43);
  if (sourceContextRevision !== undefined
    && !/^[A-Za-z0-9_-]{43}$/.test(sourceContextRevision)) {
    return invalidBackup();
  }
  const updatedAt = value.updatedAt === undefined ? '' : backupText(value.updatedAt, 100);
  return {
    score: value.score, verdict, issues, suggestions,
    ...(webFictionChecks === undefined ? {} : { webFictionChecks }),
    ...(webFictionSignals === undefined ? {} : { webFictionSignals }),
    sourceCursor, sourceFingerprint,
    ...(sourceContextRevision === undefined ? {} : { sourceContextRevision }),
    updatedAt,
  };
}

function normalizeBackupChapterSummaries(value, chapterIds) {
  if (value === undefined) return {};
  if (!isObjectRecord(value)) return invalidBackup();
  const summaries = {};
  chapterIds.forEach((chapterId, position) => {
    if (!Object.prototype.hasOwnProperty.call(value, chapterId)) return;
    const item = value[chapterId];
    const summary = typeof item === 'string'
      ? backupText(item, MAX_DIGEST_SUMMARY_CHARS, { codePoints: true })
      : isObjectRecord(item)
        ? backupText(item.summary, MAX_DIGEST_SUMMARY_CHARS, { codePoints: true })
        : invalidBackup();
    if (!summary) return;
    Object.defineProperty(summaries, chapterId, {
      value: { index: position + 1, summary },
      enumerable: true, writable: true, configurable: true,
    });
  });
  return summaries;
}

function normalizeBackupPublishedChapter(value) {
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) return invalidBackup();
  const content = backupText(value.content, MAX_VERSION_TEXT_CHARS);
  const bodyFingerprint = backupText(value.bodyFingerprint, 43);
  const publishedAt = backupText(value.publishedAt, 100);
  if (bodyFingerprint !== contentFingerprint(content)
    || !/^[A-Za-z0-9_-]{43}$/.test(bodyFingerprint)
    || !Number.isFinite(Date.parse(publishedAt))
    || !Number.isSafeInteger(value.publicationNumber)
    || value.publicationNumber < 1) return invalidBackup();
  return {
    content, bodyFingerprint, publishedAt,
    publicationNumber: value.publicationNumber,
  };
}

function normalizeBackupBook(book, originalBookId, sectionIds) {
  const sectionSummaries = normalizeBackupBookSectionSummaries(
    book.sectionSummaries, sectionIds,
  );
  const normalized = {
    id: originalBookId,
    title: backupText(book.title, MAX_TITLE_CHARS),
    titleSource: TITLE_SOURCES.has(book.titleSource) ? book.titleSource : undefined,
    createdAt: backupText(book.createdAt, 100, { optional: true }),
    updatedAt: backupText(book.updatedAt, 100, { optional: true }),
    premise: backupText(book.premise, MAX_PREMISE_CHARS),
    outline: cloneBackupVersioned(book.outline),
    settings: {
      core: {}, history: [], serialization: serializationSettings(book.settings.serialization, {
        errorCode: 'BACKUP_INVALID',
      }),
    },
    characters: normalizeBackupCharacters(book.characters),
    summary: backupText(book.summary, MAX_BOOK_PROMPT_SUMMARY_CHARS, {
      optional: true, codePoints: true,
    }),
    sectionSummaries,
    stageSummaries: normalizeBackupStageSummaries(book.stageSummaries, sectionIds),
    progress: backupText(book.progress, MAX_DIGEST_PROGRESS_CHARS, {
      optional: true, codePoints: true,
    }),
    sections: [...sectionIds],
    memory: normalizeBackupBookMemory(book.memory),
  };
  for (const field of ['world', 'style', 'constraints', 'pacing']) {
    normalized.settings.core[field] = cloneBackupVersioned(book.settings.core[field]);
  }
  if (Object.keys(sectionSummaries).length) {
    normalized.summary = buildBookSummaryFromSectionSummaries(normalized);
  }
  return migrateBookTitleInPlace(normalized);
}

function normalizeBackupSection(section, sectionId, sectionIndex, chapterIds) {
  return normalizeEntityTitle({
    id: sectionId,
    index: sectionIndex,
    title: backupText(section.title, MAX_TITLE_CHARS),
    titleSource: TITLE_SOURCES.has(section.titleSource) ? section.titleSource : undefined,
    outline: normalizeBackupSectionOutline(section.outline),
    characters: normalizeBackupCharacters(section.characters),
    summary: backupText(section.summary, MAX_SECTION_SUMMARY_CHARS, {
      optional: true, codePoints: true,
    }),
    progress: backupText(section.progress, MAX_DIGEST_PROGRESS_CHARS, {
      optional: true, codePoints: true,
    }),
    chapters: [...chapterIds],
    chapterSummaries: normalizeBackupChapterSummaries(section.chapterSummaries, chapterIds),
  }, '部');
}

function normalizeBackupChapter(chapter, chapterId, chapterIndex) {
  const body = cloneBackupVersioned(chapter.body);
  const normalized = migrateChapterInPlace({
    id: chapterId,
    index: chapterIndex,
    title: backupText(chapter.title, MAX_TITLE_CHARS),
    titleSource: TITLE_SOURCES.has(chapter.titleSource) ? chapter.titleSource : undefined,
    body,
    characters: normalizeBackupCharacters(chapter.characters),
    summary: backupText(chapter.summary, MAX_DIGEST_SUMMARY_CHARS, {
      optional: true, codePoints: true,
    }),
    progress: backupText(chapter.progress, MAX_DIGEST_PROGRESS_CHARS, {
      optional: true, codePoints: true,
    }),
    status: 'done',
  });
  normalized.memoryCandidates = normalizeBackupMemoryCandidates(
    chapter.memoryCandidates, normalized.bodyFingerprint,
  );
  const published = normalizeBackupPublishedChapter(chapter.published);
  if (published) normalized.published = published;
  const review = normalizeBackupReview(chapter.review, body);
  if (review) normalized.review = review;
  return normalized;
}

function backupId(value) {
  try { return safeId(value); }
  catch { return invalidBackup(); }
}

function validateBackupBook(format, version, book) {
  if (format !== BOOK_BACKUP_FORMAT || version !== BOOK_BACKUP_VERSION || !isObjectRecord(book)) {
    return invalidBackup();
  }
  if (typeof book.title !== 'string' || book.title.length > MAX_TITLE_CHARS
    || typeof book.premise !== 'string' || book.premise.length > MAX_PREMISE_CHARS) {
    return invalidBackup();
  }
  if (!Array.isArray(book.sections) || book.sections.length > MAX_BOOK_SECTIONS) return invalidBackup();
  if (!isValidVersioned(book.outline) || !isObjectRecord(book.settings) || !isObjectRecord(book.settings.core)) {
    return invalidBackup();
  }
  for (const field of ['world', 'style', 'constraints', 'pacing']) {
    if (!isValidVersioned(book.settings.core[field])) return invalidBackup();
  }
  if (book.settings.serialization !== undefined
    && (!isObjectRecord(book.settings.serialization)
      || !validDailyWordGoal(book.settings.serialization.dailyWordGoal))) {
    return invalidBackup();
  }
  if (book.settings.serialization !== undefined) {
    try {
      normalizePlatformConfirmations(book.settings.serialization.platformConfirmations, {
        errorCode: 'BACKUP_INVALID',
      });
    } catch { return invalidBackup(); }
  }

  const originalBookId = backupId(book.id);
  const sectionIds = [];
  const referencedSections = new Set();
  const referencedSectionPaths = new Set();
  for (const rawId of book.sections) {
    const sectionId = backupId(rawId);
    const pathKey = storageIdPathKey(sectionId);
    if (referencedSectionPaths.has(pathKey)) return invalidBackup();
    referencedSections.add(sectionId);
    referencedSectionPaths.add(pathKey);
    sectionIds.push(sectionId);
  }
  const sectionIndexes = new Map(sectionIds.map((sectionId, index) => [sectionId, index + 1]));
  return {
    originalBookId,
    book: normalizeBackupBook(book, originalBookId, sectionIds),
    sectionIds,
    referencedSections,
    sectionIndexes,
  };
}

function validateBackupSection(section, validatedBook, seenSections) {
  if (!isObjectRecord(section)) return invalidBackup();
  const sectionId = backupId(section.id);
  if (!validatedBook.referencedSections.has(sectionId) || seenSections.has(sectionId)) return invalidBackup();
  if (!Array.isArray(section.chapters) || section.chapters.length > MAX_SECTION_CHAPTERS) return invalidBackup();
  if (typeof section.title !== 'string') return invalidBackup();
  const chapterIds = [];
  const referencedChapters = new Set();
  const referencedChapterPaths = new Set();
  for (const rawChapterId of section.chapters) {
    const chapterId = backupId(rawChapterId);
    const pathKey = storageIdPathKey(chapterId);
    if (referencedChapterPaths.has(pathKey)) return invalidBackup();
    referencedChapters.add(chapterId);
    referencedChapterPaths.add(pathKey);
    chapterIds.push(chapterId);
  }
  seenSections.add(sectionId);
  const chapterIndexes = new Map(chapterIds.map((chapterId, index) => [chapterId, index + 1]));
  return {
    sectionId,
    section: normalizeBackupSection(
      section, sectionId, validatedBook.sectionIndexes.get(sectionId), chapterIds,
    ),
    chapterIds,
    referencedChapters,
    chapterIndexes,
  };
}

function validateBackupChapter(chapter, referencedChapters, seenChapters) {
  if (!isObjectRecord(chapter)) return invalidBackup();
  const chapterId = backupId(chapter.id);
  if (!referencedChapters.has(chapterId) || seenChapters.has(chapterId)) return invalidBackup();
  if (typeof chapter.title !== 'string' || !isValidVersioned(chapter.body)) return invalidBackup();
  seenChapters.add(chapterId);
  return chapterId;
}

function validateStoredData(factory) {
  try { return factory(); }
  catch (err) {
    if (err?.message === 'BACKUP_INVALID') throw new Error('STORAGE_DATA_INVALID');
    throw err;
  }
}

function validateStoredBook(book, bookId) {
  const validated = validateStoredData(() =>
    validateBackupBook(BOOK_BACKUP_FORMAT, BOOK_BACKUP_VERSION, book));
  if (validated.originalBookId !== bookId) throw new Error('STORAGE_DATA_INVALID');
  return validated;
}

function validateStoredSection(section, validatedBook, seenSections = new Set()) {
  return validateStoredData(() =>
    validateBackupSection(section, validatedBook, seenSections));
}

function normalizeStoredChapter(chapter, validatedSection, seenChapters = new Set()) {
  return validateStoredData(() => {
    const chapterId = validateBackupChapter(
      chapter, validatedSection.referencedChapters, seenChapters,
    );
    return normalizeBackupChapter(
      chapter, chapterId, validatedSection.chapterIndexes.get(chapterId),
    );
  });
}

function validateBookBackup(snapshot) {
  if (!isObjectRecord(snapshot) || !Array.isArray(snapshot.sections)) return invalidBackup();
  const validatedBook = validateBackupBook(snapshot.format, snapshot.version, snapshot.book);

  const bundles = new Map();
  const seenSections = new Set();
  let totalChapters = 0;
  for (const bundle of snapshot.sections) {
    if (!isObjectRecord(bundle) || !isObjectRecord(bundle.section) || !Array.isArray(bundle.chapters)) return invalidBackup();
    const validatedSection = validateBackupSection(
      bundle.section, validatedBook, seenSections,
    );
    if (bundle.chapters.length !== validatedSection.referencedChapters.size) return invalidBackup();
    const chapters = new Map();
    const seenChapters = new Set();
    for (const chapter of bundle.chapters) {
      const chapterId = validateBackupChapter(
        chapter, validatedSection.referencedChapters, seenChapters,
      );
      chapters.set(chapterId, normalizeBackupChapter(
        chapter, chapterId, validatedSection.chapterIndexes.get(chapterId),
      ));
    }
    totalChapters += chapters.size;
    if (totalChapters > MAX_TOTAL_BACKUP_CHAPTERS) return invalidBackup();
    validateBookSectionSummaryEntry(validatedBook.book, validatedSection.section);
    bundles.set(validatedSection.sectionId, { section: validatedSection.section, chapters });
  }
  if (bundles.size !== validatedBook.sectionIds.length) return invalidBackup();
  const memorySources = createActiveMemorySourceValidator(validatedBook.book);
  for (const [sectionId, bundle] of bundles) {
    for (const chapter of bundle.chapters.values()) {
      memorySources.acceptChapter(sectionId, chapter);
    }
  }
  memorySources.assertComplete();
  return { ...validatedBook, bundles };
}

function canonicalizeBookBackup(snapshot) {
  const validated = validateBookBackup(snapshot);
  return {
    format: BOOK_BACKUP_FORMAT,
    version: BOOK_BACKUP_VERSION,
    exportedAt: typeof snapshot.exportedAt === 'string'
      ? snapshot.exportedAt.slice(0, 100)
      : new Date().toISOString(),
    book: validated.book,
    sections: validated.sectionIds.map((sectionId) => {
      const bundle = validated.bundles.get(sectionId);
      return {
        section: bundle.section,
        chapters: bundle.section.chapters.map((chapterId) => bundle.chapters.get(chapterId)),
      };
    }),
  };
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

    const tempParent = join(DATA_ROOT, '.imports');
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

export async function importBookBackup(snapshot, { signal, requestedBookId } = {}) {
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
  validateMemorySource,
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
  );
  validateMemorySource?.(chapter);
  // 规范化对象已经与备份解析结果隔离；写盘期间不再保留可能接近
  // 32 MiB 的原始章节对象。
  rawChapter = null;
  await atomicWriteJson(join(sectionRoot, `${chapterId}.json`), chapter);
  throwIfAborted(signal);
}

export async function importBookBackupFile(absPath, {
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
          // 后续逐章校验只需要引用集合和逻辑序号；大型聚合摘要等分部
          // 元数据已经落盘，可以在处理最多万章前释放。
          validatedSection.section = null;
          const seenChapters = new Set();
          for (const span of indexedBundle.chapters) {
            await writeIndexedChapter(
              reader, span, sectionRoot, validatedSection, seenChapters, signal,
              (chapter) => memorySources.acceptChapter(sectionId, chapter),
            );
          }
          if (seenChapters.size !== validatedSection.referencedChapters.size) invalidBackup();
        }
        if (seenSections.size !== validatedBook.sectionIds.length) invalidBackup();
        memorySources.assertComplete();
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
const pad2 = (n) => String(n).padStart(2, '0');
const TITLE_SOURCES = new Set(['default', 'ai', 'manual']);
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
    const fallback = (book.premise ?? '').slice(0, 20);
    book.titleSource = book.title === fallback ? 'default' : 'manual';
  }
  return book;
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

function isValidPendingChapter(chapter, chapterId) {
  const legacyKeys = [
    'id', 'index', 'title', 'titleSource', 'body', 'content',
    'bodyFingerprint', 'characters', 'summary', 'progress', 'status',
  ];
  // 升级前已经落盘、但尚未清理的新增章事务没有 memoryCandidates。
  // 事务版本仍为 1，必须兼容重放；除此之外仍坚持精确字段白名单。
  return (hasExactKeys(chapter, legacyKeys)
    || hasExactKeys(chapter, [...legacyKeys, 'memoryCandidates']))
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
    && chapter.status === 'done'
    && (chapter.memoryCandidates === undefined
      || (Array.isArray(chapter.memoryCandidates)
        && chapter.memoryCandidates.length === 0));
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

export async function recoverInterruptedTransactions({
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
export async function addSection(bookId, {
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
export async function readSection(bookId, sectionId, { signal } = {}) {
  const section = await readStoredJson(
    join(bookDir(bookId), safeId(sectionId), 'section.json'), { signal });
  return normalizeEntityTitle(section, '部');
}
export async function readReferencedSection(bookId, sectionId, { signal } = {}) {
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
export async function writeSection(bookId, sectionId, obj, { preserveExistingChapters = true } = {}) {
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
export async function addChapter(bookId, sectionId, {
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
        characters: [], summary: '', progress: '', status: 'done', memoryCandidates: [],
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
export async function readChapter(bookId, sectionId, chapterId, { signal } = {}) {
  const ch = await readStoredJson(
    join(bookDir(bookId), safeId(sectionId), `${safeId(chapterId)}.json`), { signal });
  return migrateChapterInPlace(ch);
}
export async function readChapterSummary(bookId, sectionId, chapterId) {
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

export async function readBookStructure(id, { signal } = {}) {
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
export async function readReferencedChapter(bookId, sectionId, chapterId, { signal } = {}) {
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
export async function writeChapter(bookId, sectionId, chapterId, obj) {
  return withChapterWriteLocks(bookId, sectionId, chapterId, async (safeBookId, safeSectionId, safeChapterId) => {
    await assertChapterReferenced(safeBookId, safeSectionId, safeChapterId);
    await touchBookUnlocked(safeBookId);
    await writeChapterFile(safeBookId, safeSectionId, safeChapterId, obj);
  });
}
export async function deleteChapter(bookId, sectionId, chapterId, {
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

// ——— history 回退栈（限深 20）———
const HISTORY_MAX = MAX_VERSION_HISTORY_ITEMS;

// ——— 可版本化字段原语（纯函数）———
export function emptyVersioned() { return { versions: [''], cursor: 0 }; }
export function currentText(vf) { return (vf && Array.isArray(vf.versions)) ? (vf.versions[vf.cursor] ?? '') : ''; }
export function contentFingerprint(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('base64url');
}
function jsonFingerprint(value) {
  const hash = createHash('sha256');
  for (const chunk of stringifyJsonChunks(value)) hash.update(chunk, 'utf8');
  return hash.digest('base64url');
}
export function serializationSettingsRevision(value) {
  return jsonFingerprint(serializationSettings(value));
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
export function versionRevision(vf) {
  if (!isValidVersioned(vf)) throw new Error('STORAGE_DATA_INVALID');
  return jsonFingerprint({ versions: vf.versions, cursor: vf.cursor });
}
export function assertExpectedVersionRevision(vf, expectedRevision) {
  if (expectedRevision === undefined) return;
  if (typeof expectedRevision !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(expectedRevision)) {
    throw new Error('BAD_VERSION_REVISION');
  }
  if (versionRevision(vf) !== expectedRevision) throw new Error('VERSION_CONFLICT');
}
export function commitVersion(vf, text) {
  vf.versions.push(text ?? '');
  while (vf.versions.length > HISTORY_MAX) vf.versions.shift();
  vf.cursor = vf.versions.length - 1;
  return vf;
}
export function moveCursor(vf, delta) {
  const n = vf.cursor + delta;
  if (n < 0 || n >= vf.versions.length) return false;
  vf.cursor = n; return true;
}
// 老结构 → 新结构：新结构原样 / 字符串→单版 / {content,history}→合并 / 其它→空
export function migrateVersioned(old) {
  if (old && Array.isArray(old.versions)) {
    // 早期迁移会把已达 20 条上限的 history 再加上当前 content，写成
    // 21 版且 cursor=20。该形态是旧版本合法数据经本应用产生的，不应被
    // 当作人工损坏；只修复这一种已知溢出，其他异常数组仍交给严格校验报告。
    if (old.versions.length === HISTORY_MAX + 1
      && old.cursor === HISTORY_MAX
      && old.versions.every((text) => typeof text === 'string')) {
      return { versions: old.versions.slice(-HISTORY_MAX), cursor: HISTORY_MAX - 1 };
    }
    return old;
  }
  if (typeof old === 'string') return { versions: [old], cursor: 0 };
  if (old && (typeof old.content === 'string' || Array.isArray(old.history))) {
    const history = Array.isArray(old.history) ? old.history : [];
    // 旧结构的 history 自身上限就是 20，再拼当前 content 最多会有 21 项。
    // 新结构的 20 项上限包含当前版，因此保留最新 20 项并丢弃最旧历史。
    const versions = [...history, old.content ?? ''].slice(-HISTORY_MAX);
    return { versions, cursor: versions.length - 1 };
  }
  return emptyVersioned();
}
// ——— 惰性迁移辅助（读盘时把老结构就地升级为新结构）———
function migrateBookInPlace(book) {
  migrateBookTitleInPlace(book);
  book.outline = migrateVersioned(book.outline);
  book.settings = book.settings || { core: {}, history: [] };
  const core = book.settings.core || {};
  for (const f of ['world', 'style', 'constraints', 'pacing']) core[f] = migrateVersioned(core[f]);
  book.settings.core = core;
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
export function pushHistory(obj, field) {
  if (field === 'content') {
    obj.history = obj.history || [];
    obj.history.push(obj.content);
    if (obj.history.length > HISTORY_MAX) obj.history.shift();
  } else {
    obj[field].history = obj[field].history || [];
    obj[field].history.push(obj[field].content);
    if (obj[field].history.length > HISTORY_MAX) obj[field].history.shift();
  }
  return obj;
}
export function rollback(obj, field) {
  if (field === 'content') {
    if (!obj.history || obj.history.length === 0) return false;
    obj.content = obj.history.pop();
    return true;
  }
  if (!obj[field].history || obj[field].history.length === 0) return false;
  obj[field].content = obj[field].history.pop();
  return true;
}

// ——— 全局配置 ———
const configPath = () => join(DATA_ROOT, 'config.json');
const configLockKey = () => 'config:config-json';
// 修订号会返回给浏览器用于乐观并发控制。加入仅当前进程持有的随机盐，
// 避免修订号成为 API Key 的可离线猜测摘要；服务重启后旧页面自然需要重载。
const CONFIG_REVISION_SALT = randomUUID();
const DEFAULT_CONFIG = { baseUrl: '', model: '', apiKey: '', chapterWordTarget: 2000, requestTimeoutMs: 300000 };
const CONFIG_FIELDS = Object.keys(DEFAULT_CONFIG);
const CONFIG_FIELD_SET = new Set(CONFIG_FIELDS);

function normalizeConfig(config) {
  const out = { ...DEFAULT_CONFIG };
  const textLimits = {
    baseUrl: MAX_CONFIG_BASE_URL_CHARS,
    model: MAX_CONFIG_MODEL_CHARS,
    apiKey: MAX_CONFIG_API_KEY_CHARS,
  };
  for (const [field, limit] of Object.entries(textLimits)) {
    if (typeof config?.[field] === 'string' && config[field].length <= limit) out[field] = config[field];
  }
  if (Number.isInteger(config?.chapterWordTarget)
    && config.chapterWordTarget > 0
    && config.chapterWordTarget <= MAX_CHAPTER_WORD_TARGET) {
    out.chapterWordTarget = config.chapterWordTarget;
  }
  if (Number.isInteger(config?.requestTimeoutMs) && config.requestTimeoutMs >= 1000 && config.requestTimeoutMs <= 3600000) {
    out.requestTimeoutMs = config.requestTimeoutMs;
  }
  return out;
}

function isValidStoredConfig(config) {
  if (!isObjectRecord(config)) return false;
  const textLimits = {
    baseUrl: MAX_CONFIG_BASE_URL_CHARS,
    model: MAX_CONFIG_MODEL_CHARS,
    apiKey: MAX_CONFIG_API_KEY_CHARS,
  };
  for (const [field, limit] of Object.entries(textLimits)) {
    if (Object.hasOwn(config, field)
      && (typeof config[field] !== 'string' || config[field].length > limit)) {
      return false;
    }
  }
  if (Object.hasOwn(config, 'chapterWordTarget')
    && (!Number.isInteger(config.chapterWordTarget)
      || config.chapterWordTarget <= 0
      || config.chapterWordTarget > MAX_CHAPTER_WORD_TARGET)) {
    return false;
  }
  if (Object.hasOwn(config, 'requestTimeoutMs')
    && (!Number.isInteger(config.requestTimeoutMs)
      || config.requestTimeoutMs < 1000
      || config.requestTimeoutMs > 3600000)) {
    return false;
  }
  try {
    normalizeLlmConfig(normalizeConfig(config), { allowIncomplete: true });
    return true;
  } catch {
    return false;
  }
}

export function configRevision(config) {
  return createHash('sha256')
    .update(CONFIG_REVISION_SALT, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(normalizeConfig(config)), 'utf8')
    .digest('base64url');
}

function expectedConfigRevisionMatches(config, expectedRevision) {
  if (expectedRevision === undefined) return true;
  if (typeof expectedRevision !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(expectedRevision)) {
    throw new Error('BAD_CONFIG_REVISION');
  }
  return configRevision(config) === expectedRevision;
}

export async function readConfig({ signal } = {}) {
  try {
    return normalizeConfig(await readStoredJson(configPath(), { mode: 0o600, signal }));
  } catch (err) {
    throwIfAborted(signal);
    if (err.code !== 'ENOENT') throw err;
    return { ...DEFAULT_CONFIG };
  }
}
export async function writeConfig(patch, { expectedRevision } = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('BAD_CONFIG_PATCH');
  }
  for (const field of Object.keys(patch)) {
    if (!CONFIG_FIELD_SET.has(field)) throw new Error('BAD_CONFIG_FIELD');
  }
  return withStoreLock(configLockKey(), async () => {
    const cur = await readConfig();
    const revisionMatches = expectedConfigRevisionMatches(cur, expectedRevision);
    const textLimits = {
      baseUrl: MAX_CONFIG_BASE_URL_CHARS,
      model: MAX_CONFIG_MODEL_CHARS,
      apiKey: MAX_CONFIG_API_KEY_CHARS,
    };
    for (const [field, limit] of Object.entries(textLimits)) {
      if (patch[field] !== undefined && typeof patch[field] !== 'string') {
        throw new Error('BAD_CONFIG_TEXT_FIELD');
      }
      if (typeof patch[field] === 'string' && patch[field].length > limit) {
        throw new Error('CONFIG_TEXT_TOO_LARGE');
      }
    }
    if (patch.chapterWordTarget !== undefined) {
      const target = patch.chapterWordTarget;
      if (!Number.isInteger(target) || target <= 0 || target > MAX_CHAPTER_WORD_TARGET) {
        throw new Error('BAD_CHAPTER_WORD_TARGET');
      }
    }
    if (patch.requestTimeoutMs !== undefined) {
      const timeout = patch.requestTimeoutMs;
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 3600000) {
        throw new Error('BAD_REQUEST_TIMEOUT');
      }
    }
    let next = { ...cur, ...patch };
    const keepsStoredKey = patch.apiKey === undefined
      || (typeof patch.apiKey === 'string' && patch.apiKey.trim() === 'sk-****');
    if (keepsStoredKey) next.apiKey = cur.apiKey;  // 保留原 Key
    // 已填写的模型连接字段必须在落盘前通过与实际请求完全相同的 URL
    // 解释和传输安全校验；空字段仍允许保留，便于首次配置和清除设置。
    next = normalizeLlmConfig(next, { allowIncomplete: true });
    if (!revisionMatches) {
      // 服务端可能已落盘、但成功响应在网络中丢失。相同旧修订号重放同一
      // 最终配置时视为幂等成功；目标不同仍拒绝，避免旧页面覆盖新设置。
      if (CONFIG_FIELDS.every((field) => next[field] === cur[field])) return cur;
      throw new Error('CONFIG_CONFLICT');
    }
    const baseUrlChanged = patch.baseUrl !== undefined && next.baseUrl !== cur.baseUrl;
    if (baseUrlChanged && cur.apiKey && keepsStoredKey) {
      throw new Error('API_KEY_REQUIRED_FOR_BASE_URL_CHANGE');
    }
    await ensureDirectory(DATA_ROOT);
    await atomicWriteJson(configPath(), next, { mode: 0o600 });
    return next;
  });
}

// ——— 多 API 服务 / 多模型方案库 ———
const apiProfilesPath = () => join(DATA_ROOT, 'api-profiles.json');
const apiProfilesLockKey = () => 'api-profiles:library';
const API_PROFILES_REVISION_SALT = randomUUID();
const API_KEY_MASK = 'sk-****';

function emptyApiProfileLibrary() {
  return {
    version: 1, activeProfileId: null, profiles: [], taskRoutes: emptyApiTaskRoutes(),
    bookBindings: [],
  };
}

function reconcileApiTaskRoutes(taskRoutes, profiles) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return Object.fromEntries(API_MODEL_TASKS.map((task) => {
    const route = taskRoutes[task];
    const profile = route ? byId.get(route.profileId) : null;
    return [task, profile?.models.includes(route.model) ? route : null];
  }));
}

function reconcileApiBookBindings(bookBindings, profiles) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return bookBindings.filter((binding) =>
    byId.get(binding.profileId)?.models.includes(binding.model));
}

async function readApiProfileLibrary({ signal } = {}) {
  try {
    return normalizeApiProfileLibrary(await readStoredJson(
      apiProfilesPath(), {
        mode: 0o600, signal, maxBytes: MAX_API_PROFILES_JSON_BYTES,
      },
    ));
  } catch (error) {
    throwIfAborted(signal);
    if (error?.code !== 'ENOENT') throw error;
    return emptyApiProfileLibrary();
  }
}

export function apiProfilesRevision(library) {
  return createHash('sha256')
    .update(API_PROFILES_REVISION_SALT, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(normalizeApiProfileLibrary(library)), 'utf8')
    .digest('base64url');
}

function assertApiProfilesRevision(library, expectedRevision) {
  if (typeof expectedRevision !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expectedRevision)) {
    throw new Error('BAD_API_PROFILES_REVISION');
  }
  if (apiProfilesRevision(library) !== expectedRevision) {
    throw new Error('API_PROFILES_CONFLICT');
  }
}

export async function readApiProfiles({ signal } = {}) {
  const library = await readApiProfileLibrary({ signal });
  return { ...library, revision: apiProfilesRevision(library) };
}

export async function readConfigForTaskSelection(task, { signal, bookId } = {}) {
  if (!isApiModelTask(task)) throw new Error('BAD_API_MODEL_TASK');
  const normalizedBookId = bookId === undefined ? undefined : safeId(bookId);
  const [config, library] = await Promise.all([
    readConfig({ signal }), readApiProfileLibrary({ signal }),
  ]);
  const bookBinding = normalizedBookId === undefined
    ? null : library.bookBindings.find((item) => item.bookId === normalizedBookId);
  if (bookBinding) {
    const profile = library.profiles.find((item) => item.id === bookBinding.profileId);
    if (!profile || !profile.models.includes(bookBinding.model)) {
      throw new Error('STORAGE_DATA_INVALID');
    }
    return { config: normalizeLlmConfig({
      ...config,
      baseUrl: profile.baseUrl,
      model: bookBinding.model,
      apiKey: profile.apiKey,
    }), routed: true, source: 'book' };
  }
  const route = library.taskRoutes[task];
  if (!route) return { config, routed: false, source: 'default' };
  const profile = library.profiles.find((item) => item.id === route.profileId);
  if (!profile || !profile.models.includes(route.model)) {
    throw new Error('STORAGE_DATA_INVALID');
  }
  return { config: normalizeLlmConfig({
    ...config,
    baseUrl: profile.baseUrl,
    model: route.model,
    apiKey: profile.apiKey,
  }), routed: true, source: 'task' };
}

export async function readConfigForTask(task, options = {}) {
  return (await readConfigForTaskSelection(task, options)).config;
}

export async function saveApiTaskRoutes(taskRoutes, {
  expectedRevision, signal,
} = {}) {
  return withStoreLock(apiProfilesLockKey(), async () => {
    const library = await readApiProfileLibrary({ signal });
    assertApiProfilesRevision(library, expectedRevision);
    const normalizedRoutes = normalizeApiTaskRoutes(taskRoutes, library.profiles);
    const next = { ...library, taskRoutes: normalizedRoutes };
    await ensureDirectory(DATA_ROOT);
    await atomicWriteJson(apiProfilesPath(), next, { mode: 0o600 });
    return { ...next, revision: apiProfilesRevision(next) };
  }, { signal });
}

export async function saveApiBookBinding(bookId, binding, {
  expectedRevision, signal,
} = {}) {
  const normalizedBookId = safeId(bookId);
  // 不允许为不存在的作品预占全局绑定名额。该读取在方案锁
  // 之前完成，避免与作品写锁形成反向等待；删除竞态最多留下
  // 一条无害的惰性绑定，不会读写已删除正文。
  await readBook(normalizedBookId, { signal });
  return withStoreLock(apiProfilesLockKey(), async () => {
    const library = await readApiProfileLibrary({ signal });
    assertApiProfilesRevision(library, expectedRevision);
    const normalizedBinding = normalizeApiBookBindingInput(binding, library.profiles);
    const existingIndex = library.bookBindings.findIndex(
      (item) => item.bookId === normalizedBookId,
    );
    if (normalizedBinding && existingIndex < 0
      && library.bookBindings.length >= MAX_API_BOOK_BINDINGS) {
      throw new Error('API_BOOK_BINDING_LIMIT');
    }
    const bookBindings = [...library.bookBindings];
    if (!normalizedBinding) {
      if (existingIndex >= 0) bookBindings.splice(existingIndex, 1);
    } else {
      const nextBinding = { bookId: normalizedBookId, ...normalizedBinding };
      if (existingIndex >= 0) bookBindings[existingIndex] = nextBinding;
      else bookBindings.push(nextBinding);
    }
    const next = { ...library, bookBindings };
    await ensureDirectory(DATA_ROOT);
    await atomicWriteJson(apiProfilesPath(), next, { mode: 0o600 });
    return { ...next, revision: apiProfilesRevision(next) };
  }, { signal });
}

export async function saveApiProfile(input, {
  expectedRevision, expectedConfigRevision, signal,
} = {}) {
  const normalizedInput = normalizeApiProfileInput(input);
  const requestedId = input.id;
  if (requestedId !== undefined
    && (typeof requestedId !== 'string' || !API_PROFILE_ID_PATTERN.test(requestedId))) {
    throw new Error('BAD_API_PROFILE_ID');
  }
  return withStoreLock(apiProfilesLockKey(), async () => {
    const library = await readApiProfileLibrary({ signal });
    assertApiProfilesRevision(library, expectedRevision);
    const existingIndex = requestedId === undefined
      ? -1 : library.profiles.findIndex((profile) => profile.id === requestedId);
    if (requestedId !== undefined && existingIndex < 0) {
      throw new Error('API_PROFILE_NOT_FOUND');
    }
    if (existingIndex < 0 && library.profiles.length >= MAX_API_PROFILES) {
      throw new Error('API_PROFILE_LIMIT');
    }
    const existing = existingIndex >= 0 ? library.profiles[existingIndex] : null;
    const commit = async (currentConfig = null) => {
      const rawBaseUrl = currentConfig?.baseUrl ?? input.baseUrl;
      let rawApiKey = currentConfig?.apiKey ?? input.apiKey;
      if (typeof rawApiKey === 'string' && rawApiKey.trim() === API_KEY_MASK) {
        if (!existing) throw new Error('API_KEY_REQUIRED_FOR_BASE_URL_CHANGE');
        rawApiKey = existing.apiKey;
      }
      const connection = normalizeLlmConfig({
        baseUrl: rawBaseUrl,
        model: normalizedInput.selectedModel,
        apiKey: rawApiKey,
      });
      if (existing && connection.baseUrl !== existing.baseUrl
        && typeof input.apiKey === 'string' && input.apiKey.trim() === API_KEY_MASK) {
        throw new Error('API_KEY_REQUIRED_FOR_BASE_URL_CHANGE');
      }
      const now = new Date().toISOString();
      const profile = {
        id: existing?.id ?? `profile_${randomUUID().replaceAll('-', '')}`,
        ...normalizedInput,
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const profiles = [...library.profiles];
      if (existingIndex >= 0) profiles[existingIndex] = profile;
      else profiles.push(profile);
      const activeConnectionChanged = existing && library.activeProfileId === existing.id
        && (profile.baseUrl !== existing.baseUrl
          || profile.apiKey !== existing.apiKey
          || profile.selectedModel !== existing.selectedModel);
      const next = {
        ...library,
        activeProfileId: activeConnectionChanged ? null : library.activeProfileId,
        profiles,
        taskRoutes: reconcileApiTaskRoutes(library.taskRoutes, profiles),
        bookBindings: reconcileApiBookBindings(library.bookBindings, profiles),
      };
      await ensureDirectory(DATA_ROOT);
      await atomicWriteJson(apiProfilesPath(), next, { mode: 0o600 });
      return { profile, revision: apiProfilesRevision(next) };
    };

    if (input.useCurrentConfig !== true) return commit();
    // 保持与“激活方案”相同的加锁顺序：方案库 -> 当前配置。
    // 这样在校验配置修订号到写入方案库之间，其他请求不能偷换
    // baseUrl / API Key，也不会与激活流程形成反向锁等待。
    return withStoreLock(configLockKey(), async () => {
      const currentConfig = await readConfig({ signal });
      if (typeof expectedConfigRevision !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/.test(expectedConfigRevision)) {
        throw new Error('BAD_CONFIG_REVISION');
      }
      if (configRevision(currentConfig) !== expectedConfigRevision) {
        throw new Error('CONFIG_CONFLICT');
      }
      return commit(currentConfig);
    }, { signal });
  }, { signal });
}

export async function deleteApiProfile(id, { expectedRevision, signal } = {}) {
  if (typeof id !== 'string' || !API_PROFILE_ID_PATTERN.test(id)) {
    throw new Error('BAD_API_PROFILE_ID');
  }
  return withStoreLock(apiProfilesLockKey(), async () => {
    const library = await readApiProfileLibrary({ signal });
    assertApiProfilesRevision(library, expectedRevision);
    if (!library.profiles.some((profile) => profile.id === id)) {
      throw new Error('API_PROFILE_NOT_FOUND');
    }
    const profiles = library.profiles.filter((profile) => profile.id !== id);
    const next = {
      version: 1,
      activeProfileId: library.activeProfileId === id ? null : library.activeProfileId,
      profiles,
      taskRoutes: reconcileApiTaskRoutes(library.taskRoutes, profiles),
      bookBindings: reconcileApiBookBindings(library.bookBindings, profiles),
    };
    await atomicWriteJson(apiProfilesPath(), next, { mode: 0o600 });
    return { ok: true, revision: apiProfilesRevision(next) };
  }, { signal });
}

export async function activateApiProfile(id, model, {
  expectedProfilesRevision, expectedConfigRevision, signal,
} = {}) {
  if (typeof id !== 'string' || !API_PROFILE_ID_PATTERN.test(id)) {
    throw new Error('BAD_API_PROFILE_ID');
  }
  return withStoreLock(apiProfilesLockKey(), async () => {
    const library = await readApiProfileLibrary({ signal });
    const profileIndex = library.profiles.findIndex((item) => item.id === id);
    if (profileIndex < 0) throw new Error('API_PROFILE_NOT_FOUND');
    const profile = library.profiles[profileIndex];
    if (typeof model !== 'string' || !profile.models.includes(model)) {
      throw new Error('BAD_API_PROFILE_MODEL');
    }
    assertApiProfilesRevision(library, expectedProfilesRevision);
    const sameSelection = library.activeProfileId === id
      && profile.selectedModel === model;
    const config = await writeConfig({
      baseUrl: profile.baseUrl, model, apiKey: profile.apiKey,
    }, { expectedRevision: expectedConfigRevision });
    if (sameSelection) {
      return { config, library: { ...library, revision: apiProfilesRevision(library) } };
    }
    const now = new Date().toISOString();
    const profiles = [...library.profiles];
    profiles[profileIndex] = { ...profile, selectedModel: model, updatedAt: now };
    const next = {
      version: 1, activeProfileId: id, profiles, taskRoutes: library.taskRoutes,
      bookBindings: library.bookBindings,
    };
    await atomicWriteJson(apiProfilesPath(), next, { mode: 0o600 });
    return { config, library: { ...next, revision: apiProfilesRevision(next) } };
  }, { signal });
}

// ——— 全局文风 / 故事结构资产库 ———
const writingAssetsPath = () => join(DATA_ROOT, 'writing-assets.json');
const writingAssetsLockKey = () => 'writing-assets:library';
const WRITING_ASSETS_REVISION_SALT = randomUUID();

function emptyWritingAssetLibrary() { return { version: 2, assets: [], bookBindings: {} }; }

export function writingAssetsRevision(library) {
  return createHash('sha256')
    .update(WRITING_ASSETS_REVISION_SALT, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(normalizeWritingAssetLibrary(library)), 'utf8')
    .digest('base64url');
}

async function readWritingAssetLibrary({ signal } = {}) {
  try {
    return normalizeWritingAssetLibrary(await readStoredJson(
      writingAssetsPath(), { mode: 0o600, signal },
    ));
  } catch (err) {
    throwIfAborted(signal);
    if (err?.code !== 'ENOENT') throw err;
    return emptyWritingAssetLibrary();
  }
}

export async function readWritingAssets({ signal } = {}) {
  const library = await readWritingAssetLibrary({ signal });
  return {
    revision: writingAssetsRevision(library),
    assets: library.assets,
    bookBindings: library.bookBindings,
  };
}

function normalizeWritingAssetTags(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_WRITING_ASSET_METADATA_TAGS) {
    throw new Error('BAD_ASSET_METADATA');
  }
  const tags = value.map((item) => {
    if (typeof item !== 'string' || item.length > MAX_WRITING_ASSET_METADATA_TAG_CHARS) {
      throw new Error('BAD_ASSET_METADATA');
    }
    return item.trim();
  }).filter(Boolean);
  return [...new Set(tags)];
}

function normalizeWritingAssetReferenceUrl(value, { required = false } = {}) {
  if (value === undefined || value === '') {
    if (required) throw new Error('BAD_ASSET_REFERENCE_URL');
    return '';
  }
  if (typeof value !== 'string' || value.length > MAX_WRITING_ASSET_REFERENCE_URL_CHARS) {
    throw new Error('BAD_ASSET_REFERENCE_URL');
  }
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password) throw new Error('BAD_ASSET_REFERENCE_URL');
    return parsed.href;
  } catch {
    throw new Error('BAD_ASSET_REFERENCE_URL');
  }
}

function normalizeWritingAssetMetadata(input, { requireReferenceUrl = false } = {}) {
  const normalizeNote = (value) => {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > MAX_WRITING_ASSET_NOTE_CHARS) {
      throw new Error('BAD_ASSET_METADATA');
    }
    return value.trim();
  };
  return {
    workNote: normalizeNote(input.workNote),
    rightsNote: normalizeNote(input.rightsNote),
    genres: normalizeWritingAssetTags(input.genres),
    sceneTags: normalizeWritingAssetTags(input.sceneTags),
    referenceUrl: normalizeWritingAssetReferenceUrl(input.referenceUrl, {
      required: requireReferenceUrl,
    }),
  };
}

function validateWritingAssetRights(sourceKind, rightsNote) {
  if (['authorized', 'public-domain', 'excerpt'].includes(sourceKind) && !rightsNote) {
    throw new Error('BAD_ASSET_RIGHTS_NOTE');
  }
}

function writingAssetSourceFingerprint(sourceText) {
  return createHash('sha256').update(sourceText.trim(), 'utf8').digest('base64url');
}

export async function findWritingAssetDuplicate(sourceText, { signal } = {}) {
  if (typeof sourceText !== 'string' || !sourceText.trim()) throw new Error('BAD_ASSET_SOURCE');
  const fingerprint = writingAssetSourceFingerprint(sourceText);
  const library = await readWritingAssetLibrary({ signal });
  return library.assets.find((asset) => asset.source.fingerprint === fingerprint) ?? null;
}

function normalizeWritingAssetSourceInput({
  name, sourceName, sourceKind, sourceText, analysis,
  sourceBookId, sourceSectionId, sourceChapterId, ...metadataInput
}) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('BAD_ASSET_NAME');
  if (name.length > MAX_WRITING_ASSET_NAME_CHARS) throw new Error('ASSET_NAME_TOO_LARGE');
  if (typeof sourceName !== 'string' || !sourceName.trim()) throw new Error('BAD_ASSET_SOURCE');
  if (sourceName.length > MAX_WRITING_ASSET_SOURCE_NAME_CHARS) {
    throw new Error('ASSET_SOURCE_NAME_TOO_LARGE');
  }
  if (!isWritingAssetTextSourceKind(sourceKind)) throw new Error('BAD_ASSET_SOURCE_KIND');
  if (typeof sourceText !== 'string' || !sourceText.trim()) throw new Error('BAD_ASSET_SOURCE');
  if (sourceText.length > MAX_WRITING_ASSET_SOURCE_CHARS) {
    throw new Error('ASSET_SOURCE_TOO_LARGE');
  }
  if (sourceKind === 'excerpt' && sourceText.length > MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS) {
    throw new Error('ASSET_EXCERPT_TOO_LARGE');
  }
  const normalizedAnalysis = sanitizeWritingAssetAnalysis(analysis);
  if (!normalizedAnalysis) throw new Error('ASSET_EXTRACTION_FAILED');
  const metadata = normalizeWritingAssetMetadata(metadataInput);
  validateWritingAssetRights(sourceKind, metadata.rightsNote);
  const origin = sourceKind === 'book-native' ? {
    bookId: safeId(sourceBookId),
    sectionId: safeId(sourceSectionId),
    chapterId: safeId(sourceChapterId),
  } : { bookId: '', sectionId: '', chapterId: '' };
  return {
    name: name.trim(), sourceName: sourceName.trim(), sourceKind,
    sourceText: sourceText.trim(), analysis: normalizedAnalysis, metadata, origin,
  };
}

export async function addWritingAsset(input, { signal } = {}) {
  const normalized = normalizeWritingAssetSourceInput(input);
  return withStoreLock(writingAssetsLockKey(), async () => {
    const library = await readWritingAssetLibrary({ signal });
    if (library.assets.length >= MAX_WRITING_ASSETS) throw new Error('ASSET_LIBRARY_LIMIT');
    const sourceText = normalized.sourceText;
    const fingerprint = writingAssetSourceFingerprint(sourceText);
    if (library.assets.some((asset) => asset.source.fingerprint === fingerprint)) {
      throw new Error('ASSET_DUPLICATE');
    }
    const asset = {
      id: `asset_${randomUUID().replaceAll('-', '')}`,
      name: normalized.name,
      createdAt: new Date().toISOString(),
      source: {
        kind: normalized.sourceKind,
        name: normalized.sourceName,
        ...normalized.metadata,
        ...normalized.origin,
        length: sourceText.length,
        fingerprint,
        preview: Array.from(sourceText).slice(0, MAX_WRITING_ASSET_SOURCE_PREVIEW_CHARS).join(''),
      },
      ...normalized.analysis,
    };
    const next = {
      version: 2,
      assets: [asset, ...library.assets],
      bookBindings: library.bookBindings,
    };
    await ensureDirectory(DATA_ROOT);
    await atomicWriteJson(writingAssetsPath(), next, { mode: 0o600 });
    return { asset, revision: writingAssetsRevision(next) };
  }, { signal });
}

export async function addWritingAssetReference(input, { signal } = {}) {
  const { name, sourceName, sourceKind, ...metadataInput } = input ?? {};
  if (typeof name !== 'string' || !name.trim()) throw new Error('BAD_ASSET_NAME');
  if (name.length > MAX_WRITING_ASSET_NAME_CHARS) throw new Error('ASSET_NAME_TOO_LARGE');
  if (typeof sourceName !== 'string' || !sourceName.trim()) throw new Error('BAD_ASSET_SOURCE');
  if (sourceName.length > MAX_WRITING_ASSET_SOURCE_NAME_CHARS) {
    throw new Error('ASSET_SOURCE_NAME_TOO_LARGE');
  }
  if (!isWritingAssetSourceKind(sourceKind) || sourceKind !== 'link-only') {
    throw new Error('BAD_ASSET_SOURCE_KIND');
  }
  const metadata = normalizeWritingAssetMetadata(metadataInput, { requireReferenceUrl: true });
  return withStoreLock(writingAssetsLockKey(), async () => {
    const library = await readWritingAssetLibrary({ signal });
    if (library.assets.length >= MAX_WRITING_ASSETS) throw new Error('ASSET_LIBRARY_LIMIT');
    if (library.assets.some((asset) => asset.source.referenceUrl === metadata.referenceUrl)) {
      throw new Error('ASSET_DUPLICATE');
    }
    const asset = {
      id: `asset_${randomUUID().replaceAll('-', '')}`,
      name: name.trim(),
      createdAt: new Date().toISOString(),
      source: {
        kind: sourceKind,
        name: sourceName.trim(),
        ...metadata,
        bookId: '', sectionId: '', chapterId: '',
        length: 0,
        fingerprint: '',
        preview: '',
      },
      style: null,
      story: null,
    };
    const next = {
      version: 2,
      assets: [asset, ...library.assets],
      bookBindings: library.bookBindings,
    };
    await ensureDirectory(DATA_ROOT);
    await atomicWriteJson(writingAssetsPath(), next, { mode: 0o600 });
    return { asset, revision: writingAssetsRevision(next) };
  }, { signal });
}

export async function exportWritingAssets({ signal } = {}) {
  const library = await readWritingAssetLibrary({ signal });
  return {
    format: 'auto-novel-box-writing-assets',
    version: 2,
    exportedAt: new Date().toISOString(),
    assets: library.assets,
    bookBindings: library.bookBindings,
  };
}

function removeWritingAssetFromBinding(binding, assetId) {
  const sceneAssetIds = Object.fromEntries(Object.entries(binding.sceneAssetIds)
    .filter(([, boundAssetId]) => boundAssetId !== assetId));
  return {
    nativeAssetId: binding.nativeAssetId === assetId ? null : binding.nativeAssetId,
    primaryAssetId: binding.primaryAssetId === assetId ? null : binding.primaryAssetId,
    auxiliaryAssetIds: binding.auxiliaryAssetIds.filter((id) => id !== assetId),
    sceneAssetIds,
    chapterScenes: binding.chapterScenes,
  };
}

export async function saveWritingAssetBookBinding(bookId, binding, {
  expectedRevision, signal,
} = {}) {
  const safeBookId = safeId(bookId);
  if (typeof expectedRevision !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(expectedRevision)) {
    throw new Error('BAD_ASSET_REVISION');
  }
  await readBook(safeBookId, { signal });
  return withStoreLock(writingAssetsLockKey(), async () => {
    const library = await readWritingAssetLibrary({ signal });
    if (writingAssetsRevision(library) !== expectedRevision) throw new Error('ASSET_CONFLICT');
    const usableAssetIds = new Set(
      library.assets.filter((asset) => asset.style).map((asset) => asset.id),
    );
    const normalizedBinding = normalizeWritingAssetBookBinding(binding, { usableAssetIds });
    if (!normalizedBinding) throw new Error('BAD_ASSET_BINDING');
    if (normalizedBinding.nativeAssetId) {
      const nativeAsset = library.assets.find(
        (asset) => asset.id === normalizedBinding.nativeAssetId,
      );
      if (nativeAsset?.source.kind !== 'book-native'
        || nativeAsset.source.bookId !== safeBookId) throw new Error('BAD_ASSET_BINDING');
    }
    const assetsById = new Map(library.assets.map((asset) => [asset.id, asset]));
    const regularIds = [
      normalizedBinding.primaryAssetId, ...normalizedBinding.auxiliaryAssetIds,
      ...Object.values(normalizedBinding.sceneAssetIds),
    ].filter(Boolean);
    if (regularIds.some((id) => assetsById.get(id)?.source.kind === 'book-native')) {
      throw new Error('BAD_ASSET_BINDING');
    }
    const exists = Object.prototype.hasOwnProperty.call(library.bookBindings, safeBookId);
    if (!exists && Object.keys(library.bookBindings).length >= MAX_WRITING_ASSET_BOOK_BINDINGS) {
      throw new Error('ASSET_BOOK_BINDING_LIMIT');
    }
    const next = {
      version: 2,
      assets: library.assets,
      bookBindings: { ...library.bookBindings, [safeBookId]: normalizedBinding },
    };
    await ensureDirectory(DATA_ROOT);
    await atomicWriteJson(writingAssetsPath(), next, { mode: 0o600 });
    return {
      binding: normalizedBinding,
      revision: writingAssetsRevision(next),
    };
  }, { signal });
}

export function writingAssetContextForLibrary(libraryValue, bookId, chapterId) {
  const library = normalizeWritingAssetLibrary(libraryValue);
  const binding = library.bookBindings[bookId];
  if (!binding) return { text: '', scene: null, assetIds: [] };
  const scene = chapterId ? binding.chapterScenes[chapterId] ?? null : null;
  const selected = [];
  if (binding.nativeAssetId) selected.push(['本书原生文风（最高优先级）', binding.nativeAssetId]);
  if (binding.primaryAssetId) selected.push(['外部主文风（次于本书原生）', binding.primaryAssetId]);
  for (const id of binding.auxiliaryAssetIds) selected.push(['辅助文风', id]);
  const sceneAssetId = scene ? binding.sceneAssetIds[scene] : null;
  if (sceneAssetId) selected.push([`本章${scene}场景参考`, sceneAssetId]);
  const seen = new Set();
  const assetsById = new Map(library.assets.map((asset) => [asset.id, asset]));
  const chunks = [];
  const assetIds = [];
  let remaining = MAX_WRITING_ASSET_CONTEXT_CHARS;
  const append = (value) => {
    if (remaining <= 0) return;
    const text = String(value ?? '');
    const clipped = text.slice(0, remaining);
    chunks.push(clipped);
    remaining -= clipped.length;
  };
  append('【已绑定创作资产】\n只使用以下抽象特征，不推断或复现任何来源作者、作品、角色、设定或原句。冲突时以本书禁忌和当前剧情因果为最高约束，其次是本书原生文风，再次是外部主文风；场景参考只调整本章局部表达。\n');
  for (const [role, id] of selected) {
    if (seen.has(id)) continue;
    seen.add(id);
    const asset = assetsById.get(id);
    if (!asset?.style || !asset.story) continue;
    assetIds.push(id);
    append(`【${role}】\n${asset.style.prompt}\n`);
    if (asset.style.avoid.length) append(`避免：${asset.style.avoid.join('；')}\n`);
    if (asset.story.reusableTechniques.length) {
      append(`可用结构技法：${asset.story.reusableTechniques.join('；')}\n`);
    }
  }
  if (!assetIds.length) return { text: '', scene, assetIds: [] };
  return { text: chunks.join('').trim(), scene, assetIds };
}

export async function readWritingAssetContext(bookId, chapterId, { signal } = {}) {
  const safeBookId = safeId(bookId);
  const safeChapterId = chapterId ? safeId(chapterId) : null;
  const library = await readWritingAssetLibrary({ signal });
  return writingAssetContextForLibrary(library, safeBookId, safeChapterId);
}

export async function deleteWritingAsset(id, { expectedRevision, signal } = {}) {
  if (typeof id !== 'string' || !/^asset_[0-9a-f]{32}$/.test(id)) {
    throw new Error('BAD_ASSET_ID');
  }
  if (typeof expectedRevision !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(expectedRevision)) {
    throw new Error('BAD_ASSET_REVISION');
  }
  return withStoreLock(writingAssetsLockKey(), async () => {
    const library = await readWritingAssetLibrary({ signal });
    if (writingAssetsRevision(library) !== expectedRevision) throw new Error('ASSET_CONFLICT');
    const index = library.assets.findIndex((asset) => asset.id === id);
    if (index < 0) throw new Error('ASSET_NOT_FOUND');
    const bookBindings = Object.fromEntries(Object.entries(library.bookBindings)
      .map(([bookId, binding]) => [bookId, removeWritingAssetFromBinding(binding, id)]));
    const next = {
      version: 2,
      assets: library.assets.filter((asset) => asset.id !== id),
      bookBindings,
    };
    await atomicWriteJson(writingAssetsPath(), next, { mode: 0o600 });
    return { ok: true, revision: writingAssetsRevision(next) };
  }, { signal });
}

// ——— 书架管理 ———
export async function deleteBook(id, { expectedUpdatedAt } = {}) {
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

export async function listDeletedBooks({ signal } = {}) {
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

  const tempParent = join(DATA_ROOT, '.imports');
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

export async function restoreDeletedBook(trashId, { signal } = {}) {
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

export function stageSummaryRevision(book) {
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

export function bookMemoryRevision(book) {
  const memory = validateStoredData(() => normalizeBackupBookMemory(book?.memory));
  return createHash('sha256')
    .update(MEMORY_REVISION_SALT, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(memory), 'utf8')
    .digest('base64url');
}

export function chapterMemoryCandidatesView(book, chapter) {
  const memory = validateStoredData(() => normalizeBackupBookMemory(book?.memory));
  const facts = new Map(memory.facts.map((fact) => [fact.id, fact]));
  const rejected = new Set(memory.rejectedCandidateIds);
  return (Array.isArray(chapter?.memoryCandidates) ? chapter.memoryCandidates : []).map(
    (candidate) => {
      const fact = facts.get(candidate.id);
      const status = fact
        ? fact.status === 'active' ? 'accepted' : fact.status
        : rejected.has(candidate.id) ? 'rejected' : 'pending';
      return { ...candidate, status };
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

export async function readStageSummarySource(bookId, input, {
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

export async function saveGeneratedStageSummary(bookId, input, {
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

export async function saveStageSummary(bookId, input, {
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

export async function deleteStageSummary(bookId, stageSummaryId, {
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

export { createStageSummaryId };

export async function readBookMemory(bookId, { signal } = {}) {
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

export async function deactivateMemoryFact(bookId, factId, {
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

export async function applyChapterDigest(bookId, sectionId, chapterId, digest, {
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

export async function decideMemoryCandidate(bookId, sectionId, chapterId, candidateId, {
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
        if (existing?.status === 'active') throw new Error('MEMORY_DECISION_CONFLICT');
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

export function chapterPublicationView(chapter) {
  const published = chapter?.published;
  if (!published) return null;
  return {
    ...published,
    isCurrent: published.bodyFingerprint === chapter.bodyFingerprint,
  };
}

export async function publishChapterVersion(bookId, sectionId, chapterId, {
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

export async function readChapterPublicationPreflight(bookId, sectionId, chapterId, {
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
      const checks = [
        {
          id: 'format', label: '章节格式',
          status: formatRisks.length ? 'risk' : 'pass',
          detail: formatRisks.length
            ? formatRisks.join('；')
            : `未见控制字符、异常连续空行或重复章名；正文约 ${characterCount} 字符、${paragraphCount} 个非空段落。`,
        },
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

export async function saveChapterReview(bookId, sectionId, chapterId, review, {
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
    const currentContextRevision = chapterReviewContextRevision({
      book, section, chapter, bookChapterIndex, recentReviewSignals, writingAssetContext,
    });
    if (expectedContextRevision !== undefined
      && currentContextRevision !== expectedContextRevision) {
      return { applied: false, reason: 'context', chapter };
    }
    const savedReview = {
      ...review,
      sourceCursor: chapter.body.cursor,
      sourceFingerprint: chapter.bodyFingerprint,
      sourceContextRevision: currentContextRevision,
      updatedAt: new Date().toISOString(),
    };
    throwIfAborted(signal);
    chapter.review = savedReview;
    await touchBookUnlocked(safeBookId);
    await writeChapterFile(safeBookId, safeSectionId, safeChapterId, chapter);
    return { applied: true, chapter, review: savedReview };
  }, { signal });
}

export function chapterReviewContextRevision({
  book, section, chapter, bookChapterIndex = chapter?.index, recentReviewSignals = [],
  writingAssetContext = { text: '', scene: null, assetIds: [] },
}) {
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
      characters: generationCharacterRows(book?.characters),
      memory: generationMemoryRows(book?.memory, {
        relevantText: generationMemoryRelevantText({ book, section }),
      }),
    },
    section: {
      outline: generationSectionOutlineText(
        typeof section?.outline?.content === 'string' ? section.outline.content : '',
      ),
      summary: recentSectionSummary(section?.summary),
      characters: generationCharacterRows(section?.characters),
    },
    chapterIndex: chapter?.index,
    bookChapterIndex,
    recentReviewSignals,
    writingAssetContext,
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
      if (currentText(candidateChapter.body).trim()) {
        const currentSignals = candidateChapter.review?.sourceFingerprint
            === candidateChapter.bodyFingerprint
          ? normalizeChapterReviewSignals(candidateChapter.review.webFictionSignals)
          : undefined;
        rows.unshift({
          bookChapterIndex: candidateBookIndex,
          sectionChapterIndex: candidatePosition + 1,
          signals: currentSignals && currentSignals !== null ? currentSignals : null,
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
  const writingAssetContext = await readWritingAssetContext(bookId, chapterId, { signal });
  return {
    book,
    section,
    chapter,
    bookChapterIndex,
    recentReviewSignals,
    writingAssetContext,
    contextRevision: chapterReviewContextRevision({
      book, section, chapter, bookChapterIndex, recentReviewSignals, writingAssetContext,
    }),
  };
}

export async function readChapterReviewContext(bookId, sectionId, chapterId, { signal } = {}) {
  throwIfAborted(signal);
  return withChapterWriteLocks(bookId, sectionId, chapterId,
    (safeBookId, safeSectionId, safeChapterId) =>
      readChapterReviewContextUnlocked(safeBookId, safeSectionId, safeChapterId, { signal }),
    { signal });
}

// 只纳入章节提示词真正读取的持久化字段。updatedAt 等无关变化不应
// 让已经完成的昂贵生成失效；书名、简介、大纲、核心设定、人物、
// 本部前情和上一章路标变化则必须阻止旧上下文结果落盘。
export function chapterGenerationContextRevision({
  book, section, previousChapter, previousChapterSectionId, chapter,
  bookChapterIndex = chapter?.index, recentReviewSignals = [],
  writingAssetContext = { text: '', scene: null, assetIds: [] },
}) {
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
      characters: generationCharacterRows(book?.characters),
      memory: generationMemoryRows(book?.memory, {
        relevantText: generationMemoryRelevantText({ book, section, prevChapter: previousChapter }),
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
      progress: typeof previousChapter.progress === 'string' ? previousChapter.progress : '',
      characters: generationCharacterRows(previousChapter.characters),
    } : null,
    chapterIndex: chapter?.index,
    bookChapterIndex,
    recentReviewSignals,
    writingAssetContext,
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

async function readChapterGenerationContextUnlocked(bookId, sectionId, chapterId, { signal } = {}) {
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
    targetRevision: versionRevision(chapter.body),
    contextRevision: chapterGenerationContextRevision({
      book, section, previousChapter, previousChapterSectionId, chapter,
      bookChapterIndex, recentReviewSignals, writingAssetContext,
    }),
  };
}

export async function readChapterGenerationContext(bookId, sectionId, chapterId, { signal } = {}) {
  throwIfAborted(signal);
  return withChapterWriteLocks(bookId, sectionId, chapterId,
    (safeBookId, safeSectionId, safeChapterId) =>
      readChapterGenerationContextUnlocked(safeBookId, safeSectionId, safeChapterId, { signal }),
    { signal });
}

export async function commitGeneratedChapter(bookId, sectionId, chapterId, text, {
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

export function bookGenerationContextRevision(book) {
  return jsonFingerprint({
    premise: typeof book?.premise === 'string' ? book.premise : '',
    core: {
      world: generationCoreFieldText(currentText(book?.settings?.core?.world)),
      style: generationCoreFieldText(currentText(book?.settings?.core?.style)),
      constraints: generationCoreFieldText(currentText(book?.settings?.core?.constraints)),
      pacing: generationCoreFieldText(currentText(book?.settings?.core?.pacing)),
    },
  });
}

export function sectionPlanContextRevision(book) {
  return jsonFingerprint({
    outline: currentText(book?.outline),
    core: {
      world: generationCoreFieldText(currentText(book?.settings?.core?.world)),
      style: generationCoreFieldText(currentText(book?.settings?.core?.style)),
      constraints: generationCoreFieldText(currentText(book?.settings?.core?.constraints)),
      pacing: generationCoreFieldText(currentText(book?.settings?.core?.pacing)),
    },
  });
}

export async function commitGeneratedBookVersion(bookId, path, text, {
  expectedRevision,
  expectedContextRevision,
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
    throwIfAborted(signal);
    commitVersion(versioned, text);
    await writeBookUnlocked(safeBookId, book);
    return versioned;
  }, { signal });
}

export async function versionMove(bookId, path, delta, { expectedRevision } = {}) {
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
export async function versionSet(bookId, path, text, { expectedRevision } = {}) {
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
