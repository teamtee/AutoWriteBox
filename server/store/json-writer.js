import { stringifyJsonChunks } from '../json-stream.js';
import { throwIfAborted } from './abort.js';

const JSON_WRITE_BUFFER_BYTES = 256 * 1024;

export function createLimitedJsonWriter(
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

  return Object.freeze({
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
  });
}
