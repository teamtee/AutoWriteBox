import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../store.js';

beforeEach(() => {
  store.setDataRoot(mkdtempSync(join(tmpdir(), 'novelbox-')));
});

test('createBook 建书并可读回', async () => {
  const book = await store.createBook({ premise: '写一个赛博朋克侦探故事', title: '测试书' });
  assert.match(book.id, /^book_/);
  assert.equal(book.premise, '写一个赛博朋克侦探故事');
  assert.deepEqual(book.sections, []);
  assert.deepEqual(book.outline, { content: '', history: [] });
  const back = await store.readBook(book.id);
  assert.equal(back.title, '测试书');
});

test('writeBook 更新 updatedAt', async () => {
  const book = await store.createBook({ premise: 'p', title: 't' });
  book.title = '改名';
  await store.writeBook(book.id, book);
  const back = await store.readBook(book.id);
  assert.equal(back.title, '改名');
});

test('listBooks 返回摘要', async () => {
  await store.createBook({ premise: 'p1', title: 'A' });
  await store.createBook({ premise: 'p2', title: 'B' });
  const list = await store.listBooks();
  assert.equal(list.length, 2);
  assert.ok(list.every((b) => b.id && b.title && b.updatedAt));
});

test('readBook 不存在时抛错', async () => {
  await assert.rejects(() => store.readBook('book_nope'), /BOOK_NOT_FOUND/);
});
