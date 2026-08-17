import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as store from '../store.js';
import {
  MAX_BOOK_OUTLINE_PROMPT_CHARS, MAX_CORE_PROMPT_FIELD_CHARS,
  MAX_SECTION_OUTLINE_PROMPT_CHARS, MAX_SECTION_PROMPT_SUMMARY_CHARS,
  MAX_STORAGE_ROOT_DIRECTORY_ENTRIES, MAX_STORED_CHARACTERS,
  MAX_VERSION_HISTORY_ITEMS, MAX_VERSION_TEXT_CHARS,
} from '../limits.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => { root = makeTestTempDir('novelbox-'); store.setDataRoot(root); });
afterEach(cleanupTestTempDirs);

async function deleteCurrentBook(id) {
  const book = await store.readBook(id);
  return store.deleteBook(id, { expectedUpdatedAt: book.updatedAt });
}

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

test('addSection 可原子保存 AI 分部结构大纲并校验边界', async () => {
  const b = await store.createBook({ premise: '分部结构' });
  const outline = [
    '【阶段承诺 Promise】揭示失踪案真相',
    '【本部目标】找到证人',
    '【主要阻力】幕后组织追杀',
    '【主线推进 Progress】锁定核心反派',
    '【阶段高潮】钟楼对决',
    '【阶段兑现 Payoff】救回证人',
    '【结束状态变化】主角身份暴露',
  ].join('\n');
  const section = await store.addSection(b.id, {
    title: '暗潮', titleSource: 'ai', outline,
  });
  assert.equal(section.outline.content, outline);
  assert.deepEqual(section.outline.history, []);
  assert.equal((await store.readSection(b.id, section.id)).outline.content, outline);

  await assert.rejects(
    () => store.addSection(b.id, { outline: { bad: true } }),
    /BAD_SECTION_OUTLINE/,
  );
  await assert.rejects(
    () => store.addSection(b.id, { outline: '长'.repeat(MAX_VERSION_TEXT_CHARS + 1) }),
    /TEXT_TOO_LARGE/,
  );
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
  assert.deepEqual(b.settings.serialization, { dailyWordGoal: 2000, platformConfirmations: [] });
  const deleted = await deleteCurrentBook(id);
  const restored = await store.restoreDeletedBook(deleted.trashId);
  assert.deepEqual(restored.outline, { versions: ['大纲旧', '大纲当前'], cursor: 1 });
  assert.deepEqual(restored.settings.core.world, { versions: ['世界观字符串'], cursor: 0 });
  assert.deepEqual(restored.settings.serialization, {
    dailyWordGoal: 2000, platformConfirmations: [],
  });
});

test('历史已满的合法老书迁移后仍可读取结构、改名和恢复', async () => {
  const id = 'book_old_full_history';
  const history = Array.from({ length: 20 }, (_, index) => `旧大纲-${index}`);
  mkdirSync(join(root, 'books', id), { recursive: true });
  writeFileSync(join(root, 'books', id, 'book.json'), JSON.stringify({
    id, title: '历史已满老书', titleSource: 'manual',
    createdAt: 'x', updatedAt: new Date().toISOString(), premise: 'p',
    outline: { content: '当前大纲', history },
    settings: { core: {
      world: '', style: '', constraints: '', pacing: '',
    }, history: [] },
    characters: [], summary: '', progress: '', sections: [],
  }), 'utf8');

  const migrated = await store.readBook(id);
  assert.deepEqual(migrated.outline, {
    versions: [...history.slice(1), '当前大纲'], cursor: 19,
  });
  assert.doesNotThrow(() => store.versionRevision(migrated.outline));
  assert.equal((await store.readBookStructure(id)).book.id, id);

  await store.renameBook(id, '迁移后改名', { expectedTitle: '历史已满老书' });
  const persisted = await store.readBook(id);
  assert.equal(persisted.outline.versions.length, 20);
  assert.equal(store.currentText(persisted.outline), '当前大纲');

  const deleted = await deleteCurrentBook(id);
  const restored = await store.restoreDeletedBook(deleted.trashId);
  assert.equal(restored.outline.versions.length, 20);
  assert.equal(store.currentText(restored.outline), '当前大纲');
});

