import { constants } from 'node:fs';
import { chmod, mkdtemp, open, opendir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  BOOK_BACKUP_MAX_BYTES, diagnoseStorage, importBookBackupFile, listDeletedBooks,
  createCachedProcessStartedAtResolver, processOwnerIsAlive, processStartedAtMsForPid,
  ensureDataSubdirectory, getDataRoot, restoreDeletedBook, writeBookBackupFile,
  writeBookManuscriptFile,
} from '../store.js';
import { sendJsonError } from '../http-error.js';
import { createClientAbortTracker } from '../client-abort.js';
import { sendJsonStream } from '../http-json.js';
import { readFileHandleBounded } from '../bounded-io.js';

const TRANSFER_OWNER_FORMAT = 'auto-novel-box-transfer';
const TRANSFER_OWNER_FILE = '.transfer-owner.json';
const TRANSFER_DIRECTORY_NAME = /^novelbox-(upload|export)-[A-Za-z0-9]{6}$/;
const DEFAULT_TRANSFER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TRANSFER_OWNER_BYTES = 4096;
const MAX_TRANSFER_SCAN_ENTRIES = 20_000;
const PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;
const PROCESS_STARTED_AT = new Date(PROCESS_STARTED_AT_MS).toISOString();
const PREPARED_BACKUP_TTL_MS = 5 * 60 * 1000;
const MAX_PREPARED_BACKUPS = 4;
const MAX_ACTIVE_BACKUP_TRANSFERS = 2;
const MAX_ACTIVE_BACKUP_UPLOADS = 2;
const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const REQUESTED_BOOK_ID_PATTERN = /^book_[0-9a-f]{32}$/;
const defaultTransferTempParent = () => join(getDataRoot(), '.transfers');

