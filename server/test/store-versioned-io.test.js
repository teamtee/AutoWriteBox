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

test('章节生成提交在同一锁域内拒绝已经变化的提示词上下文', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const previous = await store.addChapter(b.id, s.id, {});
  const target = await store.addChapter(b.id, s.id, {});
  const previousPath = `section:${s.id}:chapter:${previous.id}`;
  await store.versionSet(b.id, previousPath, '生成开始时的上一章');
  const prepared = await store.readChapterGenerationContext(b.id, s.id, target.id);

  await store.versionSet(b.id, previousPath, '生成期间改写的上一章');
  await assert.rejects(
    () => store.commitGeneratedChapter(b.id, s.id, target.id, '迟到生成结果', {
      expectedRevision: prepared.targetRevision,
      expectedContextRevision: prepared.contextRevision,
      expectedPreviousChapterId: prepared.previousChapterId,
      expectedPreviousChapterSectionId: prepared.previousChapterSectionId,
    }),
    /GENERATION_CONTEXT_CONFLICT/,
  );

  const savedTarget = await store.readChapter(b.id, s.id, target.id);
  assert.deepEqual(savedTarget.body.versions, ['']);
});

test('生成与审稿修订号只锚定实际发送的最近本部摘要窗口', () => {
  const sharedTail = '共同的最近剧情'.repeat(MAX_SECTION_PROMPT_SUMMARY_CHARS);
  const makeSection = (oldSummary, latest = sharedTail) => ({
    outline: { content: '本部大纲' },
    summary: `${oldSummary}\n${latest}`,
    characters: [],
  });
  const book = {
    outline: { versions: ['全书大纲'], cursor: 0 },
    settings: { core: {
      world: { versions: [''], cursor: 0 },
      style: { versions: [''], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
    characters: [],
  };
  const chapter = { id: 'chapter-2', index: 2 };
  const previousChapter = {
    id: 'chapter-1', body: { versions: ['上一章正文'], cursor: 0 },
    progress: '继续前进', characters: [],
  };

  const reviewA = store.chapterReviewContextRevision({
    book, section: makeSection('很早的摘要 A'), chapter,
  });
  const reviewB = store.chapterReviewContextRevision({
    book, section: makeSection('很早的摘要 B'), chapter,
  });
  const generationA = store.chapterGenerationContextRevision({
    book, section: makeSection('很早的摘要 A'), chapter,
    previousChapter, previousChapterSectionId: 'section-1',
  });
  const generationB = store.chapterGenerationContextRevision({
    book, section: makeSection('很早的摘要 B'), chapter,
    previousChapter, previousChapterSectionId: 'section-1',
  });

  assert.equal(reviewA, reviewB);
  assert.equal(generationA, generationB);
  assert.notEqual(reviewA, store.chapterReviewContextRevision({
    book, section: makeSection('很早的摘要 A', `${sharedTail}变化`), chapter,
  }));
});

test('章节生成与审稿修订号锚定实际发送的书名和作品简介', () => {
  const makeBook = (title, premise) => ({
    title,
    premise,
    outline: { versions: ['全书大纲'], cursor: 0 },
    settings: { core: {
      world: { versions: [''], cursor: 0 },
      style: { versions: [''], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
    characters: [],
  });
  const section = { id: 'section-1', outline: { content: '' }, summary: '', characters: [] };
  const chapter = { id: 'chapter-2', index: 2 };
  const previousChapter = {
    id: 'chapter-1', body: { versions: ['上一章'], cursor: 0 },
    progress: '', characters: [],
  };
  const baseBook = makeBook('旧书名', '旧简介承诺');
  const baseReview = store.chapterReviewContextRevision({ book: baseBook, section, chapter });
  const baseGeneration = store.chapterGenerationContextRevision({
    book: baseBook, section, chapter, previousChapter,
    previousChapterSectionId: 'section-1',
  });

  for (const changedBook of [
    makeBook('新书名', '旧简介承诺'),
    makeBook('旧书名', '新简介承诺'),
  ]) {
    assert.notEqual(baseReview, store.chapterReviewContextRevision({
      book: changedBook, section, chapter,
    }));
    assert.notEqual(baseGeneration, store.chapterGenerationContextRevision({
      book: changedBook, section, chapter, previousChapter,
      previousChapterSectionId: 'section-1',
    }));
  }
});

test('生成与审稿修订号只锚定人物提示词保留的主要与最近条目', () => {
  const characters = Array.from({ length: MAX_STORED_CHARACTERS }, (_, index) => ({
    name: `人物${index}`,
    role: '角色',
    desc: '状态'.repeat(250),
  }));
  const bookFor = (nextCharacters) => ({
    outline: { versions: ['全书大纲'], cursor: 0 },
    settings: { core: {
      world: { versions: [''], cursor: 0 },
      style: { versions: [''], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
    characters: nextCharacters,
  });
  const section = { outline: { content: '' }, summary: '', characters: [] };
  const chapter = { id: 'chapter-2', index: 2 };
  const base = store.chapterReviewContextRevision({
    book: bookFor(characters), section, chapter,
  });

  const omittedChange = structuredClone(characters);
  omittedChange[500].desc = '变化'.repeat(250);
  assert.equal(base, store.chapterReviewContextRevision({
    book: bookFor(omittedChange), section, chapter,
  }));

  const retainedChange = structuredClone(characters);
  retainedChange[0].desc = '变化'.repeat(250);
  assert.notEqual(base, store.chapterReviewContextRevision({
    book: bookFor(retainedChange), section, chapter,
  }));
});

test('上下文修订号忽略核心设定中段和上一章早期正文，只锚定实际提示词窗口', () => {
  const coreTail = '核心结尾';
  const coreText = `核心开头${'中'.repeat(MAX_CORE_PROMPT_FIELD_CHARS * 2)}${coreTail}`;
  const coreMiddleChanged = `${coreText.slice(0, MAX_CORE_PROMPT_FIELD_CHARS)}变${coreText.slice(MAX_CORE_PROMPT_FIELD_CHARS + 1)}`;
  const makeBook = (world) => ({
    premise: '故事设想',
    outline: { versions: ['全书大纲'], cursor: 0 },
    settings: { core: {
      world: { versions: [world], cursor: 0 },
      style: { versions: [''], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
    characters: [],
  });
  const section = { outline: { content: '本部大纲' }, summary: '', characters: [] };
  const chapter = { id: 'chapter-2', index: 2 };
  const previousTail = '末'.repeat(300);
  const previousFor = (prefix, tail = previousTail) => ({
    id: 'chapter-1',
    body: { versions: [`${prefix}${tail}`], cursor: 0 },
    progress: '继续前进',
    characters: [],
  });

  assert.equal(
    store.bookGenerationContextRevision(makeBook(coreText)),
    store.bookGenerationContextRevision(makeBook(coreMiddleChanged)),
  );
  assert.notEqual(
    store.bookGenerationContextRevision(makeBook(coreText)),
    store.bookGenerationContextRevision(makeBook(`变${coreText.slice(1)}`)),
  );

  const base = store.chapterGenerationContextRevision({
    book: makeBook(coreText), section, chapter,
    previousChapter: previousFor('旧的早期正文 A'),
    previousChapterSectionId: 'section-1',
  });
  assert.equal(base, store.chapterGenerationContextRevision({
    book: makeBook(coreMiddleChanged), section, chapter,
    previousChapter: previousFor('完全不同的早期正文 B'),
    previousChapterSectionId: 'section-1',
  }));
  assert.notEqual(base, store.chapterGenerationContextRevision({
    book: makeBook(coreText), section, chapter,
    previousChapter: previousFor('旧的早期正文 A', `变${previousTail.slice(1)}`),
    previousChapterSectionId: 'section-1',
  }));
});

test('章节上下文修订号只锚定实际发送的大纲窗口，分部规划仍锚定完整全书大纲', () => {
  const longText = (prefix, limit, suffix) =>
    `${prefix}${'中'.repeat(limit * 2)}${suffix}`;
  const outline = longText('全书开头', MAX_BOOK_OUTLINE_PROMPT_CHARS, '全书结尾');
  const changedOutline = `${outline.slice(0, MAX_BOOK_OUTLINE_PROMPT_CHARS)}变${outline.slice(MAX_BOOK_OUTLINE_PROMPT_CHARS + 1)}`;
  const sectionOutline = longText(
    '本部开头', MAX_SECTION_OUTLINE_PROMPT_CHARS, '本部结尾',
  );
  const changedSectionOutline = `${sectionOutline.slice(0, MAX_SECTION_OUTLINE_PROMPT_CHARS)}变${sectionOutline.slice(MAX_SECTION_OUTLINE_PROMPT_CHARS + 1)}`;
  const bookFor = (text) => ({
    outline: { versions: [text], cursor: 0 },
    settings: { core: {
      world: { versions: [''], cursor: 0 },
      style: { versions: [''], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
    characters: [],
  });
  const sectionFor = (text) => ({
    outline: { content: text }, summary: '', characters: [],
  });
  const chapter = { id: 'chapter-1', index: 1 };
  const base = store.chapterReviewContextRevision({
    book: bookFor(outline), section: sectionFor(sectionOutline), chapter,
  });

  assert.equal(base, store.chapterReviewContextRevision({
    book: bookFor(changedOutline), section: sectionFor(changedSectionOutline), chapter,
  }));
  assert.notEqual(base, store.chapterReviewContextRevision({
    book: bookFor(`变${outline.slice(1)}`), section: sectionFor(sectionOutline), chapter,
  }));
  assert.notEqual(base, store.chapterReviewContextRevision({
    book: bookFor(outline), section: sectionFor(`变${sectionOutline.slice(1)}`), chapter,
  }));
  assert.notEqual(
    store.sectionPlanContextRevision(bookFor(outline)),
    store.sectionPlanContextRevision(bookFor(changedOutline)),
  );
});

test('同部生成上下文跳过连续空章，并在空章后来写入时拒绝旧结果', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const completed = await store.addChapter(b.id, s.id, {});
  const empty = await store.addChapter(b.id, s.id, {});
  const target = await store.addChapter(b.id, s.id, {});
  await store.versionSet(
    b.id, `section:${s.id}:chapter:${completed.id}`, '真正的上一章正文',
  );
  const savedCompleted = await store.readChapter(b.id, s.id, completed.id);
  await store.applyChapterDigest(b.id, s.id, completed.id, {
    summary: '上一章摘要', progress: '沿河追踪失踪者',
    newCharacters: [{ name: '船夫', role: '目击者', desc: '看见失踪者登船' }],
  }, { expectedBodyFingerprint: savedCompleted.bodyFingerprint });

  const prepared = await store.readChapterGenerationContext(b.id, s.id, target.id);
  assert.equal(prepared.previousChapterId, completed.id);
  assert.equal(store.currentText(prepared.previousChapter.body), '真正的上一章正文');
  assert.equal(prepared.previousChapter.progress, '沿河追踪失踪者');

  // 原本为空的中间章一旦出现正文，就成为新的实际上一章；基于更早
  // 前情生成的结果必须被上下文锚点拒绝。
  await store.versionSet(b.id, `section:${s.id}:chapter:${empty.id}`, '后来补写的中间章');
  await assert.rejects(
    () => store.commitGeneratedChapter(b.id, s.id, target.id, '基于旧前情的迟到正文', {
      expectedRevision: prepared.targetRevision,
      expectedContextRevision: prepared.contextRevision,
      expectedPreviousChapterId: prepared.previousChapterId,
      expectedPreviousChapterSectionId: prepared.previousChapterSectionId,
    }),
    /GENERATION_CONTEXT_CONFLICT/,
  );
  assert.deepEqual((await store.readChapter(b.id, s.id, target.id)).body.versions, ['']);
});

test('新分部首章会跳过尾部空章和仅含空章的分部承接全书前情', async () => {
  const b = await store.createBook({ premise: 'p' });
  const previousSection = await store.addSection(b.id, {});
  const previous = await store.addChapter(b.id, previousSection.id, {});
  await store.versionSet(
    b.id,
    `section:${previousSection.id}:chapter:${previous.id}`,
    '上一部末尾：主角推开了石门。',
  );
  const savedPrevious = await store.readChapter(
    b.id, previousSection.id, previous.id,
  );
  await store.applyChapterDigest(b.id, previousSection.id, previous.id, {
    summary: '主角找到石门',
    progress: '进入石门后的地下城',
    newCharacters: [{ name: '守门人', role: '引路人', desc: '掌握地下城地图' }],
  }, { expectedBodyFingerprint: savedPrevious.bodyFingerprint });
  await store.addChapter(b.id, previousSection.id, {});
  const emptySection = await store.addSection(b.id, {});
  await store.addChapter(b.id, emptySection.id, {});
  const targetSection = await store.addSection(b.id, {});
  const target = await store.addChapter(b.id, targetSection.id, {});

  const context = await store.readChapterGenerationContext(
    b.id, targetSection.id, target.id,
  );

  assert.equal(context.previousChapterSectionId, previousSection.id);
  assert.equal(context.previousChapterId, previous.id);
  assert.equal(
    store.currentText(context.previousChapter.body),
    '上一部末尾：主角推开了石门。',
  );
  assert.equal(context.previousChapter.progress, '进入石门后的地下城');
  assert.deepEqual(context.previousChapter.characters, [
    { name: '守门人', role: '引路人', desc: '掌握地下城地图' },
  ]);
});

test('跨分部上一章在生成期间变化时拒绝迟到正文', async () => {
  const b = await store.createBook({ premise: 'p' });
  const previousSection = await store.addSection(b.id, {});
  const previous = await store.addChapter(b.id, previousSection.id, {});
  const previousPath = `section:${previousSection.id}:chapter:${previous.id}`;
  await store.versionSet(b.id, previousPath, '生成开始时的上一部末章');
  const targetSection = await store.addSection(b.id, {});
  const target = await store.addChapter(b.id, targetSection.id, {});
  const prepared = await store.readChapterGenerationContext(
    b.id, targetSection.id, target.id,
  );

  await store.versionSet(b.id, previousPath, '生成期间改写的上一部末章');
  await assert.rejects(
    () => store.commitGeneratedChapter(
      b.id, targetSection.id, target.id, '基于旧跨部前情的迟到正文', {
        expectedRevision: prepared.targetRevision,
        expectedContextRevision: prepared.contextRevision,
        expectedPreviousChapterId: prepared.previousChapterId,
        expectedPreviousChapterSectionId: prepared.previousChapterSectionId,
      },
    ),
    /GENERATION_CONTEXT_CONFLICT/,
  );

  assert.deepEqual(
    (await store.readChapter(b.id, targetSection.id, target.id)).body.versions,
    [''],
  );
});

test('生成与审稿上下文中途取消会停止快照组装并释放章节锁', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  await store.addChapter(b.id, s.id, {});
  const target = await store.addChapter(b.id, s.id, {});

  let generationChecks = 0;
  const generationSignal = {
    reason: new Error('CLIENT_ABORTED'),
    get aborted() {
      generationChecks += 1;
      // 外层、锁内起点、分部、当前章以及上一章读取后取消。
      return generationChecks >= 5;
    },
  };
  await assert.rejects(
    () => store.readChapterGenerationContext(
      b.id, s.id, target.id, { signal: generationSignal },
    ),
    /CLIENT_ABORTED/,
  );

  let reviewChecks = 0;
  const reviewSignal = {
    reason: new Error('CLIENT_ABORTED'),
    get aborted() {
      reviewChecks += 1;
      // 外层、锁内起点、分部以及作品/章节并行读取后取消。
      return reviewChecks >= 4;
    },
  };
  await assert.rejects(
    () => store.readChapterReviewContext(
      b.id, s.id, target.id, { signal: reviewSignal },
    ),
    /CLIENT_ABORTED/,
  );

  // 两次取消都必须经过 finally 释放锁，后续正文保存不能被挂住。
  const path = `section:${s.id}:chapter:${target.id}`;
  const before = await store.readChapter(b.id, s.id, target.id);
  await store.versionSet(b.id, path, '取消后的正常保存', {
    expectedRevision: store.versionRevision(before.body),
  });
  assert.equal(
    store.currentText((await store.readChapter(b.id, s.id, target.id)).body),
    '取消后的正常保存',
  );
});

test('生成提交与下一章创建在等待作品锁时可取消且不会迟到落盘', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const chapterContext = await store.readChapterGenerationContext(b.id, s.id, c.id);
  const preparedBook = await store.readBook(b.id);
  const outlineRevision = store.versionRevision(preparedBook.outline);
  const bookContextRevision = store.bookGenerationContextRevision(preparedBook);

  let releaseBookLock;
  let markBookLockHeld;
  const bookLockHeld = new Promise((resolve) => { markBookLockHeld = resolve; });
  const blocker = store.withStoreLock(`book:${b.id}:book-json`, async () => {
    markBookLockHeld();
    await new Promise((resolve) => { releaseBookLock = resolve; });
  });
  await bookLockHeld;

  const chapterController = new AbortController();
  const outlineController = new AbortController();
  const addController = new AbortController();
  const committingChapter = store.commitGeneratedChapter(
    b.id, s.id, c.id, '不应落盘的正文', {
      expectedRevision: chapterContext.targetRevision,
      expectedContextRevision: chapterContext.contextRevision,
      expectedPreviousChapterId: chapterContext.previousChapterId,
      expectedPreviousChapterSectionId: chapterContext.previousChapterSectionId,
      signal: chapterController.signal,
    },
  );
  const committingOutline = store.commitGeneratedBookVersion(
    b.id, 'outline', '不应落盘的大纲', {
      expectedRevision: outlineRevision,
      expectedContextRevision: bookContextRevision,
      signal: outlineController.signal,
    },
  );
  const addingChapter = store.addChapter(b.id, s.id, {
    expectedLastChapterId: c.id,
    signal: addController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  chapterController.abort(new Error('CLIENT_ABORTED'));
  outlineController.abort(new Error('CLIENT_ABORTED'));
  addController.abort(new Error('CLIENT_ABORTED'));

  const bounded = (operation) => {
    let timer;
    return Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('CANCEL_WAIT_TIMEOUT')), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  try {
    await Promise.all([
      assert.rejects(bounded(committingChapter), /CLIENT_ABORTED/),
      assert.rejects(bounded(committingOutline), /CLIENT_ABORTED/),
      assert.rejects(bounded(addingChapter), /CLIENT_ABORTED/),
    ]);
  } finally {
    releaseBookLock();
    await blocker;
  }

  assert.deepEqual((await store.readBook(b.id)).outline.versions, ['']);
  assert.deepEqual((await store.readChapter(b.id, s.id, c.id)).body.versions, ['']);
  assert.deepEqual((await store.readSection(b.id, s.id)).chapters, [c.id]);

  // 取消路径必须释放先取得的章节结构锁，后续正常创建不能挂住。
  const created = await store.addChapter(b.id, s.id, { expectedLastChapterId: c.id });
  assert.equal(created.id, 'chapter-02');
});

test('生成后处理在等待作品锁时可取消且不写入摘要、审稿或自动书名', async () => {
  const b = await store.createBook({ premise: '默认作品名' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  await store.versionSet(
    b.id, `section:${s.id}:chapter:${c.id}`, '正文',
  );
  const chapter = await store.readChapter(b.id, s.id, c.id);
  const reviewContext = await store.readChapterReviewContext(b.id, s.id, c.id);
  const preparedBook = await store.readBook(b.id);

  let releaseBookLock;
  let markBookLockHeld;
  const bookLockHeld = new Promise((resolve) => { markBookLockHeld = resolve; });
  const blocker = store.withStoreLock(`book:${b.id}:book-json`, async () => {
    markBookLockHeld();
    await new Promise((resolve) => { releaseBookLock = resolve; });
  });
  await bookLockHeld;

  const titleController = new AbortController();
  const digestController = new AbortController();
  const reviewController = new AbortController();
  const settingTitle = store.setGeneratedBookTitle(b.id, '迟到书名', {
    expectedOutlineRevision: store.versionRevision(preparedBook.outline),
    expectedContextRevision: store.bookGenerationContextRevision(preparedBook),
    signal: titleController.signal,
  });
  const applyingDigest = store.applyChapterDigest(b.id, s.id, c.id, {
    chapterTitle: '迟到章名', sectionTitle: '迟到部名',
    summary: '迟到摘要', progress: '迟到进度', newCharacters: [],
  }, {
    expectedBodyFingerprint: chapter.bodyFingerprint,
    signal: digestController.signal,
  });
  const savingReview = store.saveChapterReview(b.id, s.id, c.id, {
    score: 80,
    verdict: '迟到审稿',
    issues: [{ title: '问题', detail: '详情' }],
    suggestions: [{ label: '建议', instruction: '修改' }],
  }, {
    expectedBodyFingerprint: chapter.bodyFingerprint,
    expectedContextRevision: reviewContext.contextRevision,
    signal: reviewController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  titleController.abort(new Error('CLIENT_ABORTED'));
  digestController.abort(new Error('CLIENT_ABORTED'));
  reviewController.abort(new Error('CLIENT_ABORTED'));

  const bounded = (operation) => {
    let timer;
    return Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('CANCEL_WAIT_TIMEOUT')), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    await Promise.all([
      assert.rejects(bounded(settingTitle), /CLIENT_ABORTED/),
      assert.rejects(bounded(applyingDigest), /CLIENT_ABORTED/),
      assert.rejects(bounded(savingReview), /CLIENT_ABORTED/),
    ]);
  } finally {
    releaseBookLock();
    await blocker;
  }

  const savedBook = await store.readBook(b.id);
  const savedSection = await store.readSection(b.id, s.id);
  const savedChapter = await store.readChapter(b.id, s.id, c.id);
  assert.equal(savedBook.title, '默认作品名');
  assert.equal(savedBook.titleSource, 'default');
  assert.equal(savedSection.title, '');
  assert.equal(savedSection.summary, '');
  assert.equal(savedChapter.title, '');
  assert.equal(savedChapter.summary, '');
  assert.equal(savedChapter.review, undefined);
});

test('书级生成提交在同一锁内拒绝已经变化的核心设定上下文', async () => {
  const b = await store.createBook({ premise: 'p' });
  const preparedBook = await store.readBook(b.id);
  const targetRevision = store.versionRevision(preparedBook.outline);
  const contextRevision = store.bookGenerationContextRevision(preparedBook);
  await store.versionSet(b.id, 'core:constraints', '生成期间新增的约束');

  await assert.rejects(
    () => store.commitGeneratedBookVersion(b.id, 'outline', '迟到大纲', {
      expectedRevision: targetRevision,
      expectedContextRevision: contextRevision,
    }),
    /GENERATION_CONTEXT_CONFLICT/,
  );
  const saved = await store.readBook(b.id);
  assert.deepEqual(saved.outline.versions, ['']);
  assert.equal(store.currentText(saved.settings.core.constraints), '生成期间新增的约束');
});

test('迟到审稿不覆盖期间保存的新正文', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  await store.versionSet(b.id, path, '审稿基线');
  const baseline = await store.readChapter(b.id, s.id, c.id);
  await store.versionSet(b.id, path, '用户新正文');

  const result = await store.saveChapterReview(b.id, s.id, c.id, {
    score: 80, verdict: '旧审稿', issues: [], suggestions: [],
  }, { expectedBodyFingerprint: baseline.bodyFingerprint });

  assert.equal(result.applied, false);
  const back = await store.readChapter(b.id, s.id, c.id);
  assert.equal(store.currentText(back.body), '用户新正文');
  assert.equal(back.review, undefined);
});

test('迟到审稿不附着到已经变化的故事上下文', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  await store.versionSet(b.id, `section:${s.id}:chapter:${c.id}`, '正文');
  const prepared = await store.readChapterReviewContext(b.id, s.id, c.id);
  await store.versionSet(b.id, 'outline', '审稿期间更新的大纲');

  const result = await store.saveChapterReview(b.id, s.id, c.id, {
    score: 80, verdict: '旧审稿', issues: [], suggestions: [],
  }, {
    expectedBodyFingerprint: prepared.chapter.bodyFingerprint,
    expectedContextRevision: prepared.contextRevision,
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'context');
  assert.equal((await store.readChapter(b.id, s.id, c.id)).review, undefined);
});

test('删除中间章后审稿读取与保存使用同一逻辑章节序号', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  await store.addChapter(b.id, s.id, {});
  const removed = await store.addChapter(b.id, s.id, {});
  const target = await store.addChapter(b.id, s.id, {});
  await store.versionSet(
    b.id, `section:${s.id}:chapter:${target.id}`, '删章后的待审正文',
  );
  await store.deleteChapter(b.id, s.id, removed.id);
  const prepared = await store.readChapterReviewContext(b.id, s.id, target.id);

  const result = await store.saveChapterReview(b.id, s.id, target.id, {
    score: 88, verdict: '逻辑第二章审稿', issues: [], suggestions: [],
  }, {
    expectedBodyFingerprint: prepared.chapter.bodyFingerprint,
    expectedContextRevision: prepared.contextRevision,
  });

  assert.equal(prepared.chapter.index, 2);
  assert.equal(result.applied, true);
  const saved = await store.readChapter(b.id, s.id, target.id);
  assert.equal(saved.index, 2);
  assert.equal(saved.review.verdict, '逻辑第二章审稿');
});

test('生成与审稿上下文按全书章序识别黄金三章，不在新分部重算', async () => {
  const b = await store.createBook({ premise: '全书章序' });
  const firstSection = await store.addSection(b.id, { title: '上部' });
  await store.addChapter(b.id, firstSection.id, {});
  await store.addChapter(b.id, firstSection.id, {});
  await store.addChapter(b.id, firstSection.id, {});
  const secondSection = await store.addSection(b.id, { title: '下部' });
  const target = await store.addChapter(b.id, secondSection.id, {});

  const review = await store.readChapterReviewContext(
    b.id, secondSection.id, target.id,
  );
  const generation = await store.readChapterGenerationContext(
    b.id, secondSection.id, target.id,
  );

  assert.equal(review.chapter.index, 1);
  assert.equal(review.bookChapterIndex, 4);
  assert.equal(generation.chapter.index, 1);
  assert.equal(generation.bookChapterIndex, 4);
  assert.equal(review.contextRevision, store.chapterReviewContextRevision({
    book: review.book,
    section: review.section,
    chapter: review.chapter,
    bookChapterIndex: 4,
  }));
  assert.notEqual(review.contextRevision, store.chapterReviewContextRevision({
    book: review.book,
    section: review.section,
    chapter: review.chapter,
    bookChapterIndex: 1,
  }));
});

test('后续生成与审稿读取最近章节节奏信号并随记录变化更新修订号', async () => {
  const b = await store.createBook({ premise: '节奏历史' });
  const s = await store.addSection(b.id, {});
  const previous = await store.addChapter(b.id, s.id, {});
  await store.versionSet(
    b.id, `section:${s.id}:chapter:${previous.id}`, '上一章有冲突和兑现',
  );
  const previousBody = await store.readChapter(b.id, s.id, previous.id);
  await store.saveChapterReview(b.id, s.id, previous.id, {
    score: 80, verdict: '可读',
    issues: [{ title: '风险', detail: '连续追逐可能疲劳' }],
    suggestions: [{ label: '调整', instruction: '下一章改变冲突和情绪形态' }],
    webFictionSignals: {
      chapterFunction: '冲突推进', conflictType: '追逐', emotionTone: '紧张',
      payoffType: '脱险', dominantMode: '行动',
    },
  }, { expectedBodyFingerprint: previousBody.bodyFingerprint });
  const target = await store.addChapter(b.id, s.id, {});

  const before = await store.readChapterReviewContext(b.id, s.id, target.id);
  const generation = await store.readChapterGenerationContext(b.id, s.id, target.id);
  assert.deepEqual(before.recentReviewSignals, [{
    bookChapterIndex: 1,
    sectionChapterIndex: 1,
    signals: {
      chapterFunction: '冲突推进', conflictType: '追逐', emotionTone: '紧张',
      payoffType: '脱险', dominantMode: '行动',
    },
  }]);
  assert.deepEqual(generation.recentReviewSignals, before.recentReviewSignals);

  const currentPrevious = await store.readChapter(b.id, s.id, previous.id);
  await store.saveChapterReview(b.id, s.id, previous.id, {
    score: 80, verdict: '可读',
    issues: [{ title: '风险', detail: '关系推进仍可加强' }],
    suggestions: [{ label: '调整', instruction: '让关系变化落到具体选择' }],
    webFictionSignals: {
      chapterFunction: '关系缓冲', conflictType: '试探', emotionTone: '温暖',
      payoffType: '关系兑现', dominantMode: '对话',
    },
  }, { expectedBodyFingerprint: currentPrevious.bodyFingerprint });

  const after = await store.readChapterReviewContext(b.id, s.id, target.id);
  assert.notEqual(after.contextRevision, before.contextRevision);
  assert.equal(after.recentReviewSignals[0].signals.emotionTone, '温暖');
  assert.equal(after.recentReviewSignals[0].signals.dominantMode, '对话');
});

test('迟到 digest 在正文变更后整体丢弃', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  await store.versionSet(b.id, path, '生成正文');
  const generated = await store.readChapter(b.id, s.id, c.id);
  await store.versionSet(b.id, path, '用户修订');

  const result = await store.applyChapterDigest(b.id, s.id, c.id, {
    chapterTitle: '旧标题', sectionTitle: '旧部名', summary: '旧摘要', progress: '旧进度',
    newCharacters: [{ name: '甲', role: '路人', desc: '旧人物' }],
  }, { expectedBodyFingerprint: generated.bodyFingerprint });

  assert.equal(result.applied, false);
  const chapter = await store.readChapter(b.id, s.id, c.id);
  const section = await store.readSection(b.id, s.id);
  const book = await store.readBook(b.id);
  assert.equal(store.currentText(chapter.body), '用户修订');
  assert.equal(chapter.summary, '');
  assert.equal(section.summary, '');
  assert.equal(book.progress, '');
});

test('同一正文重复 digest 覆盖摘要和人物，不累加幽灵人物', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  await store.versionSet(b.id, path, '正文');
  const chapter = await store.readChapter(b.id, s.id, c.id);
  const firstCharacter = { name: '甲', role: '路人', desc: '第一次识别' };
  const replacementCharacter = { name: '乙', role: '证人', desc: '第二次识别' };

  await store.applyChapterDigest(b.id, s.id, c.id, {
    summary: '第一份摘要', progress: '', newCharacters: [firstCharacter],
  }, { expectedBodyFingerprint: chapter.bodyFingerprint });
  await store.applyChapterDigest(b.id, s.id, c.id, {
    summary: '更新后摘要', progress: '', newCharacters: [replacementCharacter],
  }, { expectedBodyFingerprint: chapter.bodyFingerprint });

  const chapterBack = await store.readChapter(b.id, s.id, c.id);
  const sectionBack = await store.readSection(b.id, s.id);
  assert.equal(chapterBack.summary, '更新后摘要');
  assert.deepEqual(chapterBack.characters, [replacementCharacter]);
  assert.equal(sectionBack.summary, '第1章：更新后摘要');

  const next = await store.addChapter(b.id, s.id, {});
  const context = await store.readChapterGenerationContext(b.id, s.id, next.id);
  assert.deepEqual(context.previousChapter.characters, [replacementCharacter]);
});

test('digest 中断后流式扫描大型章节历史并重建摘要和路标', async () => {
  const book = await store.createBook({ premise: '摘要恢复' });
  const section = await store.addSection(book.id, {});
  const first = await store.addChapter(book.id, section.id, {});
  const second = await store.addChapter(book.id, section.id, {});
  await store.versionSet(book.id, `section:${section.id}:chapter:${first.id}`, '第一章正文');
  await store.versionSet(book.id, `section:${section.id}:chapter:${second.id}`, '第二章正文');
  const savedFirst = await store.readChapter(book.id, section.id, first.id);
  await store.applyChapterDigest(book.id, section.id, first.id, {
    summary: '第一章摘要', progress: '第一章路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedFirst.bodyFingerprint });
  const largeFirst = await store.readChapter(book.id, section.id, first.id);
  largeFirst.body = {
    versions: Array.from(
      { length: MAX_VERSION_HISTORY_ITEMS },
      () => '大型历史'.repeat(10_000),
    ),
    cursor: 8,
  };
  await store.writeChapter(book.id, section.id, first.id, largeFirst);

  const transactionPath = join(
    root, 'books', book.id, section.id, '.chapter-digest-transaction.json',
  );
  const partialChapter = await store.readChapter(book.id, section.id, second.id);
  partialChapter.summary = '第二章摘要';
  partialChapter.progress = '第二章路标';
  const partialBook = await store.readBook(book.id);
  partialBook.progress = '第二章路标';
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-chapter-digest-transaction',
    version: 1,
    bookId: book.id,
    sectionId: section.id,
    chapterId: second.id,
    bodyFingerprint: partialChapter.bodyFingerprint,
  });
  // 模拟 digest 已写 book/chapter、尚未写 section 时进程退出。
  await store.atomicWriteJson(join(root, 'books', book.id, 'book.json'), partialBook);
  await store.atomicWriteJson(
    join(root, 'books', book.id, section.id, `${second.id}.json`), partialChapter,
  );

  const diagnostics = await store.diagnoseStorage();
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'CHAPTER_DIGEST_TRANSACTION_PENDING'
      && issue.bookId === book.id && issue.sectionId === section.id));

  const originalJsonParse = JSON.parse;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.length > 64 * 1024) {
      throw new Error('WHOLE_CHAPTER_JSON_PARSE_FORBIDDEN');
    }
    return originalJsonParse(text, ...args);
  };
  try {
    await store.readBookStructure(book.id);
  } finally {
    JSON.parse = originalJsonParse;
  }
  assert.equal(existsSync(transactionPath), false);
  const recoveredSection = await store.readSection(book.id, section.id);
  assert.equal(
    recoveredSection.summary,
    '第1章：第一章摘要\n第2章：第二章摘要',
  );
  assert.equal(recoveredSection.progress, '第二章路标');
  assert.equal((await store.readBook(book.id)).progress, '第二章路标');
});

test('digest 明确返回空人物列表时清除同一正文的旧人物', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  await store.versionSet(b.id, `section:${s.id}:chapter:${c.id}`, '正文');
  const chapter = await store.readChapter(b.id, s.id, c.id);

  await store.applyChapterDigest(b.id, s.id, c.id, {
    summary: '第一份摘要', progress: '',
    newCharacters: [{ name: '甲', role: '路人', desc: '误识别' }],
  }, { expectedBodyFingerprint: chapter.bodyFingerprint });
  await store.applyChapterDigest(b.id, s.id, c.id, {
    summary: '更新后摘要', progress: '', newCharacters: [],
  }, { expectedBodyFingerprint: chapter.bodyFingerprint });

  assert.deepEqual((await store.readChapter(b.id, s.id, c.id)).characters, []);
});

test('同一章并发 digest 的人物结果保持整份快照，不会合并', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  await store.versionSet(b.id, `section:${s.id}:chapter:${c.id}`, '正文');
  const chapter = await store.readChapter(b.id, s.id, c.id);
  const firstCharacters = [{ name: '甲', role: '路人', desc: '第一份结果' }];
  const secondCharacters = [{ name: '乙', role: '证人', desc: '第二份结果' }];

  await Promise.all([
    store.applyChapterDigest(b.id, s.id, c.id, {
      summary: '第一份摘要', progress: '', newCharacters: firstCharacters,
    }, { expectedBodyFingerprint: chapter.bodyFingerprint }),
    store.applyChapterDigest(b.id, s.id, c.id, {
      summary: '第二份摘要', progress: '', newCharacters: secondCharacters,
    }, { expectedBodyFingerprint: chapter.bodyFingerprint }),
  ]);

  const characters = (await store.readChapter(b.id, s.id, c.id)).characters;
  assert.ok(
    JSON.stringify(characters) === JSON.stringify(firstCharacters)
      || JSON.stringify(characters) === JSON.stringify(secondCharacters),
  );
});

test('重写本部较早章节时新 digest 不会让分部和全书路标倒退', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const early = await store.addChapter(b.id, s.id, {});
  const late = await store.addChapter(b.id, s.id, {});
  const earlyPath = `section:${s.id}:chapter:${early.id}`;
  const latePath = `section:${s.id}:chapter:${late.id}`;
  await store.versionSet(b.id, earlyPath, '第一章旧正文');
  await store.versionSet(b.id, latePath, '第二章正文');
  let savedEarly = await store.readChapter(b.id, s.id, early.id);
  const savedLate = await store.readChapter(b.id, s.id, late.id);
  await store.applyChapterDigest(b.id, s.id, early.id, {
    summary: '第一章旧摘要', progress: '第一章旧路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedEarly.bodyFingerprint });
  await store.applyChapterDigest(b.id, s.id, late.id, {
    summary: '第二章摘要', progress: '第二章最新路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedLate.bodyFingerprint });

  await store.versionSet(b.id, earlyPath, '第一章重写正文');
  savedEarly = await store.readChapter(b.id, s.id, early.id);
  await store.applyChapterDigest(b.id, s.id, early.id, {
    summary: '第一章新摘要', progress: '第一章重写路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedEarly.bodyFingerprint });

  const [earlyBack, sectionBack, bookBack] = await Promise.all([
    store.readChapter(b.id, s.id, early.id),
    store.readSection(b.id, s.id),
    store.readBook(b.id),
  ]);
  assert.equal(earlyBack.progress, '第一章重写路标');
  assert.equal(sectionBack.progress, '第二章最新路标');
  assert.equal(bookBack.progress, '第二章最新路标');
  assert.equal(sectionBack.summary, '第1章：第一章新摘要\n第2章：第二章摘要');
});

test('删除中间章后分部聚合摘要按当前正文顺序重新编号', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const chapters = [];
  for (const [index, label] of ['一', '二', '三'].entries()) {
    const chapter = await store.addChapter(b.id, s.id, {});
    await store.versionSet(
      b.id, `section:${s.id}:chapter:${chapter.id}`, `第${label}章正文`,
    );
    const saved = await store.readChapter(b.id, s.id, chapter.id);
    await store.applyChapterDigest(b.id, s.id, chapter.id, {
      summary: `第${label}章摘要`, progress: `第${label}章路标`, newCharacters: [],
    }, { expectedBodyFingerprint: saved.bodyFingerprint });
    chapters[index] = chapter;
  }

  await store.deleteChapter(b.id, s.id, chapters[1].id);

  const section = await store.readSection(b.id, s.id);
  assert.equal(section.summary, '第1章：第一章摘要\n第2章：第三章摘要');
  assert.deepEqual(section.chapters, [chapters[0].id, chapters[2].id]);
});

test('重写较早分部末章时只更新该分部路标，不覆盖全书末章路标', async () => {
  const b = await store.createBook({ premise: 'p' });
  const earlySection = await store.addSection(b.id, {});
  const early = await store.addChapter(b.id, earlySection.id, {});
  const lateSection = await store.addSection(b.id, {});
  const late = await store.addChapter(b.id, lateSection.id, {});
  const earlyPath = `section:${earlySection.id}:chapter:${early.id}`;
  const latePath = `section:${lateSection.id}:chapter:${late.id}`;
  await store.versionSet(b.id, earlyPath, '上一部旧正文');
  await store.versionSet(b.id, latePath, '当前部末章正文');
  let savedEarly = await store.readChapter(b.id, earlySection.id, early.id);
  const savedLate = await store.readChapter(b.id, lateSection.id, late.id);
  await store.applyChapterDigest(b.id, earlySection.id, early.id, {
    summary: '上一部旧摘要', progress: '上一部旧路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedEarly.bodyFingerprint });
  await store.applyChapterDigest(b.id, lateSection.id, late.id, {
    summary: '当前部摘要', progress: '全书最新路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedLate.bodyFingerprint });

  await store.versionSet(b.id, earlyPath, '上一部重写正文');
  savedEarly = await store.readChapter(b.id, earlySection.id, early.id);
  await store.applyChapterDigest(b.id, earlySection.id, early.id, {
    summary: '上一部新摘要', progress: '上一部重写路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedEarly.bodyFingerprint });

  assert.equal(
    (await store.readSection(b.id, earlySection.id)).progress,
    '上一部重写路标',
  );
  assert.equal((await store.readBook(b.id)).progress, '全书最新路标');
});

test('跨分部 digest 并发时全书路标始终归属正文顺序中的末章', async () => {
  const b = await store.createBook({ premise: 'p' });
  const earlySection = await store.addSection(b.id, {});
  const early = await store.addChapter(b.id, earlySection.id, {});
  const lateSection = await store.addSection(b.id, {});
  const late = await store.addChapter(b.id, lateSection.id, {});
  await store.versionSet(
    b.id, `section:${earlySection.id}:chapter:${early.id}`, '早期分部正文',
  );
  await store.versionSet(
    b.id, `section:${lateSection.id}:chapter:${late.id}`, '后期分部正文',
  );
  const [savedEarly, savedLate] = await Promise.all([
    store.readChapter(b.id, earlySection.id, early.id),
    store.readChapter(b.id, lateSection.id, late.id),
  ]);

  // 故意先发起末章 digest，再发起早期章节 digest。无论锁调度顺序
  // 如何，后完成的早期 digest 也不得把全书路标拉回去。
  await Promise.all([
    store.applyChapterDigest(b.id, lateSection.id, late.id, {
      summary: '后期摘要', progress: '全书末章路标', newCharacters: [],
    }, { expectedBodyFingerprint: savedLate.bodyFingerprint }),
    store.applyChapterDigest(b.id, earlySection.id, early.id, {
      summary: '早期摘要', progress: '早期章节路标', newCharacters: [],
    }, { expectedBodyFingerprint: savedEarly.bodyFingerprint }),
  ]);

  assert.equal((await store.readSection(b.id, earlySection.id)).progress, '早期章节路标');
  assert.equal((await store.readSection(b.id, lateSection.id)).progress, '全书末章路标');
  assert.equal((await store.readBook(b.id)).progress, '全书末章路标');
});

test('清空末章正文时分部和全书路标回到上一个非空章节', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const first = await store.addChapter(b.id, s.id, {});
  const last = await store.addChapter(b.id, s.id, {});
  const firstPath = `section:${s.id}:chapter:${first.id}`;
  const lastPath = `section:${s.id}:chapter:${last.id}`;
  await store.versionSet(b.id, firstPath, '上一章正文');
  await store.versionSet(b.id, lastPath, '末章正文');
  const [savedFirst, savedLast] = await Promise.all([
    store.readChapter(b.id, s.id, first.id),
    store.readChapter(b.id, s.id, last.id),
  ]);
  await store.applyChapterDigest(b.id, s.id, first.id, {
    summary: '上一章摘要', progress: '上一章路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedFirst.bodyFingerprint });
  await store.applyChapterDigest(b.id, s.id, last.id, {
    summary: '末章摘要', progress: '末章路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedLast.bodyFingerprint });

  const beforeClear = await store.readChapter(b.id, s.id, last.id);
  await store.versionSet(b.id, lastPath, '', {
    expectedRevision: store.versionRevision(beforeClear.body),
  });

  assert.equal((await store.readSection(b.id, s.id)).progress, '上一章路标');
  assert.equal((await store.readBook(b.id)).progress, '上一章路标');
});
