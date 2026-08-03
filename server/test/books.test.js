import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../store.js';
import { createApp } from '../index.js';

let base;
beforeEach(() => { store.setDataRoot(mkdtempSync(join(tmpdir(), 'novelbox-'))); });
async function withServer(fn) {
  const server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(); } finally { server.close(); }
}
const j = (r) => r.json();
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

test('建书→加部→加章→读全树', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: '书' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, { title: '第一部' }));
    await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, { title: '第一章' }));
    const tree = await j(await fetch(`${base}/api/books/${book.id}/tree`));
    assert.equal(tree.book.id, book.id);
    assert.equal(tree.sections.length, 1);
    assert.equal(tree.sections[0].chapters.length, 1);
  });
});

test('版本 save 入链，move 双向浏览', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const c = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, {}));
    const path = `section:${s.id}:chapter:${c.id}`;
    await post(`/api/books/${book.id}/version/save`, { path, text: '第一版' });
    let vf = await j(await post(`/api/books/${book.id}/version/save`, { path, text: '第二版' }));
    assert.equal(vf.versions[vf.cursor], '第二版');
    vf = await j(await post(`/api/books/${book.id}/version/move`, { path, delta: -1 }));
    assert.equal(vf.versions[vf.cursor], '第一版');       // 回退
    vf = await j(await post(`/api/books/${book.id}/version/move`, { path, delta: 1 }));
    assert.equal(vf.versions[vf.cursor], '第二版');       // 再前进
  });
});

test('version/clear 清空为新版，可 move 回', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const path = 'outline';
    await post(`/api/books/${book.id}/version/save`, { path, text: '有内容' });
    let vf = await j(await post(`/api/books/${book.id}/version/clear`, { path }));
    assert.equal(vf.versions[vf.cursor], '');
    vf = await j(await post(`/api/books/${book.id}/version/move`, { path, delta: -1 }));
    assert.equal(vf.versions[vf.cursor], '有内容');
  });
});

test('非法 path 返回 400', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const r = await post(`/api/books/${book.id}/version/move`, { path: 'core:evil', delta: 1 });
    assert.equal(r.status, 400);
  });
});

test('DELETE 删书 / PATCH 改名', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: 'A' }));
    const patched = await j(await fetch(`${base}/api/books/${book.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'B' }),
    }));
    assert.equal(patched.title, 'B');
    const del = await j(await fetch(`${base}/api/books/${book.id}`, { method: 'DELETE' }));
    assert.equal(del.ok, true);
    const list = await j(await fetch(`${base}/api/books`));
    assert.equal(list.find((x) => x.id === book.id), undefined);
  });
});

test('给不存在的书加部返回 JSON 错误，不退出服务', async () => {
  await withServer(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(`${base}/api/books/missing/sections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    assert.equal(r.status, 400);
    const body = await j(r);
    assert.match(body.error, /BOOK_NOT_FOUND/);

    const health = await j(await fetch(`${base}/api/health`));
    assert.equal(health.ok, true);
  });
});

test('书架列表读取失败返回 JSON 错误，不挂住请求', async () => {
  const fileRoot = join(tmpdir(), `novelbox-file-${process.pid}-${Date.now()}`);
  writeFileSync(fileRoot, 'not a directory', 'utf8');
  store.setDataRoot(fileRoot);

  await withServer(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(`${base}/api/books`, { signal: ctrl.signal });
    clearTimeout(timer);

    assert.equal(r.status, 400);
    const body = await j(r);
    assert.match(body.error, /ENOTDIR/);

    const health = await j(await fetch(`${base}/api/health`));
    assert.equal(health.ok, true);
  });
});

test('建书写入失败返回 JSON 错误，不挂住请求', async () => {
  const fileRoot = join(tmpdir(), `novelbox-file-${process.pid}-${Date.now()}-create`);
  writeFileSync(fileRoot, 'not a directory', 'utf8');
  store.setDataRoot(fileRoot);

  await withServer(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(`${base}/api/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ premise: 'p' }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    assert.equal(r.status, 400);
    const body = await j(r);
    assert.match(body.error, /ENOTDIR/);

    const health = await j(await fetch(`${base}/api/health`));
    assert.equal(health.ok, true);
  });
});