test('早期迁移器已写出的 21 版章节会在读取时修复', async () => {
  const b = await store.createBook({ premise: '章节迁移' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const history = Array.from({ length: 20 }, (_, index) => `旧正文-${index}`);
  writeFileSync(join(root, 'books', b.id, s.id, `${c.id}.json`), JSON.stringify({
    ...c,
    body: { versions: [...history, '当前正文'], cursor: 20 },
    content: '当前正文',
  }), 'utf8');

  const migrated = await store.readChapter(b.id, s.id, c.id);
  assert.deepEqual(migrated.body, {
    versions: [...history.slice(1), '当前正文'], cursor: 19,
  });
  assert.doesNotThrow(() => store.versionRevision(migrated.body));
  assert.equal(store.currentText(migrated.body), '当前正文');
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
  const sec = await store.readSection(b.id, s.id);
  sec.chapters.push(cid);
  await store.writeSection(b.id, s.id, sec, { preserveExistingChapters: false });
  const ch = await store.readChapter(b.id, s.id, cid);
  assert.equal(ch.title, '初见');
  assert.equal(ch.titleSource, 'manual');
  assert.deepEqual(ch.body, { versions: ['正文旧', '正文当前'], cursor: 1 });
  assert.equal(ch.content, '正文当前');
  const deleted = await deleteCurrentBook(b.id);
  await store.restoreDeletedBook(deleted.trashId);
  const restored = await store.readChapter(b.id, s.id, cid);
  assert.deepEqual(restored.body, { versions: ['正文旧', '正文当前'], cursor: 1 });
  assert.equal(restored.content, '正文当前');
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

test('listBooks 等待作品提交锁且等待期间可取消，不暴露子文件中间态', async () => {
  const b = await store.createBook({ premise: '书架一致快照' });
  let releaseBookLock;
  let markBookLockHeld;
  const bookLockHeld = new Promise((resolve) => { markBookLockHeld = resolve; });
  const blocker = store.withStoreLock(`book:${b.id}:book-json`, async () => {
    markBookLockHeld();
    await new Promise((resolve) => { releaseBookLock = resolve; });
  });
  await bookLockHeld;

  const controller = new AbortController();
  let settled = false;
  const listing = store.listBooks({ signal: controller.signal })
    .finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  controller.abort(new Error('CLIENT_ABORTED'));
  let timer;
  try {
    await assert.rejects(Promise.race([
      listing,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('CANCEL_WAIT_TIMEOUT')), 1000);
      }),
    ]).finally(() => clearTimeout(timer)), /CLIENT_ABORTED/);
  } finally {
    releaseBookLock();
    await blocker;
  }
  assert.equal((await store.listBooks())[0].id, b.id);
});

test('作品更新时间锚点在同一毫秒内仍单调递增', async () => {
  const b = await store.createBook({ premise: '单调时间锚点', title: 'A' });
  const bookPath = join(root, 'books', b.id, 'book.json');
  const futureMs = Date.now() + 60_000;
  writeFileSync(bookPath, JSON.stringify({
    ...await store.readBook(b.id), updatedAt: new Date(futureMs).toISOString(),
  }), 'utf8');

  const renamed = await store.renameBook(b.id, 'B', { expectedTitle: 'A' });

  assert.equal(Date.parse(renamed.updatedAt), futureMs + 1);
});

test('子文件写入失败前也先推进删除锚点，旧书架不能删除可能已变化的作品', async () => {
  const b = await store.createBook({ premise: '子文件失败保护' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const chapter = await store.readChapter(b.id, s.id, c.id);
  const staleUpdatedAt = (await store.readBook(b.id)).updatedAt;
  const chapterPath = join(root, 'books', b.id, s.id, `${c.id}.json`);
  unlinkSync(chapterPath);
  mkdirSync(chapterPath);

  await assert.rejects(
    () => store.writeChapter(b.id, s.id, c.id, {
      ...chapter,
      body: { versions: ['', '不应写入'], cursor: 1 },
    }),
    /STORAGE_PATH_INVALID|EISDIR/,
  );

  const current = await store.readBook(b.id);
  assert.ok(Date.parse(current.updatedAt) > Date.parse(staleUpdatedAt));
  await assert.rejects(
    () => store.deleteBook(b.id, { expectedUpdatedAt: staleUpdatedAt }),
    /BOOK_DELETE_CONFLICT/,
  );
});

test('deleteBook 强制校验书架加载时的更新时间锚点', async () => {
  const b = await store.createBook({ premise: '旧书架不能删除新版', title: 'A' });
  await assert.rejects(() => store.deleteBook(b.id), /BAD_BOOK_DELETE_ANCHOR/);

  await store.renameBook(b.id, 'B', { expectedTitle: 'A' });
  await assert.rejects(
    () => store.deleteBook(b.id, { expectedUpdatedAt: b.updatedAt }),
    /BOOK_DELETE_CONFLICT/,
  );
  const current = await store.readBook(b.id);
  assert.equal(current.title, 'B');

  const deleted = await store.deleteBook(b.id, { expectedUpdatedAt: current.updatedAt });
  assert.equal(deleted.recoverable, true);
});

test('deleteBook 移入回收站并可恢复，renameBook 保持生效', async () => {
  const b = await store.createBook({ premise: 'p', title: 'A' });
  await store.renameBook(b.id, 'B');
  const beforeDelete = await store.readBook(b.id);
  assert.equal(beforeDelete.title, 'B');
  const deleted = await deleteCurrentBook(b.id);
  assert.equal(deleted.recoverable, true);
  await assert.rejects(() => store.readBook(b.id), /BOOK_NOT_FOUND/);
  const trash = await store.listDeletedBooks();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].bookId, b.id);
  assert.equal(trash[0].title, 'B');

  const restored = await store.restoreDeletedBook(deleted.trashId);
  assert.equal(restored.id, b.id);
  assert.equal(restored.title, 'B');
  assert.ok(Date.parse(restored.updatedAt) > Date.parse(beforeDelete.updatedAt));
  await assert.rejects(
    () => store.deleteBook(b.id, { expectedUpdatedAt: beforeDelete.updatedAt }),
    /BOOK_DELETE_CONFLICT/,
  );
  assert.equal((await store.listDeletedBooks()).length, 0);
});

