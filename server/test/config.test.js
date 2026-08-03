import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../store.js';
import { createApp } from '../index.js';

let base;
beforeEach(() => {
  store.setDataRoot(mkdtempSync(join(tmpdir(), 'novelbox-')));
});
async function withServer(fn) {
  const server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(); } finally { server.close(); }
}

test('POST 保存后 GET 返回掩码 Key', async () => {
  await withServer(async () => {
    const post = await fetch(`${base}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-secret', chapterWordTarget: 1500 }),
    });
    const saved = await post.json();
    assert.equal(saved.apiKey, 'sk-****');
    assert.equal(saved.chapterWordTarget, 1500);
    const get = await (await fetch(`${base}/api/config`)).json();
    assert.equal(get.baseUrl, 'https://x/v1');
    assert.equal(get.apiKey, 'sk-****');
  });
});

test('掩码 Key 再次保存不覆盖真实 Key', async () => {
  await withServer(async () => {
    await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'sk-real' }) });
    await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm2', apiKey: 'sk-****' }) });
    const real = await store.readConfig();
    assert.equal(real.apiKey, 'sk-real');
    assert.equal(real.model, 'm2');
  });
});

test('并发掩码保存不覆盖同时写入的新 API Key', async () => {
  await store.writeConfig({ apiKey: 'sk-old' });

  await Promise.all([
    store.writeConfig({ apiKey: 'sk-new' }),
    ...Array.from({ length: 50 }, (_, i) =>
      store.writeConfig({ model: `m${i}`, apiKey: 'sk-****' })),
  ]);

  const real = await store.readConfig();
  assert.equal(real.apiKey, 'sk-new');
});

test('保存空 API Key 会清除旧 Key', async () => {
  await withServer(async () => {
    await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'sk-real' }) });
    const cleared = await (await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: '' }),
    })).json();
    assert.equal(cleared.apiKey, '');

    const real = await store.readConfig();
    assert.equal(real.apiKey, '');
  });
});

test('配置保存失败返回 JSON 错误，不挂住请求', async () => {
  const rootFile = join(mkdtempSync(join(tmpdir(), 'novelbox-config-')), 'not-a-dir');
  writeFileSync(rootFile, 'x');
  store.setDataRoot(rootFile);
  await withServer(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm' }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /EEXIST|ENOTDIR/);
  });
});
