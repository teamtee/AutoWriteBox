import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectTopLevelJsonFromHandle } from '../backup-json.js';
import {
  MAX_API_PROFILES_JSON_BYTES, MAX_BOOK_JSON_BYTES, MAX_CHAPTER_JSON_BYTES,
  MAX_CONFIG_JSON_BYTES, MAX_IMPORT_OWNER_JSON_BYTES, MAX_SECTION_JSON_BYTES,
  MAX_STORAGE_ROOT_DIRECTORY_ENTRIES, MAX_STRUCTURE_TRANSACTION_JSON_BYTES,
  MAX_WRITING_ASSET_JSON_BYTES,
} from '../limits.js';
import { withJsonReadSlot } from './concurrency.js';
import { createLimitedJsonWriter } from './json-writer.js';
import {
  BOOK_STRUCTURE_TRANSACTION_FILE, CHAPTER_DIGEST_TRANSACTION_FILE,
  IMPORT_STAGE_OWNER_FILE, SECTION_STRUCTURE_TRANSACTION_FILE,
} from './structure-constants.js';

const STRUCTURE_TRANSACTION_FILES = new Set([
  BOOK_STRUCTURE_TRANSACTION_FILE,
  SECTION_STRUCTURE_TRANSACTION_FILE,
  CHAPTER_DIGEST_TRANSACTION_FILE,
]);
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set([
  'EBADF', 'EINVAL', 'EISDIR', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM',
]);

function storageFileTooLarge() {
  throw new Error('STORAGE_FILE_TOO_LARGE');
}

function storagePathUnsafe() {
  throw new Error('STORAGE_PATH_UNSAFE');
}