test('回收站列表流式扫描大型主数据，恢复时仍完整校验', async () => {
  const created = await store.createBook({ premise: '大型回收站', title: '长篇副本' });
  const book = await store.readBook(created.id);
  const repeated = 'x'.repeat(Math.min(MAX_VERSION_TEXT_CHARS, 150_000));
  book.outline = {
    versions: Array.from({ length: MAX_VERSION_HISTORY_ITEMS }, () => repeated),
    cursor: MAX_VERSION_HISTORY_ITEMS - 1,
  };
  await store.writeBook(book.id, book);
  const committed = await store.readBook(book.id);
  const deleted = await deleteCurrentBook(book.id);
  const trashBookPath = join(root, 'trash', 'books', deleted.trashId, 'book.json');

  const originalJsonParse = JSON.parse;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.length > 64 * 1024) {
      throw new Error('FULL_JSON_PARSE_FORBIDDEN');
    }
    return originalJsonParse(text, ...args);
  };
  let rows;
  try {
    rows = await store.listDeletedBooks();
  } finally {
    JSON.parse = originalJsonParse;
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '长篇副本');
  assert.equal(rows[0].validationDeferred, true);
  assert.equal(rows[0].invalid, undefined);

  // 列表阶段未物化的字段若被人工损坏，真正恢复仍会
  // 在提交前完整拒绝，并保留唯一的回收站副本。
  writeFileSync(trashBookPath, JSON.stringify({ ...committed, premise: { invalid: true } }));
  assert.equal((await store.listDeletedBooks())[0].validationDeferred, true);
  await assert.rejects(
    () => store.restoreDeletedBook(deleted.trashId),
    /TRASH_BOOK_INVALID/,
  );
  assert.equal(existsSync(trashBookPath), true);
  await assert.rejects(() => store.readBook(book.id), /BOOK_NOT_FOUND/);
});

test('大型回收站作品恢复不深克隆刚解析的完整主数据', async () => {
  const created = await store.createBook({ premise: '大型恢复', title: '低峰值恢复' });
  const book = await store.readBook(created.id);
  const repeated = 'x'.repeat(Math.min(MAX_VERSION_TEXT_CHARS, 150_000));
  book.outline = {
    versions: Array.from({ length: MAX_VERSION_HISTORY_ITEMS }, () => repeated),
    cursor: MAX_VERSION_HISTORY_ITEMS - 1,
  };
  await store.writeBook(book.id, book);
  const deleted = await deleteCurrentBook(book.id);

  const originalStructuredClone = globalThis.structuredClone;
  globalThis.structuredClone = (value, ...args) => {
    if (value?.outline?.versions?.some?.((text) => text.length > 64 * 1024)) {
      throw new Error('LARGE_STORED_JSON_CLONE_FORBIDDEN');
    }
    return originalStructuredClone(value, ...args);
  };
  let restored;
  try {
    restored = await store.restoreDeletedBook(deleted.trashId);
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }

  assert.equal(restored.id, book.id);
  assert.equal(restored.outline.versions.length, MAX_VERSION_HISTORY_ITEMS);
  assert.equal((await store.listDeletedBooks()).length, 0);
});

test('新建、恢复和删除不会把活动书架或回收站推过可枚举容量', async () => {
  const restorable = await store.createBook({ premise: '待恢复作品' });
  const active = await store.createBook({ premise: '仍在书架的作品' });
  const deleted = await deleteCurrentBook(restorable.id);
  const booksRoot = join(root, 'books');
  const trashRoot = join(root, 'trash', 'books');

  // 活动作目录已有 active；补齐到扫描上限后，新建和恢复都必须在提交前停止。
  for (let index = 0; index < MAX_STORAGE_ROOT_DIRECTORY_ENTRIES - 1; index += 1) {
    writeFileSync(join(booksRoot, `placeholder-${index}`), '');
  }
  await assert.rejects(
    () => store.createBook({ premise: '不能让书架超限' }),
    /BOOK_LIBRARY_LIMIT/,
  );
  await assert.rejects(
    () => store.restoreDeletedBook(deleted.trashId),
    /BOOK_LIBRARY_LIMIT/,
  );
  assert.equal((await store.listBooks())[0].id, active.id);
  assert.equal((await store.listDeletedBooks())[0].trashId, deleted.trashId);

  // 回收站已有 restorable；补齐后删除必须保留活动作品，不能让随后列表 500。
  for (let index = 0; index < MAX_STORAGE_ROOT_DIRECTORY_ENTRIES - 1; index += 1) {
    writeFileSync(join(trashRoot, `placeholder-${index}`), '');
  }
  const activeBeforeDelete = await store.readBook(active.id);
  await assert.rejects(
    () => store.deleteBook(active.id, { expectedUpdatedAt: activeBeforeDelete.updatedAt }),
    /TRASH_BOOK_LIMIT/,
  );
  assert.equal((await store.readBook(active.id)).id, active.id);
  assert.equal((await store.listDeletedBooks())[0].trashId, deleted.trashId);
});

