import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

test('测试临时目录及其内容会被统一回收', async () => {
  const root = makeTestTempDir('novelbox-cleanup-test-');
  await writeFile(join(root, 'artifact.txt'), 'temporary', 'utf8');

  await cleanupTestTempDirs();

  await assert.rejects(() => access(root), { code: 'ENOENT' });
});
