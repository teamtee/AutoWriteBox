const MAX_READ_CHUNK_BYTES = 64 * 1024;

// 从已经验证过的文件句柄读取至多 maxBytes。额外读取 1 字节用于发现
// stat 之后发生的原地增长，避免随后使用 FileHandle.readFile() 无界读入。
// 返回 null 表示文件超过上限；句柄的生命周期仍由调用方管理。
export async function readFileHandleBounded(handle, maxBytes) {
  if (!handle || typeof handle.read !== 'function'
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0
    || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('BAD_BOUNDED_READ_ARGUMENT');
  }

  const readLimit = maxBytes + 1;
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes < readLimit) {
    const bytesToRead = Math.min(MAX_READ_CHUNK_BYTES, readLimit - totalBytes);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, null);
    if (!bytesRead) break;
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) return null;
    chunks.push(buffer.subarray(0, bytesRead));
  }

  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0];
  return Buffer.concat(chunks, totalBytes);
}