test('deleteBook 先清理残留结构事务，避免完整作品进入不可恢复的回收站状态', async () => {
  const b = await store.createBook({ premise: '事务残留删除保护', title: '可恢复作品' });
  const s = await store.addSection(b.id, { title: '自定义部' });
  const c = await store.addChapter(b.id, s.id, { title: '已提交章节' });
  await store.versionSet(
    b.id, `section:${s.id}:chapter:${c.id}`, '事务提交后继续保存的正文',
  );
  const transactionPath = join(
    root, 'books', b.id, s.id, '.section-structure-transaction.json',
  );
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-structure-transaction', version: 1, type: 'add-chapter',
    bookId: b.id, sectionId: s.id, chapterId: c.id, chapter: c,
  });
  const beforeRecovery = await store.readBook(b.id);

  await assert.rejects(
    () => store.deleteBook(b.id, { expectedUpdatedAt: beforeRecovery.updatedAt }),
    /STRUCTURE_TRANSACTION_RECOVERED/,
  );
  assert.equal(existsSync(transactionPath), false);
  assert.equal((await store.readBook(b.id)).id, b.id);

  const bookTransactionPath = join(
    root, 'books', b.id, '.book-structure-transaction.json',
  );
  await store.atomicWriteJson(bookTransactionPath, {
    format: 'auto-novel-box-structure-transaction', version: 1, type: 'add-section',
    bookId: b.id, sectionId: s.id, section: s,
  });
  const beforeBookRecovery = await store.readBook(b.id);
  await assert.rejects(
    () => store.deleteBook(b.id, { expectedUpdatedAt: beforeBookRecovery.updatedAt }),
    /STRUCTURE_TRANSACTION_RECOVERED/,
  );
  assert.equal(existsSync(bookTransactionPath), false);
  assert.equal((await store.readBook(b.id)).id, b.id);

  const deleted = await deleteCurrentBook(b.id);
  const restored = await store.restoreDeletedBook(deleted.trashId);
  assert.equal(restored.id, b.id);
  assert.equal(
    store.currentText((await store.readChapter(b.id, s.id, c.id)).body),
    '事务提交后继续保存的正文',
  );
});

test('restoreDeletedBook 不覆盖同 id 的现有书', async () => {
  const b = await store.createBook({ premise: '旧书', title: '旧书' });
  const deleted = await deleteCurrentBook(b.id);
  mkdirSync(join(root, 'books', b.id), { recursive: true });
  writeFileSync(join(root, 'books', b.id, 'book.json'), JSON.stringify({
    ...b, title: '占位新书', sections: [],
  }), 'utf8');

  await assert.rejects(() => store.restoreDeletedBook(deleted.trashId), /BOOK_ALREADY_EXISTS/);
  assert.equal((await store.readBook(b.id)).title, '占位新书');
  const trash = await store.listDeletedBooks();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].restoreBlockedByActiveBook, true);
});

test('restoreDeletedBook 通过规范化暂存清理未知字段并重建派生数据', async () => {
  const b = await store.createBook({ premise: '恢复边界', title: '原书' });
  const s = await store.addSection(b.id, { title: '第一部' });
  const c = await store.addChapter(b.id, s.id, { title: '第一章' });
  await store.versionSet(b.id, `section:${s.id}:chapter:${c.id}`, '可信正文');
  const book = await store.readBook(b.id);
  const section = await store.readSection(b.id, s.id);
  const chapter = await store.readChapter(b.id, s.id, c.id);
  const deleted = await deleteCurrentBook(b.id);
  const trashRoot = join(root, 'trash', 'books', deleted.trashId);

  writeFileSync(join(trashRoot, '.import-owner.json'), JSON.stringify({
    format: 'auto-novel-box-import-staging', pid: 1,
  }), 'utf8');
  writeFileSync(join(trashRoot, 'book.json'), JSON.stringify({
    ...book, injected: { secret: 'must-not-restore' },
    outline: { ...book.outline, injected: 'unknown' },
  }), 'utf8');
  writeFileSync(join(trashRoot, s.id, 'section.json'), JSON.stringify({
    ...section, index: 999, injected: { payload: 'unknown' },
  }), 'utf8');
  writeFileSync(join(trashRoot, s.id, `${c.id}.json`), JSON.stringify({
    ...chapter, index: 999, content: '伪造缓存', bodyFingerprint: '伪造指纹',
    injected: { payload: 'unknown' },
  }), 'utf8');

  const restored = await store.restoreDeletedBook(deleted.trashId);
  const restoredSection = await store.readSection(restored.id, s.id);
  const restoredChapter = await store.readChapter(restored.id, s.id, c.id);
  assert.equal(Object.hasOwn(restored, 'injected'), false);
  assert.equal(Object.hasOwn(restored.outline, 'injected'), false);
  assert.equal(Object.hasOwn(restoredSection, 'injected'), false);
  assert.equal(Object.hasOwn(restoredChapter, 'injected'), false);
  assert.equal(restoredSection.index, 1);
  assert.equal(restoredChapter.index, 1);
  assert.equal(restoredChapter.content, '可信正文');
  assert.equal(restoredChapter.bodyFingerprint, store.contentFingerprint('可信正文'));
  assert.equal(existsSync(join(root, 'books', b.id, '.import-owner.json')), false);
  assert.equal((await store.listDeletedBooks()).length, 0);
});

