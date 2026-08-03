import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../store.js';

let bookId;
beforeEach(async () => {
  store.setDataRoot(mkdtempSync(join(tmpdir(), 'novelbox-')));
  const b = await store.createBook({ premise: 'p', title: 't' });
  bookId = b.id;
});

test('addSection 追加进 book.sections', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  assert.equal(s.index, 1);
  assert.equal(s.title, '起源');
  assert.equal(s.titleSource, 'manual');
  assert.match(s.id, /^section-01$/);
  const book = await store.readBook(bookId);
  assert.deepEqual(book.sections, ['section-01']);
});

test('并发 addSection 仍生成连续且不重复的部 id', async () => {
  const sections = await Promise.all([
    store.addSection(bookId, { title: '一' }),
    store.addSection(bookId, { title: '二' }),
    store.addSection(bookId, { title: '三' }),
    store.addSection(bookId, { title: '四' }),
    store.addSection(bookId, { title: '五' }),
  ]);

  assert.deepEqual(sections.map((s) => s.id), [
    'section-01',
    'section-02',
    'section-03',
    'section-04',
    'section-05',
  ]);
  const book = await store.readBook(bookId);
  assert.deepEqual(book.sections, [
    'section-01',
    'section-02',
    'section-03',
    'section-04',
    'section-05',
  ]);
});

test('addChapter 追加进 section.chapters，序号递增', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  const c1 = await store.addChapter(bookId, s.id, { title: '初见' });
  const c2 = await store.addChapter(bookId, s.id, {});
  assert.equal(c1.index, 1);
  assert.equal(c1.status, 'done');
  assert.equal(c1.title, '初见');
  assert.equal(c1.titleSource, 'manual');
  assert.match(c1.id, /^chapter-01$/);
  assert.equal(c2.title, '');
  assert.equal(c2.titleSource, 'default');
  assert.match(c2.id, /^chapter-02$/);  // 序号递增且两位格式
  const sec = await store.readSection(bookId, s.id);
  assert.deepEqual(sec.chapters, ['chapter-01', 'chapter-02']);
});

test('并发 addChapter 仍生成连续且不重复的章 id', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  const chapters = await Promise.all([
    store.addChapter(bookId, s.id, { title: '一' }),
    store.addChapter(bookId, s.id, { title: '二' }),
    store.addChapter(bookId, s.id, { title: '三' }),
    store.addChapter(bookId, s.id, { title: '四' }),
    store.addChapter(bookId, s.id, { title: '五' }),
  ]);

  assert.deepEqual(chapters.map((c) => c.id), [
    'chapter-01',
    'chapter-02',
    'chapter-03',
    'chapter-04',
    'chapter-05',
  ]);
  const sec = await store.readSection(bookId, s.id);
  assert.deepEqual(sec.chapters, [
    'chapter-01',
    'chapter-02',
    'chapter-03',
    'chapter-04',
    'chapter-05',
  ]);
});

test('pushHistory（覆盖前存档）与 rollback 还原正文', () => {
  const ch = { content: '第一版', history: [] };
  // 约定：先存档当前值，再改写
  store.pushHistory(ch, 'content');
  ch.content = '第二版';
  assert.deepEqual(ch.history, ['第一版']);
  const ok = store.rollback(ch, 'content');
  assert.equal(ok, true);
  assert.equal(ch.content, '第一版');  // 真正还原到存档值
  const empty = store.rollback({ content: 'x', history: [] }, 'content');
  assert.equal(empty, false);
});

test('pushHistory 处理非 content 字段（outline）并可回退', () => {
  const sec = { outline: { content: '大纲 A', history: [] } };
  store.pushHistory(sec, 'outline');
  sec.outline.content = '大纲 B';
  assert.deepEqual(sec.outline.history, ['大纲 A']);
  assert.equal(store.rollback(sec, 'outline'), true);
  assert.equal(sec.outline.content, '大纲 A');
});

test('history 栈深上限 20，超出丢弃最旧', () => {
  const ch = { content: '', history: [] };
  for (let i = 1; i <= 25; i++) { ch.content = `v${i}`; store.pushHistory(ch, 'content'); }
  assert.equal(ch.history.length, 20);      // 裁剪到 20
  assert.equal(ch.history[0], 'v6');        // v1..v5 被丢弃
  assert.equal(ch.history[19], 'v25');
});
