import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../index.js';

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