test('restoreDeletedBook 在回收站内容损坏时保留原副本且不污染活动书架', async () => {
  const b = await store.createBook({ premise: '损坏恢复' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const deleted = await deleteCurrentBook(b.id);
  const chapterPath = join(root, 'trash', 'books', deleted.trashId, s.id, `${c.id}.json`);
  writeFileSync(chapterPath, JSON.stringify({
    ...c, id: 'chapter-swapped', body: { versions: ['正文'], cursor: 0 },
  }), 'utf8');

  await assert.rejects(() => store.restoreDeletedBook(deleted.trashId), /TRASH_BOOK_INVALID/);
  await assert.rejects(() => store.readBook(b.id), /BOOK_NOT_FOUND/);
  assert.equal((await store.listDeletedBooks()).length, 1);
  assert.equal(existsSync(chapterPath), true);
  assert.deepEqual(
    existsSync(join(root, '.imports'))
      ? await readdir(join(root, '.imports'))
      : [],
    [],
  );
});

test('回收站主数据损坏时条目仍可见但标记为不可自动恢复', async () => {
  const b = await store.createBook({ premise: '不可隐形的数据' });
  const deleted = await deleteCurrentBook(b.id);
  const trashRoot = join(root, 'trash', 'books', deleted.trashId);
  writeFileSync(join(trashRoot, 'book.json'), '{ damaged json', 'utf8');

  const rows = await store.listDeletedBooks();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trashId, deleted.trashId);
  assert.equal(rows[0].bookId, b.id);
  assert.equal(rows[0].invalid, true);
  assert.equal(rows[0].issueCode, 'TRASH_BOOK_METADATA_INVALID');
  await assert.rejects(() => store.restoreDeletedBook(deleted.trashId), /TRASH_BOOK_INVALID/);
  assert.equal(existsSync(trashRoot), true);
});

test('名称异常的回收站目录仍可见但不会被自动读取或恢复', async () => {
  const unexpectedName = '人工改名的回收站副本';
  const unexpectedRoot = join(root, 'trash', 'books', unexpectedName);
  mkdirSync(unexpectedRoot, { recursive: true });
  writeFileSync(join(unexpectedRoot, 'book.json'), JSON.stringify({
    id: 'book_hidden', title: '不应静默隐藏', sections: [],
  }), 'utf8');

  const rows = await store.listDeletedBooks();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    trashId: unexpectedName,
    bookId: '',
    title: '',
    deletedAt: '',
    invalid: true,
    issueCode: 'TRASH_DIRECTORY_NAME_INVALID',
  });
  await assert.rejects(() => store.restoreDeletedBook(unexpectedName), /BAD_ID/);
  assert.equal(existsSync(join(unexpectedRoot, 'book.json')), true);
});

test('已取消的回收站列表和恢复不会继续读取或提交作品', async () => {
  const b = await store.createBook({ premise: '取消恢复', title: '仍在回收站' });
  const deleted = await deleteCurrentBook(b.id);
  const controller = new AbortController();
  controller.abort(new Error('CLIENT_ABORTED'));

  await assert.rejects(
    () => store.listDeletedBooks({ signal: controller.signal }),
    /CLIENT_ABORTED/,
  );
  await assert.rejects(
    () => store.restoreDeletedBook(deleted.trashId, { signal: controller.signal }),
    /CLIENT_ABORTED/,
  );
  await assert.rejects(() => store.readBook(b.id), /BOOK_NOT_FOUND/);
  assert.equal(existsSync(join(root, 'trash', 'books', deleted.trashId, 'book.json')), true);
});

test('恢复在暂存写入后取消会清理半成品并保留回收站源副本', async () => {
  const b = await store.createBook({ premise: '中途取消恢复', title: '不能半恢复' });
  const deleted = await deleteCurrentBook(b.id);
  let checks = 0;
  const signal = {
    get aborted() {
      checks += 1;
      // 第十个取消点位于恢复暂存所有者标记已经落盘之后、活动目录提交之前。
      return checks >= 10;
    },
    reason: new Error('CLIENT_ABORTED'),
  };

  await assert.rejects(
    () => store.restoreDeletedBook(deleted.trashId, { signal }),
    /CLIENT_ABORTED/,
  );
  assert.ok(checks >= 10);
  await assert.rejects(() => store.readBook(b.id), /BOOK_NOT_FOUND/);
  assert.equal(existsSync(join(root, 'trash', 'books', deleted.trashId, 'book.json')), true);
  assert.deepEqual(
    existsSync(join(root, '.imports')) ? await readdir(join(root, '.imports')) : [],
    [],
  );
});

test('超长合法作品 ID 删除后仍可通过独立回收站 ID 边界恢复', async () => {
  const id = 'b'.repeat(128);
  const now = new Date().toISOString();
  const versioned = { versions: [''], cursor: 0 };
  mkdirSync(join(root, 'books', id), { recursive: true });
  writeFileSync(join(root, 'books', id, 'book.json'), JSON.stringify({
    id, title: '长 ID 作品', titleSource: 'manual', createdAt: now, updatedAt: now,
    premise: 'p', outline: versioned,
    settings: { core: {
      world: versioned, style: versioned, constraints: versioned, pacing: versioned,
    }, history: [] },
    characters: [], summary: '', progress: '', sections: [],
  }), 'utf8');

  const deleted = await deleteCurrentBook(id);
  assert.ok(deleted.trashId.length > 128);
  assert.equal((await store.listDeletedBooks())[0].bookId, id);
  assert.equal((await store.restoreDeletedBook(deleted.trashId)).id, id);
});

test('deleteBook 与并发 addSection 时删除不被旧写入复活', async () => {
  const b = await store.createBook({ premise: 'p' });

  await Promise.allSettled([
    store.deleteBook(b.id, { expectedUpdatedAt: b.updatedAt }),
    ...Array.from({ length: 20 }, (_, i) =>
      store.addSection(b.id, { title: `第${i + 1}部` })),
  ]);

  await assert.rejects(() => store.readBook(b.id), /BOOK_NOT_FOUND/);
});

