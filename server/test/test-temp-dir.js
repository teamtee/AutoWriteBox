import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const trackedRoots = new Set();

export function makeTestTempDir(prefix = 'novelbox-test-') {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9_-]+-$/.test(prefix)) {
    throw new TypeError('测试临时目录前缀必须是安全且以连字符结尾的名称');
  }
  const root = mkdtempSync(join(tmpdir(), prefix));
  trackedRoots.add(root);
  return root;
}

export async function cleanupTestTempDirs() {
  const roots = [...trackedRoots];
  const results = await Promise.allSettled(
    roots.map(async (root) => {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
      trackedRoots.delete(root);
    }),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}
