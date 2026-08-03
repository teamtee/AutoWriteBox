import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../store.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'novelbox-')); store.setDataRoot(root); });

test('createBook 用可版本化字段', async () => {
  const b = await store.createBook({ premise: 'p', title: 't' });
  assert.deepEqual(b.outline, { versions: [''], cursor: 0 });
  assert.deepEqual(b.settings.core.world, { versions: [''], cursor: 0 });
});

test('addChapter 带 body + 派生 content', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  assert.equal(s.title, '');
  assert.equal(s.titleSource, 'default');
  assert.equal(c.title, '');
  assert.equal(c.titleSource, 'default');
  assert.deepEqual(c.body, { versions: [''], cursor: 0 });
  assert.equal(c.content, '');
});

test('readBook 惰性迁移老书', async () => {
  // 手写一份老格式 book.json
  const id = 'book_old_0001';
  mkdirSync(join(root, 'books', id), { recursive: true });
  writeFileSync(join(root, 'books', id, 'book.json'), JSON.stringify({
    id, title: '老书', createdAt: 'x', updatedAt: 'x', premise: 'p',
    outline: { content: '大纲当前', history: ['大纲旧'] },
    settings: { core: { world: '世界观字符串', style: '', constraints: '', pacing: '' }, history: [] },
    characters: [], summary: '', progress: '', sections: [],
  }), 'utf8');
  const b = await store.readBook(id);
  assert.deepEqual(b.outline, { versions: ['大纲旧', '大纲当前'], cursor: 1 });
  assert.deepEqual(b.settings.core.world, { versions: ['世界观字符串'], cursor: 0 });
});

test('readChapter 惰性迁移 + 派生 content', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  // 手写老格式章节
  const cid = 'chapter-01';
  writeFileSync(join(root, 'books', b.id, s.id, `${cid}.json`), JSON.stringify({
    id: cid, index: 1, title: '初见', content: '正文当前', history: ['正文旧'],
    characters: [], summary: '', progress: '', status: 'done',
  }), 'utf8');
  const sec = await store.readSection(b.id, s.id); sec.chapters.push(cid); await store.writeSection(b.id, s.id, sec);
  const ch = await store.readChapter(b.id, s.id, cid);
  assert.equal(ch.title, '初见');
  assert.equal(ch.titleSource, 'manual');
  assert.deepEqual(ch.body, { versions: ['正文旧', '正文当前'], cursor: 1 });
  assert.equal(ch.content, '正文当前');
});

test('listBooks 带部/章计数', async () => {
  const b = await store.createBook({ premise: 'p', title: 'A' });
  const s = await store.addSection(b.id, {});
  await store.addChapter(b.id, s.id, {});
  await store.addChapter(b.id, s.id, {});
  const list = await store.listBooks();
  const row = list.find((x) => x.id === b.id);
  assert.equal(row.sectionCount, 1);
  assert.equal(row.chapterCount, 2);
});

test('deleteBook / renameBook', async () => {
  const b = await store.createBook({ premise: 'p', title: 'A' });
  await store.renameBook(b.id, 'B');
  assert.equal((await store.readBook(b.id)).title, 'B');
  await store.deleteBook(b.id);
  await assert.rejects(() => store.readBook(b.id), /BOOK_NOT_FOUND/);
});

test('versionSet + versionMove 往返（outline）', async () => {
  const b = await store.createBook({ premise: 'p' });
  await store.versionSet(b.id, 'outline', '第一版');
  await store.versionSet(b.id, 'outline', '第二版');
  let vf = await store.versionMove(b.id, 'outline', -1);
  assert.equal(store.currentText(vf), '第一版');
  const b2 = await store.readBook(b.id);
  assert.equal(store.currentText(b2.outline), '第一版');
});

test('versionSet 章节同步派生 content', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  await store.versionSet(b.id, path, '章节正文A');
  const ch = await store.readChapter(b.id, s.id, c.id);
  assert.equal(store.currentText(ch.body), '章节正文A');
  assert.equal(ch.content, '章节正文A');
});

test('章节写入会更新书架 updatedAt', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const before = (await store.readBook(b.id)).updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));

  await store.addChapter(b.id, s.id, {});

  const after = (await store.readBook(b.id)).updatedAt;
  assert.ok(Date.parse(after) > Date.parse(before));
});