test('deleteBook 与并发 addChapter 后回收站副本保持结构完整', async () => {
  const b = await store.createBook({ premise: 'p' });
  const section = await store.addSection(b.id, {});
  const deleteAnchor = (await store.readBook(b.id)).updatedAt;

  const [deleted, added] = await Promise.allSettled([
    store.deleteBook(b.id, { expectedUpdatedAt: deleteAnchor }),
    store.addChapter(b.id, section.id, { title: '并发章' }),
  ]);

  assert.equal(deleted.status, 'fulfilled');
  await assert.rejects(() => store.readBook(b.id), /BOOK_NOT_FOUND/);
  const restored = await store.restoreDeletedBook(deleted.value.trashId);
  const restoredSection = await store.readReferencedSection(restored.id, section.id);
  assert.equal(restoredSection.chapters.length, added.status === 'fulfilled' ? 1 : 0);
  assert.equal(
    existsSync(join(root, 'books', b.id, section.id, '.section-structure-transaction.json')),
    false,
  );
  assert.equal((await store.diagnoseStorage()).ok, true);
});

test('版本修订号流式哈希与既有 JSON 字节合同完全一致', () => {
  const versioned = {
    versions: ['引号"与反斜杠\\', '控制\n字符', '\ud800中\udfff', '😀'.repeat(10_000)],
    cursor: 2,
  };
  assert.equal(
    store.versionRevision(versioned),
    store.contentFingerprint(JSON.stringify(versioned)),
  );
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

test('versionMove outline 到边界时不刷新 updatedAt', async () => {
  const b = await store.createBook({ premise: 'p' });
  const before = (await store.readBook(b.id)).updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));

  const vf = await store.versionMove(b.id, 'outline', -1);

  assert.deepEqual(vf, { versions: [''], cursor: 0 });
  const after = (await store.readBook(b.id)).updatedAt;
  assert.equal(after, before);
});

test('versionMove chapter 到边界时不刷新 updatedAt', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const before = (await store.readBook(b.id)).updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));

  const vf = await store.versionMove(b.id, `section:${s.id}:chapter:${c.id}`, -1);

  assert.deepEqual(vf, { versions: [''], cursor: 0 });
  const after = (await store.readBook(b.id)).updatedAt;
  assert.equal(after, before);
});

test('并发 versionSet outline 不丢失任何版本', async () => {
  const b = await store.createBook({ premise: 'p' });

  await Promise.all([
    store.versionSet(b.id, 'outline', '第一版'),
    store.versionSet(b.id, 'outline', '第二版'),
    store.versionSet(b.id, 'outline', '第三版'),
    store.versionSet(b.id, 'outline', '第四版'),
  ]);

  const back = await store.readBook(b.id);
  assert.deepEqual(back.outline.versions, ['', '第一版', '第二版', '第三版', '第四版']);
  assert.equal(back.outline.cursor, 4);
});

test('相同期望修订号的并发写入只有一个提交，陈旧章节操作同样被拒绝', async () => {
  const b = await store.createBook({ premise: 'p' });
  const outlineRevision = store.versionRevision((await store.readBook(b.id)).outline);

  const outlineWrites = await Promise.allSettled([
    store.versionSet(b.id, 'outline', '页面一', { expectedRevision: outlineRevision }),
    store.versionSet(b.id, 'outline', '页面二', { expectedRevision: outlineRevision }),
  ]);
  assert.equal(outlineWrites.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outlineWrites.filter((result) =>
    result.status === 'rejected' && /VERSION_CONFLICT/.test(result.reason?.message)).length, 1);
  assert.equal((await store.readBook(b.id)).outline.versions.length, 2);

  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  const chapterRevision = store.versionRevision(
    (await store.readChapter(b.id, s.id, c.id)).body,
  );
  await store.versionSet(b.id, path, '新正文', { expectedRevision: chapterRevision });
  await assert.rejects(
    () => store.versionMove(b.id, path, -1, { expectedRevision: chapterRevision }),
    /VERSION_CONFLICT/,
  );
  assert.equal(store.currentText((await store.readChapter(b.id, s.id, c.id)).body), '新正文');
});

test('并发 versionSet outline 与 core 不互相覆盖 book.json', async () => {
  const b = await store.createBook({ premise: 'p' });

  await Promise.all([
    store.versionSet(b.id, 'outline', '大纲第一版'),
    store.versionSet(b.id, 'core:world', '世界观第一版'),
    store.versionSet(b.id, 'core:style', '文风第一版'),
    store.versionSet(b.id, 'core:pacing', '节奏第一版'),
  ]);

  const back = await store.readBook(b.id);
  assert.deepEqual(back.outline.versions, ['', '大纲第一版']);
  assert.deepEqual(back.settings.core.world.versions, ['', '世界观第一版']);
  assert.deepEqual(back.settings.core.style.versions, ['', '文风第一版']);
  assert.deepEqual(back.settings.core.pacing.versions, ['', '节奏第一版']);
});

test('并发 addSection 与 versionSet outline 不互相覆盖 book.json', async () => {
  const b = await store.createBook({ premise: 'p' });
  const outlines = Array.from({ length: 12 }, (_, i) => `大纲第${i + 1}版`);
  const sectionTitles = Array.from({ length: 12 }, (_, i) => `第${i + 1}部`);

  await Promise.all([
    ...outlines.map((text) => store.versionSet(b.id, 'outline', text)),
    ...sectionTitles.map((title) => store.addSection(b.id, { title })),
  ]);

  const back = await store.readBook(b.id);
  assert.deepEqual(back.outline.versions, ['', ...outlines]);
  assert.equal(back.sections.length, sectionTitles.length);
});

