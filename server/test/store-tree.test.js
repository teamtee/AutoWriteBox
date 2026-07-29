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
  const s = await store.addSection(bookId, { title: '第一部' });
  assert.equal(s.index, 1);
  assert.match(s.id, /^section-01$/);
  const book = await store.readBook(bookId);
  assert.deepEqual(book.sections, ['section-01']);
});

test('addChapter 追加进 section.chapters', async () => {
  const s = await store.addSection(bookId, { title: '第一部' });
  const c = await store.addChapter(bookId, s.id, { title: '第一章' });
  assert.equal(c.index, 1);
  assert.equal(c.status, 'done');
  const sec = await store.readSection(bookId, s.id);
  assert.deepEqual(sec.chapters, ['chapter-01']);
});

test('pushHistory 与 rollback 正文', () => {
  const ch = { content: '旧版', history: [] };
  ch.content = '新版';
  store.pushHistory(ch, 'content');  // 压入当前 content 之前应先取旧值——见实现约定
  assert.equal(ch.history.length, 1);
  const ok = store.rollback(ch, 'content');
  assert.equal(ok, true);
  const empty = store.rollback({ content: 'x', history: [] }, 'content');
  assert.equal(empty, false);
});
