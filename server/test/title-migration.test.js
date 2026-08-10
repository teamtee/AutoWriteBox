import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../store.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-title-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

test('新建书/部/章写入 default titleSource 和空的纯部章标题', async () => {
  const b = await store.createBook({ premise: '一个赛博侦探故事' });
  assert.equal(b.title, '一个赛博侦探故事');
  assert.equal(b.titleSource, 'default');

  const s = await store.addSection(b.id, {});
  assert.equal(s.title, '');
  assert.equal(s.titleSource, 'default');

  const c = await store.addChapter(b.id, s.id, {});
  assert.equal(c.title, '');
  assert.equal(c.titleSource, 'default');
});

test('显式书名视为 manual，AI 分部标题保留 ai', async () => {
  const b = await store.createBook({ premise: 'p', title: '用户书名' });
  assert.equal(b.titleSource, 'manual');
  const s = await store.addSection(b.id, { title: '暗潮初现', titleSource: 'ai' });
  assert.equal(s.title, '暗潮初现');
  assert.equal(s.titleSource, 'ai');
});

test('老书默认标题迁移为 default，自定义标题迁移为 manual', async () => {
  const id1 = 'book_default';
  const id2 = 'book_manual';
  for (const id of [id1, id2]) mkdirSync(join(root, 'books', id), { recursive: true });
  const base = {
    createdAt: 'x', updatedAt: 'x', outline: { content: '', history: [] },
    settings: { core: { world: '', style: '', constraints: '', pacing: '' }, history: [] },
    characters: [], summary: '', progress: '', sections: [],
  };
  writeFileSync(join(root, 'books', id1, 'book.json'),
    JSON.stringify({ ...base, id: id1, premise: '默认书名文本', title: '默认书名文本' }));
  writeFileSync(join(root, 'books', id2, 'book.json'),
    JSON.stringify({ ...base, id: id2, premise: '原始 premise', title: '用户命名' }));
  assert.equal((await store.readBook(id1)).titleSource, 'default');
  assert.equal((await store.readBook(id2)).titleSource, 'manual');
});

test('老部章标题剥离序号；纯默认序号清空', async () => {
  const b = await store.createBook({ premise: 'p' });
  const bookDir = join(root, 'books', b.id);
  mkdirSync(join(bookDir, 'section-01'), { recursive: true });
  writeFileSync(join(bookDir, 'section-01', 'section.json'), JSON.stringify({
    id: 'section-01', index: 1, title: '第一部 · 暗潮初现',
    outline: { content: '', history: [] }, characters: [], summary: '', progress: '',
    chapters: ['chapter-01', 'chapter-02'],
  }));
  writeFileSync(join(bookDir, 'section-01', 'chapter-01.json'), JSON.stringify({
    id: 'chapter-01', index: 1, title: '第 1 章', content: '', history: [],
    characters: [], summary: '', progress: '', status: 'done',
  }));
  writeFileSync(join(bookDir, 'section-01', 'chapter-02.json'), JSON.stringify({
    id: 'chapter-02', index: 2, title: '第二章：夜雨来客', content: '', history: [],
    characters: [], summary: '', progress: '', status: 'done',
  }));

  const s = await store.readSection(b.id, 'section-01');
  assert.equal(s.title, '暗潮初现');
  assert.equal(s.titleSource, 'manual');

  const c1 = await store.readChapter(b.id, 'section-01', 'chapter-01');
  assert.equal(c1.title, '');
  assert.equal(c1.titleSource, 'default');

  const c2 = await store.readChapter(b.id, 'section-01', 'chapter-02');
  assert.equal(c2.title, '夜雨来客');
  assert.equal(c2.titleSource, 'manual');
});

test('renameBook 标记 manual', async () => {
  const b = await store.createBook({ premise: 'p' });
  const renamed = await store.renameBook(b.id, '人工书名');
  assert.equal(renamed.title, '人工书名');
  assert.equal(renamed.titleSource, 'manual');
});

test('renameBook 空白标题不标记 manual 也不刷新 updatedAt', async () => {
  const b = await store.createBook({ premise: 'p' });
  const before = await store.readBook(b.id);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const renamed = await store.renameBook(b.id, '   ');

  assert.equal(renamed.title, before.title);
  assert.equal(renamed.titleSource, 'default');
  const after = await store.readBook(b.id);
  assert.equal(after.updatedAt, before.updatedAt);
});

test('AI 分部旧标题剥离剧情走向，只保留纯标题', async () => {
  const b = await store.createBook({ premise: 'p' });
  const bookDir = join(root, 'books', b.id);
  mkdirSync(join(bookDir, 'section-01'), { recursive: true });
  writeFileSync(join(bookDir, 'section-01', 'section.json'), JSON.stringify({
    id: 'section-01', index: 1,
    title: '深渊低语：林深在雨城获得第一条线索',
    titleSource: 'ai',
    outline: { content: '', history: [] }, characters: [], summary: '', progress: '',
    chapters: [],
  }));

  const s = await store.readSection(b.id, 'section-01');
  assert.equal(s.title, '深渊低语');
  assert.equal(s.titleSource, 'ai');
});