function requestedBookIdHeader(req) {
  const value = req.headers?.['x-novelbox-book-id'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !REQUESTED_BOOK_ID_PATTERN.test(value)) {
    throw new Error('BAD_BOOK_CREATION_ID');
  }
  return value;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function readTransferOwner(path) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0),
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_TRANSFER_OWNER_BYTES) return null;
    const bytes = await readFileHandleBounded(handle, MAX_TRANSFER_OWNER_BYTES);
    if (bytes === null) return null;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function createTransferTempRoot(kind, {
  tempParent,
  pid = process.pid,
  nowMs = Date.now(),
  processStartedAt = PROCESS_STARTED_AT,
} = {}) {
  if (!['upload', 'export'].includes(kind)) throw new Error('BAD_TRANSFER_KIND');
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(nowMs)
    || typeof processStartedAt !== 'string'
    || !Number.isFinite(Date.parse(processStartedAt))) {
    throw new Error('BAD_TRANSFER_OWNER');
  }
  const parent = tempParent ?? defaultTransferTempParent();
  if (tempParent === undefined) await ensureDataSubdirectory(parent);
  const root = await mkdtemp(join(parent, `novelbox-${kind}-`));
  try {
    await chmod(root, 0o700);
    const ownerPath = join(root, TRANSFER_OWNER_FILE);
    const handle = await open(ownerPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({
        format: TRANSFER_OWNER_FORMAT,
        kind,
        pid,
        createdAt: nowMs,
        processStartedAt,
      }), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function cleanupAbandonedTransferDirs({
  tempParent,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_TRANSFER_MAX_AGE_MS,
  processAlive = isProcessAlive,
  processStartedAtForPid,
  currentPid = process.pid,
  currentProcessStartedAt = PROCESS_STARTED_AT,
  maxEntries = MAX_TRANSFER_SCAN_ENTRIES,
} = {}) {
  if (!Number.isInteger(currentPid) || currentPid <= 0
    || typeof currentProcessStartedAt !== 'string'
    || !Number.isFinite(Date.parse(currentProcessStartedAt))) {
    throw new Error('BAD_TRANSFER_OWNER');
  }
  const scanLimit = Number.isSafeInteger(maxEntries) && maxEntries > 0
    ? Math.min(maxEntries, MAX_TRANSFER_SCAN_ENTRIES)
    : MAX_TRANSFER_SCAN_ENTRIES;
  const parent = tempParent ?? defaultTransferTempParent();
  if (tempParent === undefined) await ensureDataSubdirectory(parent);
  let directory;
  try {
    directory = await opendir(parent);
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: 0 };
    throw error;
  }

  let removed = 0;
  let scannedEntries = 0;
  let truncated = false;
  const resolveProcessStartedAt = createCachedProcessStartedAtResolver(
    processStartedAtForPid
      ?? (processAlive === isProcessAlive ? processStartedAtMsForPid : null),
  );
  try {
    for await (const entry of directory) {
      if (scannedEntries >= scanLimit) {
        truncated = true;
        break;
      }
      scannedEntries += 1;
      const match = TRANSFER_DIRECTORY_NAME.exec(entry.name);
      if (!match || !entry.isDirectory()) continue;
      const root = join(parent, entry.name);
      let metadata;
      try {
        metadata = await stat(root);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      const owner = await readTransferOwner(join(root, TRANSFER_OWNER_FILE));
      const validOwner = owner?.format === TRANSFER_OWNER_FORMAT
        && owner.kind === match[1]
        && Number.isInteger(owner.pid)
        && owner.pid > 0
        && Number.isFinite(owner.createdAt)
        && (owner.processStartedAt === undefined
          || (typeof owner.processStartedAt === 'string'
            && Number.isFinite(Date.parse(owner.processStartedAt))));
      const createdAt = validOwner ? owner.createdAt : metadata.mtimeMs;
      const expired = Number.isFinite(createdAt)
        && Math.max(0, nowMs - createdAt) >= Math.max(0, maxAgeMs);
      if (validOwner) {
        const belongsToPriorCurrentPid = owner.pid === currentPid
          && (owner.processStartedAt !== undefined
            ? owner.processStartedAt !== currentProcessStartedAt
            : owner.createdAt < Date.parse(currentProcessStartedAt));
        // 系统休眠或时钟前跳不能让另一个项目副本删除仍由活跃进程持有的
        // 上传/导出目录。同 PID 但启动身份不同则是可确认的旧进程残留。
        if (!belongsToPriorCurrentPid && await processOwnerIsAlive(owner, {
          processAlive,
          processStartedAtForPid: resolveProcessStartedAt,
        })) continue;
      }
      if (!validOwner && !expired) continue;
      await rm(root, { recursive: true, force: true });
      removed += 1;
    }
  } finally {
    await directory.close().catch((error) => {
      if (error?.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  return { removed, scannedEntries, truncated };
}

export function createPreparedBackupRegistry({
  ttlMs = PREPARED_BACKUP_TTL_MS,
  maxEntries = MAX_PREPARED_BACKUPS,
  createToken = () => randomUUID(),
  cleanupRoot = (root) => rm(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 20,
  }),
} = {}) {
  const entries = new Map();
  const pendingCleanups = new Set();
  const cleanupRecord = (record) => {
    const pending = Promise.resolve()
      .then(() => cleanupRoot(record.root))
      .catch(() => {});
    pendingCleanups.add(pending);
    void pending.finally(() => pendingCleanups.delete(pending));
    return pending;
  };
  const remove = (token) => {
    const entry = entries.get(token);
    if (!entry) return null;
    entries.delete(token);
    clearTimeout(entry.timer);
    return entry.record;
  };
  const registry = {
    canRegister() {
      return entries.size + pendingCleanups.size < maxEntries;
    },
    register(record) {
      if (!registry.canRegister()) throw new Error('BACKUP_EXPORT_BUSY');
      let token = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = createToken();
        if (typeof candidate === 'string' && candidate && !entries.has(candidate)) {
          token = candidate;
          break;
        }
      }
      if (!token) throw new Error('Unable to allocate a unique backup token');
      const entry = { record, timer: null };
      entries.set(token, entry);
      entry.timer = setTimeout(() => { void registry.expire(token); }, Math.max(0, ttlMs));
      entry.timer.unref?.();
      return token;
    },
    take(token) {
      return remove(token);
    },
    peek(token) {
      return entries.get(token)?.record ?? null;
    },
    async expire(token) {
      const record = remove(token);
      if (!record) return false;
      await cleanupRecord(record);
      return true;
    },
    async clear() {
      const tokens = [...entries.keys()];
      await Promise.all(tokens.map((token) => registry.expire(token)));
      // expire() 会先从 Map 删除再异步清理目录；响应 close 监听器或 TTL
      // 可能已启动这种清理。关闭阶段即使看不到条目，也必须等待这些数据根
      // 操作完成，随后才可释放实例租约。
      await Promise.all([...pendingCleanups]);
      return tokens.length;
    },
    get size() {
      return entries.size;
    },
  };
  return registry;
}

const preparedBackups = createPreparedBackupRegistry();

export function cleanupPreparedBackups() {
  return preparedBackups.clear();
}

export function createBackupTransferLimiter(maxActive = MAX_ACTIVE_BACKUP_TRANSFERS) {
  let active = 0;
  return async function run(task) {
    if (active >= maxActive) throw new Error('BACKUP_EXPORT_BUSY');
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
    }
  };
}

const withBackupTransferSlot = createBackupTransferLimiter();
const withBackupUploadSlot = createBackupTransferLimiter(MAX_ACTIVE_BACKUP_UPLOADS);

export async function downloadFile(res, path, filename, {
  idleTimeoutMs = DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS,
} = {}) {
  const boundedIdleTimeoutMs = Number.isSafeInteger(idleTimeoutMs) && idleTimeoutMs > 0
    ? idleTimeoutMs
    : DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS;
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      res.removeListener?.('timeout', onTimeout);
      if (!res.destroyed) res.setTimeout?.(0);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onTimeout = () => {
      const error = new Error('RESPONSE_BACKPRESSURE_TIMEOUT');
      finish(error);
      res.destroy?.();
    };
    res.setTimeout?.(boundedIdleTimeoutMs, onTimeout);
    try {
      res.download(path, filename, (error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

function setBackupDownloadHeaders(res, contentType = 'application/json; charset=utf-8') {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function retainPreparedBackupOnlyForDeliveredResponse(res, token, registry) {
  const delivered = () => {
    res.removeListener('close', discardUndelivered);
  };
  const discardUndelivered = () => {
    res.removeListener('finish', delivered);
    if (!res.writableFinished) void registry.expire(token);
  };
  res.once('close', discardUndelivered);
  res.once('finish', delivered);
}

export async function writeRequestBodyToFile(request, absPath, {
  maxBytes = BOOK_BACKUP_MAX_BYTES,
} = {}) {
  const declaredText = Array.isArray(request.headers?.['content-length'])
    ? request.headers['content-length'][0]
    : request.headers?.['content-length'];
  const declaredBytes = typeof declaredText === 'string' && /^\d+$/.test(declaredText)
    ? Number(declaredText)
    : null;
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    request.resume?.();
    throw new Error('BACKUP_TOO_LARGE');
  }

  let handle;
  let totalBytes = 0;
  try {
    handle = await open(absPath, 'wx', 0o600);
    const iterable = typeof request.iterator === 'function'
      ? request.iterator({ destroyOnReturn: false })
      : request;
    for await (const rawChunk of iterable) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        request.resume?.();
        throw new Error('BACKUP_TOO_LARGE');
      }
      await handle.writeFile(chunk);
    }
    if (totalBytes === 0) throw new Error('BACKUP_INVALID');
    await handle.sync();
    await handle.close();
    handle = undefined;
    return totalBytes;
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(absPath, { force: true }).catch(() => {});
    throw err;
  }
}

export function mountStorageRoutes(app, deps = {}) {
  const backupRegistry = deps.preparedBackups ?? preparedBackups;
  const runBackupTransfer = deps.withBackupTransferSlot ?? withBackupTransferSlot;
  const runBackupUpload = deps.withBackupUploadSlot ?? withBackupUploadSlot;
  const createTransferRoot = deps.createTransferTempRoot ?? createTransferTempRoot;
  const writeBackupFile = deps.writeBookBackupFile ?? writeBookBackupFile;
  const writeManuscriptFile = deps.writeBookManuscriptFile ?? writeBookManuscriptFile;
  const importBackupFile = deps.importBookBackupFile ?? importBookBackupFile;
  const runStorageDiagnostics = deps.diagnoseStorage ?? diagnoseStorage;
  const listTrashBooks = deps.listDeletedBooks ?? listDeletedBooks;
  const restoreTrashBook = deps.restoreDeletedBook ?? restoreDeletedBook;
  const sendJsonResponse = deps.sendJsonResponse ?? sendJsonStream;

  app.post('/api/books/:id/backup/prepare', async (req, res) => {
    let tempRoot;
    let registeredToken;
    const client = createClientAbortTracker(req, res);
    try {
      if (!backupRegistry.canRegister()) throw new Error('BACKUP_EXPORT_BUSY');
      await runBackupTransfer(async () => {
        client.assertAlive();
        tempRoot = await createTransferRoot('export');
        const backupPath = join(tempRoot, 'backup.novelbox.json');
        const { bookId } = await writeBackupFile(req.params.id, backupPath, {
          signal: client.signal,
        });
        await client.assertAliveAfterIo();
        const token = backupRegistry.register({
          root: tempRoot,
          path: backupPath,
          filename: `${bookId}.novelbox.json`,
        });
        registeredToken = token;
        tempRoot = undefined;
        // 注册与监听器绑定之间不 await，断连事件无法插入这个临界区。
        client.assertAlive();
        retainPreparedBackupOnlyForDeliveredResponse(res, token, backupRegistry);
        res.json({ downloadUrl: `/api/backups/download/${encodeURIComponent(token)}` });
        registeredToken = undefined;
      });
    } catch (error) {
      if (registeredToken) await backupRegistry.expire(registeredToken);
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) res.destroy(error);
      else sendJsonError(res, error);
    } finally {
      client.dispose();
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
  app.post('/api/books/:id/manuscript/prepare', async (req, res) => {
    let tempRoot;
    let registeredToken;
    const client = createClientAbortTracker(req, res);
    try {
      if (!backupRegistry.canRegister()) throw new Error('BACKUP_EXPORT_BUSY');
      await runBackupTransfer(async () => {
        client.assertAlive();
        const source = req.body?.source ?? 'current';
        if (!['current', 'published'].includes(source)) {
          throw new Error('BAD_MANUSCRIPT_SOURCE');
        }
        tempRoot = await createTransferRoot('export');
        const manuscriptPath = join(tempRoot, 'manuscript.txt');
        const result = await writeManuscriptFile(req.params.id, manuscriptPath, {
          source, signal: client.signal,
        });
        await client.assertAliveAfterIo();
        const token = backupRegistry.register({
          root: tempRoot,
          path: manuscriptPath,
          filename: `${result.bookId}.${source}.txt`,
          contentType: 'text/plain; charset=utf-8',
        });
        registeredToken = token;
        tempRoot = undefined;
        client.assertAlive();
        retainPreparedBackupOnlyForDeliveredResponse(res, token, backupRegistry);
        res.json({
          downloadUrl: `/api/backups/download/${encodeURIComponent(token)}`,
          source: result.source,
          totalChapterCount: result.totalChapterCount,
          exportedChapterCount: result.exportedChapterCount,
          skippedChapterCount: result.skippedChapterCount,
        });
        registeredToken = undefined;
      });
    } catch (error) {
      if (registeredToken) await backupRegistry.expire(registeredToken);
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) res.destroy(error);
      else sendJsonError(res, error);
    } finally {
      client.dispose();
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
  app.head('/api/backups/download/:token', async (req, res) => {
    try {
      const prepared = backupRegistry.peek(req.params.token);
      if (!prepared) throw new Error('BACKUP_DOWNLOAD_NOT_FOUND');
      let metadata;
      try {
        metadata = await stat(prepared.path);
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error('BACKUP_DOWNLOAD_NOT_FOUND');
        throw error;
      }
      if (!metadata.isFile()) throw new Error('BACKUP_DOWNLOAD_NOT_FOUND');
      setBackupDownloadHeaders(res, prepared.contentType);
      res.attachment(prepared.filename);
      res.setHeader('Content-Length', String(metadata.size));
      res.end();
    } catch (error) {
      sendJsonError(res, error);
    }
  });
  app.get('/api/backups/download/:token', async (req, res) => {
    let prepared;
    try {
      await runBackupTransfer(async () => {
        prepared = backupRegistry.take(req.params.token);
        if (!prepared) throw new Error('BACKUP_DOWNLOAD_NOT_FOUND');
        setBackupDownloadHeaders(res, prepared.contentType);
        await downloadFile(res, prepared.path, prepared.filename);
      });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      sendJsonError(res, error);
    } finally {
      if (prepared) await rm(prepared.root, { recursive: true, force: true }).catch(() => {});
    }
  });
  app.get('/api/books/:id/backup', async (req, res) => {
    let tempRoot;
    const client = createClientAbortTracker(req, res);
    try {
      await runBackupTransfer(async () => {
        client.assertAlive();
        tempRoot = await createTransferRoot('export');
        const backupPath = join(tempRoot, 'backup.novelbox.json');
        const { bookId } = await writeBackupFile(req.params.id, backupPath, {
          signal: client.signal,
        });
        await client.assertAliveAfterIo();
        setBackupDownloadHeaders(res);
        await downloadFile(res, backupPath, `${bookId}.novelbox.json`);
      });
    } catch (e) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy(e);
        return;
      }
      sendJsonError(res, e);
    } finally {
      client.dispose();
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
  app.post('/api/backups/import', async (req, res) => {
    let tempRoot;
    const client = createClientAbortTracker(req, res);
    try {
      client.assertAlive();
      // 先验证小型关联标识，再接收最多 100 MB 的请求体，避免非法请求占用
      // 上传槽和临时磁盘。缺失时仍兼容旧客户端，由存储层生成随机 ID。
      const requestedBookId = requestedBookIdHeader(req);
      const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/octet-stream') throw new Error('BACKUP_INVALID');
      // 慢客户端只占“接收上传”名额；完整文件落盘后才进入与导出共享的
      // CPU/磁盘处理槽，避免两个半开上传让正常导出持续收到繁忙错误。
      await runBackupUpload(async () => {
        tempRoot = await createTransferRoot('upload');
        const uploadPath = join(tempRoot, 'upload.novelbox.json');
        await writeRequestBodyToFile(req, uploadPath);
      });
      client.assertAlive();
      await runBackupTransfer(async () => {
        const uploadPath = join(tempRoot, 'upload.novelbox.json');
        const imported = await importBackupFile(uploadPath, {
          signal: client.signal,
          requestedBookId,
        });
        if (!res.destroyed && !res.writableEnded) {
          await sendJsonResponse(res, imported, { signal: client.signal });
        }
      });
    } catch (e) {
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.destroy(e);
        else sendJsonError(res, e);
      }
    } finally {
      client.dispose();
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
  app.get('/api/storage/diagnostics', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const deep = req.query.deep === '1' || req.query.deep === 'true';
      const diagnostics = await runStorageDiagnostics({ deep, signal: client.signal });
      await client.assertAliveAfterIo();
      await sendJsonResponse(res, diagnostics, { signal: client.signal });
    }
    catch (e) {
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.destroy(e);
        else sendJsonError(res, e);
      }
    } finally {
      client.dispose();
    }
  });
  app.get('/api/trash/books', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const books = await listTrashBooks({ signal: client.signal });
      await client.assertAliveAfterIo();
      await sendJsonResponse(res, books, { signal: client.signal });
    } catch (e) {
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.destroy(e);
        else sendJsonError(res, e);
      }
    } finally {
      client.dispose();
    }
  });
  app.post('/api/trash/books/:trashId/restore', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const book = await restoreTrashBook(req.params.trashId, { signal: client.signal });
      await client.assertAliveAfterIo();
      await sendJsonResponse(res, book, { signal: client.signal });
    } catch (e) {
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.destroy(e);
        else sendJsonError(res, e);
      }
    } finally {
      client.dispose();
    }
  });
}
