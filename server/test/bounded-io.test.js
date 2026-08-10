import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileHandleBounded } from '../bounded-io.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

afterEach(cleanupTestTempDirs);

async function readBounded(path, maxBytes) {
  const handle = await open(path, 'r');
  try {
    return await readFileHandleBounded(handle, maxBytes);
  } finally {
    await handle.close();
  }
}

test('有界句柄读取接受上限内和恰好达到上限的文件', async () => {
  const root = makeTestTempDir('novelbox-bounded-read-');
  const path = join(root, 'owner.json');
  await writeFile(path, '12345678');

  assert.equal((await readBounded(path, 8)).toString('utf8'), '12345678');
  assert.equal((await readBounded(path, 9)).toString('utf8'), '12345678');
});

test('文件在 stat 后原地增长也只读取上限加一字节并判为超限', async () => {
  const root = makeTestTempDir('novelbox-bounded-growth-');
  const path = join(root, 'owner.json');
  await writeFile(path, '{}');
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    assert.equal(metadata.size, 2);
    await appendFile(path, 'x'.repeat(1024 * 1024));

    const allocations = [];
    const originalAllocUnsafe = Buffer.allocUnsafe;
    Buffer.allocUnsafe = function trackedAllocUnsafe(size) {
      allocations.push(size);
      return originalAllocUnsafe(size);
    };
    try {
      assert.equal(await readFileHandleBounded(handle, 4096), null);
    } finally {
      Buffer.allocUnsafe = originalAllocUnsafe;
    }
    assert.deepEqual(allocations, [4097]);
  } finally {
    await handle.close();
  }
});

test('有界句柄读取拒绝非法上限', async () => {
  await assert.rejects(
    () => readFileHandleBounded({ read() {} }, -1),
    /BAD_BOUNDED_READ_ARGUMENT/,
  );
});