test('并发 renameBook 与 versionSet outline 不互相覆盖 book.json', async () => {
  const b = await store.createBook({ premise: 'p', title: '旧书名' });
  const outlines = Array.from({ length: 12 }, (_, i) => `大纲第${i + 1}版`);

  await Promise.all([
    store.renameBook(b.id, '新书名'),
    ...outlines.map((text) => store.versionSet(b.id, 'outline', text)),
  ]);

  const back = await store.readBook(b.id);
  assert.equal(back.title, '新书名');
  assert.equal(back.titleSource, 'manual');
  assert.deepEqual(back.outline.versions, ['', ...outlines]);
});

test('相同旧书名的并发 renameBook 只有一个不同目标可以提交', async () => {
  const b = await store.createBook({ premise: 'p', title: '共同旧书名' });

  const results = await Promise.allSettled([
    store.renameBook(b.id, '页面甲书名', { expectedTitle: '共同旧书名' }),
    store.renameBook(b.id, '页面乙书名', { expectedTitle: '共同旧书名' }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.match(String(rejected?.reason?.message), /BOOK_TITLE_CONFLICT/);
  const saved = await store.readBook(b.id);
  assert.ok(['页面甲书名', '页面乙书名'].includes(saved.title));

  const replayed = await store.renameBook(
    b.id, saved.title, { expectedTitle: '共同旧书名' },
  );
  assert.equal(replayed.title, saved.title);
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

test('章节正文写入会先完成残留删除事务，不把新正文写进随后删除的章节', async () => {
  const b = await store.createBook({ premise: '失败删章后的正文保护' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  await store.versionSet(
    b.id, `section:${s.id}:chapter:${c.id}`, '删除请求前的正文',
  );
  const before = await store.readChapter(b.id, s.id, c.id);
  const transactionPath = join(
    root, 'books', b.id, s.id, '.section-structure-transaction.json',
  );
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-structure-transaction', version: 1,
    type: 'delete-chapter', bookId: b.id, sectionId: s.id, chapterId: c.id,
  });

  await assert.rejects(
    () => store.versionSet(
      b.id,
      `section:${s.id}:chapter:${c.id}`,
      '不能被接受后再静默删除的新正文',
      { expectedRevision: store.versionRevision(before.body) },
    ),
    /CHAPTER_NOT_FOUND/,
  );

  assert.equal(existsSync(transactionPath), false);
  assert.deepEqual((await store.readSection(b.id, s.id)).chapters, []);
  await assert.rejects(
    () => store.readChapter(b.id, s.id, c.id),
    /ENOENT/,
  );
});

test('残留删章事务清理目标章后仍可在最新结构上保存同部其它章节', async () => {
  const b = await store.createBook({ premise: '残留删章后的其它正文' });
  const s = await store.addSection(b.id, {});
  const removed = await store.addChapter(b.id, s.id, {});
  const kept = await store.addChapter(b.id, s.id, {});
  const transactionPath = join(
    root, 'books', b.id, s.id, '.section-structure-transaction.json',
  );
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-structure-transaction', version: 1,
    type: 'delete-chapter', bookId: b.id, sectionId: s.id, chapterId: removed.id,
  });

  await store.versionSet(
    b.id, `section:${s.id}:chapter:${kept.id}`, '仍应正常保存的正文',
  );

  assert.equal(existsSync(transactionPath), false);
  assert.deepEqual((await store.readSection(b.id, s.id)).chapters, [kept.id]);
  assert.equal(
    store.currentText((await store.readChapter(b.id, s.id, kept.id)).body),
    '仍应正常保存的正文',
  );
  await assert.rejects(
    () => store.readChapter(b.id, s.id, removed.id),
    /ENOENT/,
  );
});

test('章节正文实际变化时清除旧 digest，避免下一章继续使用已撤销剧情', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  await store.versionSet(b.id, path, '旧正文');
  const oldChapter = await store.readChapter(b.id, s.id, c.id);
  await store.applyChapterDigest(b.id, s.id, c.id, {
    chapterTitle: '旧章名', sectionTitle: '旧部名',
    summary: '旧剧情摘要', progress: '旧剧情下一步',
    newCharacters: [{ name: '旧人物', role: '反派', desc: '只存在于旧正文' }],
  }, { expectedBodyFingerprint: oldChapter.bodyFingerprint });

  await store.versionSet(b.id, path, '用户手动改写后的正文');

  const [chapter, section, book] = await Promise.all([
    store.readChapter(b.id, s.id, c.id),
    store.readSection(b.id, s.id),
    store.readBook(b.id),
  ]);
  assert.equal(store.currentText(chapter.body), '用户手动改写后的正文');
  assert.equal(chapter.summary, '');
  assert.equal(chapter.progress, '');
  assert.deepEqual(chapter.characters, []);
  assert.equal(chapter.title, '');
  assert.equal(chapter.titleSource, 'default');
  assert.equal(section.summary, '');
  assert.equal(section.progress, '');
  assert.equal(section.title, '');
  assert.equal(section.titleSource, 'default');
  assert.equal(book.progress, '');
});

test('切回不同正文版本时清除旧 digest，相同正文版本切换则保留', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, { title: '手动部名' });
  const c = await store.addChapter(b.id, s.id, { title: '手动章名' });
  const path = `section:${s.id}:chapter:${c.id}`;
  await store.versionSet(b.id, path, '第一版正文');
  await store.versionSet(b.id, path, '第二版正文');
  let chapter = await store.readChapter(b.id, s.id, c.id);
  const digest = {
    summary: '第二版摘要', progress: '第二版下一步',
    newCharacters: [{ name: '人物乙', role: '配角', desc: '第二版人物' }],
  };
  await store.applyChapterDigest(
    b.id, s.id, c.id, digest, { expectedBodyFingerprint: chapter.bodyFingerprint },
  );

  await store.versionSet(b.id, path, '第二版正文');
  chapter = await store.readChapter(b.id, s.id, c.id);
  assert.equal(chapter.summary, '第二版摘要');
  assert.equal(chapter.progress, '第二版下一步');
  assert.equal(chapter.characters.length, 1);
  await store.versionMove(b.id, path, -1);
  chapter = await store.readChapter(b.id, s.id, c.id);
  assert.equal(store.currentText(chapter.body), '第二版正文');
  assert.equal(chapter.summary, '第二版摘要');

  await store.versionMove(b.id, path, -1);
  chapter = await store.readChapter(b.id, s.id, c.id);
  assert.equal(store.currentText(chapter.body), '第一版正文');
  assert.equal(chapter.summary, '');
  assert.equal(chapter.progress, '');
  assert.deepEqual(chapter.characters, []);
  assert.equal(chapter.title, '手动章名');
  assert.equal(chapter.titleSource, 'manual');
  const section = await store.readSection(b.id, s.id);
  assert.equal(section.title, '手动部名');
  assert.equal(section.titleSource, 'manual');
  assert.equal(section.summary, '');
});

