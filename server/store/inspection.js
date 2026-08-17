import { lstat } from 'node:fs/promises';

export function createStorageInspector({
  readStoredJson,
  readStoredJsonProjection,
  throwIfAborted,
}) {
  if (typeof readStoredJson !== 'function'
    || typeof readStoredJsonProjection !== 'function'
    || typeof throwIfAborted !== 'function') {
    throw new TypeError('STORAGE_INSPECTOR_DEPENDENCY_REQUIRED');
  }

  const inspectJsonFile = async (absPath, { signal } = {}) => {
    try {
      return { status: 'ok', value: await readStoredJson(absPath, { mode: null, signal }) };
    } catch (error) {
      throwIfAborted(signal);
      if (error?.code === 'ENOENT') return { status: 'missing' };
      if (error instanceof SyntaxError) return { status: 'invalid' };
      if (error?.message === 'STORAGE_FILE_TOO_LARGE') return { status: 'too_large' };
      if (error?.message === 'STORAGE_PATH_UNSAFE') return { status: 'unsafe' };
      if (error?.message === 'STORAGE_PATH_INVALID') return { status: 'invalid_shape' };
      return { status: 'unreadable' };
    }
  };

  const inspectJsonProjection = async (absPath, specification, { signal } = {}) => {
    try {
      return {
        status: 'ok',
        value: await readStoredJsonProjection(
          absPath, specification, {
            mode: null, signal, projectionInvalidError: 'STORAGE_PROJECTED_DATA_INVALID',
          },
        ),
      };
    } catch (error) {
      throwIfAborted(signal);
      if (error?.code === 'ENOENT') return { status: 'missing' };
      if (error instanceof SyntaxError) return { status: 'invalid' };
      if (error?.message === 'STORAGE_PROJECTED_DATA_INVALID') {
        return { status: 'data_invalid' };
      }
      if (error?.message === 'STORAGE_FILE_TOO_LARGE') return { status: 'too_large' };
      if (error?.message === 'STORAGE_PATH_UNSAFE') return { status: 'unsafe' };
      if (error?.message === 'STORAGE_PATH_INVALID') return { status: 'invalid_shape' };
      return { status: 'unreadable' };
    }
  };

  const inspectFileEntry = async (absPath) => {
    try {
      const metadata = await lstat(absPath);
      return {
        status: metadata.isSymbolicLink()
          ? 'unsafe'
          : metadata.isFile() ? 'ok' : 'invalid_shape',
        ...(metadata.isFile() ? { size: metadata.size } : {}),
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'missing' };
      return { status: 'unreadable' };
    }
  };

  return Object.freeze({ inspectFileEntry, inspectJsonFile, inspectJsonProjection });
}
