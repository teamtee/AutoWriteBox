import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../store.js';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'novelbox-'));
  store.setDataRoot(root);
});

test('createBook 建书并可读回', async () => {
  const book = await store.createBook({ premise: '写一个赛博朋克侦探故事', title: '测试书' });
  assert.match(book.id, /^book_/);
  assert.equal(book.premise, '写一个赛博朋克侦探故事');
  assert.deepEqual(book.sections, []);
  assert.deepEqual(book.outline, { versions: [''], cursor: 0 });
  const back = await store.readBook(book.id);
  assert.equal(back.title, '测试书');
  assert.equal(back.titleSource, 'manual');
});

test('writeBook 更新 updatedAt', async () => {
  const book = await store.createBook({ premise: 'p', title: 't' });
  book.title = '改名';
  await store.writeBook(book.id, book);
  const back = await store.readBook(book.id);
  assert.equal(back.title, '改名');
});

test('atomicWriteJson 并发写同一路径不因临时文件撞名失败', async () => {
  const path = join(root, 'atomic.json');
  await Promise.all(Array.from({ length: 50 }, (_, i) =>
    store.atomicWriteJson(path, { i })));

  const back = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(typeof back.i, 'number');
});

test('listBooks 返回摘要', async () => {
  await store.createBook({ premise: 'p1', title: 'A' });
  await store.createBook({ premise: 'p2', title: 'B' });
  const list = await store.listBooks();
  assert.equal(list.length, 2);
  assert.ok(list.every((b) => b.id && b.title && b.updatedAt));
});

test('listBooks 按 updatedAt 倒序返回', async () => {
  const old = await store.createBook({ premise: 'old' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const recent = await store.createBook({ premise: 'recent' });
  const list = await store.listBooks();
  assert.deepEqual(list.map((b) => b.id), [recent.id, old.id]);
});

test('listBooks 跳过损坏的书目录，不影响正常书展示', async () => {
  const ok = await store.createBook({ premise: 'ok', title: '正常书' });
  const badDir = join(root, 'books', 'book_bad');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'book.json'), '{ bad json', 'utf8');

  const list = await store.listBooks();
  assert.deepEqual(list.map((b) => b.id), [ok.id]);
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
