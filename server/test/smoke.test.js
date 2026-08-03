import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../index.js';

const execFileAsync = promisify(execFile);

test('createApp 提供健康检查端点', async () => {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await res.json();
  server.close();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true });
});

test('index.js 可在无 argv[1] 的动态导入场景中作为模块导入', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '-e',
    "import('./server/index.js').then(() => console.log('ok'))",
  ]);
  assert.match(stdout, /ok/);
});
