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
  assert.deepEqual(book.outline, { versions: [''], cursor: 0 });
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

test('safeId 拦截路径遍历与非法 id', () => {
  assert.equal(store.safeId('book_20260729_abcd'), 'book_20260729_abcd');
  assert.equal(store.safeId('section-01'), 'section-01');
  assert.equal(store.safeId('chapter-12'), 'chapter-12');
  assert.throws(() => store.safeId('../evil'), /BAD_ID/);
  assert.throws(() => store.safeId('a/b'), /BAD_ID/);
  assert.throws(() => store.safeId(''), /BAD_ID/);
  assert.throws(() => store.safeId(null), /BAD_ID/);
});

test('readSection 遇到非法 sectionId 抛 BAD_ID', async () => {
  const book = await store.createBook({ premise: 'p', title: 't' });
  await assert.rejects(() => store.readSection(book.id, '../evil'), /BAD_ID/);
  await assert.rejects(() => store.readChapter(book.id, 'section-01', '../evil'), /BAD_ID/);
});