export function parseStoredJsonBytes(bytes) {
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

export function createStoreIo({ getDataRoot, throwIfAborted }) {
  if (typeof getDataRoot !== 'function' || typeof throwIfAborted !== 'function') {
    throw new TypeError('STORE_IO_DEPENDENCY_REQUIRED');
  }

  const storedJsonByteLimit = (absPath) => {
    const name = basename(absPath);
    if (name === 'book.json') return MAX_BOOK_JSON_BYTES;
    if (name === 'section.json') return MAX_SECTION_JSON_BYTES;
    if (name === 'config.json') return MAX_CONFIG_JSON_BYTES;
    if (name === 'api-profiles.json') return MAX_API_PROFILES_JSON_BYTES;
    if (name === 'writing-assets.json') return MAX_WRITING_ASSET_JSON_BYTES;
    if (STRUCTURE_TRANSACTION_FILES.has(name)) return MAX_STRUCTURE_TRANSACTION_JSON_BYTES;
    if (name === IMPORT_STAGE_OWNER_FILE) return MAX_IMPORT_OWNER_JSON_BYTES;
    return MAX_CHAPTER_JSON_BYTES;
  };

  const storagePathComponents = (absPath) => {
    const root = resolve(getDataRoot());
    const target = resolve(absPath);
    const rel = relative(root, target);
    if (rel === '') return { root, target, components: [] };
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      return storagePathUnsafe();
    }
    return { root, target, components: rel.split(sep).filter(Boolean) };
  };

  const assertSafeStoragePath = async (absPath, { expect = 'any' } = {}) => {
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
  };

  const assertSafeWriteTarget = async (absPath) => {
    const checkedParent = await assertSafeStoragePath(
      dirname(absPath),
      { expect: 'directory' },
    );
    try { await assertSafeStoragePath(absPath, { expect: 'file' }); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return checkedParent;
  };

  const isWithinStorageRoot = (absPath) => {
    const rel = relative(resolve(getDataRoot()), resolve(absPath));
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  };

  const tightenStorageDirectories = async (directories) => {
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
      await assertSafeStoragePath(directory.path, { expect: 'directory' });
    }
  };

  const readSafeDirectory = async (
    absDir,
    options,
    maxEntries = MAX_STORAGE_ROOT_DIRECTORY_ENTRIES,
  ) => {
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
  };

  const assertStorageDirectoryCapacity = async (absDir, errorCode) => {
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
  };

  const openStoredJsonForRead = async (absPath, { mode, signal }) => {
    throwIfAborted(signal);
    const maxBytes = storedJsonByteLimit(absPath);
    let handle;
    try {
      const checkedPath = await assertSafeStoragePath(absPath, { expect: 'file' });
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
      await assertSafeStoragePath(absPath, { expect: 'file' });
      if (mode !== null) await handle.chmod(mode);
      if (metadata.size > maxBytes) storageFileTooLarge();
      return { handle, maxBytes, size: metadata.size };
    } catch (error) {
      await handle?.close().catch(() => {});
      throw error;
    }
  };

  const readStoredJson = async (absPath, { mode = 0o600, signal } = {}) =>
    withJsonReadSlot(async () => {
      let opened;
      try {
        opened = await openStoredJsonForRead(absPath, { mode, signal });
        const { handle, maxBytes, size } = opened;
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

  const readStoredJsonProjection = async (
    absPath, specification, {
      mode = 0o600, signal, projectionInvalidError,
    } = {},
  ) => withJsonReadSlot(async () => {
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

  const syncDirectory = async (absDir, { afterCommit = false } = {}) => {
    let handle;
    let failure;
    try {
      handle = await open(absDir, 'r');
      await handle.sync();
    } catch (error) {
      failure = error;
    } finally {
      await handle?.close().catch(() => {});
    }
    if (!failure || DIRECTORY_SYNC_UNSUPPORTED_CODES.has(failure?.code)) return;
    if (afterCommit) {
      console.warn(`[store] directory durability could not be confirmed after commit (${failure?.code || 'UNKNOWN'})`);
      return;
    }
    throw failure;
  };

  const assertExistingDirectory = async (absDir) => {
    const metadata = await lstat(absDir);
    if (metadata.isSymbolicLink()) return storagePathUnsafe();
    if (!metadata.isDirectory()) throw new Error('STORAGE_PATH_INVALID');
  };

  const verifyAndTightenExistingDirectory = async (absDir) => {
    if (!isWithinStorageRoot(absDir)) {
      await assertExistingDirectory(absDir);
      return;
    }
    const checkedPath = await assertSafeStoragePath(absDir, { expect: 'directory' });
    await tightenStorageDirectories(checkedPath.directories);
  };

  const ensureDirectory = async function ensureDirectoryRecursive(absDir) {
    try {
      await verifyAndTightenExistingDirectory(absDir);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(absDir);
    if (parent === absDir) throw new Error('STORAGE_PATH_INVALID');
    await ensureDirectoryRecursive(parent);
    try {
      await mkdir(absDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await verifyAndTightenExistingDirectory(absDir);
      return;
    }
    await syncDirectory(parent);
  };

  const ensureDataSubdirectory = async (absDir) => {
    if (!isWithinStorageRoot(absDir)) throw new Error('STORAGE_PATH_INVALID');
    return ensureDirectory(absDir);
  };

  const syncCommittedDirectories = async (absDirs, {
    sync = (absDir) => syncDirectory(absDir),
  } = {}) => {
    let firstFailure;
    for (const absDir of new Set(absDirs)) {
      try {
        await sync(absDir);
      } catch (error) {
        firstFailure ??= error;
        console.warn(`[store] directory durability could not be confirmed after commit (${error?.code || 'UNKNOWN'})`);
      }
    }
    if (firstFailure) throw firstFailure;
  };

  const durableRename = async (source, destination) => {
    await assertSafeStoragePath(source);
    await assertSafeStoragePath(dirname(destination), { expect: 'directory' });
    try { await assertSafeStoragePath(destination); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(source, destination);
    await syncCommittedDirectories([dirname(source), dirname(destination)]);
  };

  const atomicWriteJson = async (absPath, obj, { mode = 0o600 } = {}) => {
    const tmp = `${absPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    let handle;
    try {
      const checkedParent = await assertSafeWriteTarget(absPath);
      await tightenStorageDirectories(checkedParent.directories);
      handle = await open(tmp, 'wx', mode);
      const writer = createLimitedJsonWriter(
        handle, storedJsonByteLimit(absPath), undefined, 'STORAGE_FILE_TOO_LARGE',
      );
      await writer.writeJson(obj);
      await writer.flush();
      await handle.sync();
      await handle.close();
      handle = undefined;
      await durableRename(tmp, absPath);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };

  return Object.freeze({
    assertSafeStoragePath,
    assertStorageDirectoryCapacity,
    atomicWriteJson,
    durableRename,
    ensureDataSubdirectory,
    ensureDirectory,
    readSafeDirectory,
    readStoredJson,
    readStoredJsonProjection,
    syncCommittedDirectories,
    syncDirectory,
  });
}
