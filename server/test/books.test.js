import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
const put = (p, b) => fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

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

test('手动编辑正文入 history，回退可还原', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const c = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, {}));
    await put(`/api/books/${book.id}/sections/${s.id}/chapters/${c.id}`, { content: '第一版' });
    await put(`/api/books/${book.id}/sections/${s.id}/chapters/${c.id}`, { content: '第二版' });
    const ch2 = await store.readChapter(book.id, s.id, c.id);
    assert.equal(ch2.content, '第二版');
    assert.deepEqual(ch2.history, ['', '第一版']);  // 初始空串 + 第一版
    const rb = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters/${c.id}/rollback`));
    assert.equal(rb.ok, true);
    const ch3 = await store.readChapter(book.id, s.id, c.id);
    assert.equal(ch3.content, '第一版');
  });
});