test('生成正文提交先清除旧 digest，后处理失败也不会留下新正文配旧路标', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  await store.versionSet(b.id, path, '待重写正文');
  let chapter = await store.readChapter(b.id, s.id, c.id);
  await store.applyChapterDigest(b.id, s.id, c.id, {
    chapterTitle: '待重写章名', sectionTitle: '待重写部名',
    summary: '待重写摘要', progress: '待重写路标',
    newCharacters: [{ name: '旧角色', role: '旧身份', desc: '旧描述' }],
  }, { expectedBodyFingerprint: chapter.bodyFingerprint });
  const context = await store.readChapterGenerationContext(b.id, s.id, c.id);

  await store.commitGeneratedChapter(b.id, s.id, c.id, '模型生成的新正文', {
    expectedRevision: context.targetRevision,
    expectedContextRevision: context.contextRevision,
    expectedPreviousChapterId: context.previousChapterId,
    expectedPreviousChapterSectionId: context.previousChapterSectionId,
  });

  chapter = await store.readChapter(b.id, s.id, c.id);
  const section = await store.readSection(b.id, s.id);
  assert.equal(store.currentText(chapter.body), '模型生成的新正文');
  assert.equal(chapter.summary, '');
  assert.equal(chapter.progress, '');
  assert.deepEqual(chapter.characters, []);
  assert.equal(chapter.titleSource, 'default');
  assert.equal(section.summary, '');
  assert.equal(section.progress, '');
  assert.equal(section.titleSource, 'default');
});

test('正文保存与旧 digest 并发时最终不会把旧派生信息附着到新正文', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  await store.versionSet(b.id, path, '生成时正文');
  const generated = await store.readChapter(b.id, s.id, c.id);

  await Promise.all([
    store.applyChapterDigest(b.id, s.id, c.id, {
      chapterTitle: '迟到章名', sectionTitle: '迟到部名',
      summary: '迟到摘要', progress: '迟到路标',
      newCharacters: [{ name: '迟到人物', role: '配角', desc: '不应保留' }],
    }, { expectedBodyFingerprint: generated.bodyFingerprint }),
    store.versionSet(b.id, path, '并发保存的新正文'),
  ]);

  const [chapter, section, book] = await Promise.all([
    store.readChapter(b.id, s.id, c.id),
    store.readSection(b.id, s.id),
    store.readBook(b.id),
  ]);
  assert.equal(store.currentText(chapter.body), '并发保存的新正文');
  assert.equal(chapter.summary, '');
  assert.equal(chapter.progress, '');
  assert.deepEqual(chapter.characters, []);
  assert.equal(chapter.titleSource, 'default');
  assert.equal(section.summary, '');
  assert.equal(section.progress, '');
  assert.equal(section.titleSource, 'default');
  assert.equal(book.progress, '');
});

test('并发 versionSet chapter 不丢失任何版本并同步 content', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;

  await Promise.all([
    store.versionSet(b.id, path, '章节正文A'),
    store.versionSet(b.id, path, '章节正文B'),
    store.versionSet(b.id, path, '章节正文C'),
    store.versionSet(b.id, path, '章节正文D'),
  ]);

  const ch = await store.readChapter(b.id, s.id, c.id);
  assert.deepEqual(ch.body.versions, ['', '章节正文A', '章节正文B', '章节正文C', '章节正文D']);
  assert.equal(ch.body.cursor, 4);
  assert.equal(ch.content, '章节正文D');
});

test('并发 versionSet outline 与 chapter 不互相覆盖 book.json', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  const outlines = Array.from({ length: 12 }, (_, i) => `大纲第${i + 1}版`);
  const chapters = Array.from({ length: 12 }, (_, i) => `章节正文${i + 1}`);

  await Promise.all([
    ...outlines.map((text) => store.versionSet(b.id, 'outline', text)),
    ...chapters.map((text) => store.versionSet(b.id, path, text)),
  ]);

  const back = await store.readBook(b.id);
  const ch = await store.readChapter(b.id, s.id, c.id);
  assert.deepEqual(back.outline.versions, ['', ...outlines]);
  assert.deepEqual(ch.body.versions, ['', ...chapters]);
  assert.equal(ch.content, '章节正文12');
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
