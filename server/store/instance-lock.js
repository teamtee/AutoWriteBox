import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readFileHandleBounded } from '../bounded-io.js';
import { parseStoredJsonBytes } from './io.js';

const INSTANCE_LOCK_FORMAT = 'auto-novel-box-instance-lock';
const INSTANCE_LOCK_FILE = '.instance-lock.json';
const MAX_INSTANCE_LOCK_BYTES = 4096;
const PROCESS_START_IDENTITY_TOLERANCE_MS = 5_000;
const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 2_000;
const MAX_CLEANUP_PROCESS_IDENTITY_PROBES = 64;
const MAX_CLEANUP_PROCESS_IDENTITY_ELAPSED_MS = 1_000;
export const PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;
export const PROCESS_STARTED_AT = new Date(PROCESS_STARTED_AT_MS).toISOString();

const isObjectRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function createInstanceLockStore({ getDataRoot, ensureDirectory, syncDirectory }) {
  if (typeof getDataRoot !== 'function'
    || typeof ensureDirectory !== 'function'
    || typeof syncDirectory !== 'function') {
    throw new TypeError('INSTANCE_LOCK_DEPENDENCY_REQUIRED');
  }

  const instanceOwnerIsAlive = async (owner, {
    requestingPid,
    requestingProcessStartedAt,
    requestingProcessStartedAtMs,
    processAlive,
    processStartedAtForPid,
  }) => {
    if (owner.pid === requestingPid) {
      if (owner.processStartedAt !== undefined) {
        if (owner.processStartedAt !== requestingProcessStartedAt) return false;
      } else if (Date.parse(owner.startedAt) < requestingProcessStartedAtMs) {
        return false;
      }
    }
    return processOwnerIsAlive(owner, { processAlive, processStartedAtForPid });
  };

  const inspectInstanceLock = async (absPath) => {
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
  };

  const instanceLockError = (code, owner) => {
    const error = new Error(code);
    if (owner) error.owner = owner;
    return error;
  };

  const moveAsideStaleInstanceLock = async (lockPath, expectedOwner, ownerIsAlive) => {
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
      await syncDirectory(getDataRoot(), { afterCommit: true });
      return true;
    }

    try {
      await rename(quarantine, lockPath);
      await syncDirectory(getDataRoot(), { afterCommit: true });
    } catch (error) {
      if (!['EEXIST', 'ENOENT'].includes(error?.code)) throw error;
    }
    return false;
  };

  const releaseDataRootLease = async (lockPath, token) => {
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
      await syncDirectory(getDataRoot(), { afterCommit: true });
      return true;
    }
    try { await rename(quarantine, lockPath); }
    catch (error) { if (!['EEXIST', 'ENOENT'].includes(error?.code)) throw error; }
    return false;
  };

  const acquireDataRootLease = async ({
    pid = process.pid,
    host = '127.0.0.1',
    port = 4399,
    processAlive = isProcessAlive,
    processStartedAtForPid: processStartedAtResolver,
    createToken = () => randomUUID(),
    nowMs = Date.now(),
    processStartedAtMs = PROCESS_STARTED_AT_MS,
    settleMs = 25,
  } = {}) => {
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

    await ensureDirectory(getDataRoot());
    const lockPath = join(getDataRoot(), INSTANCE_LOCK_FILE);
    const resolveProcessStartedAt = processStartedAtResolver
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
        await rm(lockPath, { force: true }).catch(() => {});
        await syncDirectory(getDataRoot(), { afterCommit: true }).catch(() => {});
        throw error;
      } finally {
        await handle?.close().catch(() => {});
      }
      await syncDirectory(getDataRoot(), { afterCommit: true });
      if (settleMs > 0) {
        await new Promise((resolveWait) => setTimeout(resolveWait, settleMs));
      }
      const settled = await inspectInstanceLock(lockPath);
      if (settled.status !== 'ok' || settled.owner.token !== token) {
        throw instanceLockError('INSTANCE_LOCK_BUSY', settled.owner);
      }
      let released = false;
      return Object.freeze({
        owner,
        path: lockPath,
        async release() {
          if (released) return false;
          released = true;
          return releaseDataRootLease(lockPath, token);
        },
      });
    }
    throw instanceLockError('INSTANCE_LOCK_BUSY');
  };

  return Object.freeze({ acquireDataRootLease });
}
