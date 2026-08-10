import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, mkdirSync, rmSync, symlinkSync, truncateSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as store from '../store.js';
import {
  MAX_BOOK_BACKUP_BYTES, MAX_BOOK_JSON_BYTES, MAX_CHAPTER_JSON_BYTES,
  MAX_CONFIG_JSON_BYTES, MAX_STORED_CHARACTERS,
  MAX_CHARACTER_NAME_CHARS, MAX_CHARACTER_ROLE_CHARS, MAX_CHARACTER_DESC_CHARS,
  MAX_VERSION_HISTORY_ITEMS, MAX_BOOK_DIRECTORY_ENTRIES, MAX_ID_CHARS,
  MAX_PREMISE_CHARS,
  MAX_STORAGE_DIAGNOSTIC_ISSUES,
  MAX_TITLE_CHARS, MAX_VERSION_TEXT_CHARS,
} from '../limits.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

test('并发映射失败后停止派发新任务并等待在途任务收尾', async () => {
  let markSecondStarted;
  const secondStarted = new Promise((resolve) => { markSecondStarted = resolve; });
  let releaseSecond;
  const secondBlocked = new Promise((resolve) => { releaseSecond = resolve; });
  const started = [];
  let settled = false;

  const operation = store.mapWithConcurrency([0, 1, 2], 2, async (item) => {
    started.push(item);
    if (item === 0) {
      await secondStarted;
      throw new Error('FIRST_WORKER_FAILED');
    }
    if (item === 1) {
      markSecondStarted();
      await secondBlocked;
    }
    return item;
  });
  void operation.finally(() => { settled = true; }).catch(() => {});

  await secondStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1]);

  releaseSecond();
  await assert.rejects(operation, /FIRST_WORKER_FAILED/);
  assert.equal(settled, true);
  assert.deepEqual(started, [0, 1]);
});

test('已取消的作品锁等待者立即退出队列且不阻塞后续请求', async () => {
  const book = await store.createBook({ premise: '取消作品锁等待' });
  const lockKey = `book:${book.id}:book-json`;
  let releaseHolder;
  let markHolderStarted;
  const holderStarted = new Promise((resolve) => { markHolderStarted = resolve; });
  const holder = store.withStoreLock(lockKey, async () => {
    markHolderStarted();
    await new Promise((resolve) => { releaseHolder = resolve; });
  });
  await holderStarted;

  const controller = new AbortController();
  const canceledRead = store.readBookStructure(book.id, { signal: controller.signal });
  controller.abort(new Error('CLIENT_ABORTED'));
  const cancellationResult = await Promise.race([
    canceledRead.then(() => 'resolved', (err) => err.message),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
  ]);

  let successorCalled = false;
  const successor = store.withStoreLock(lockKey, async () => {
    successorCalled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(successorCalled, false);

  releaseHolder();
  await Promise.allSettled([holder, canceledRead]);
  await successor;
  assert.equal(cancellationResult, 'CLIENT_ABORTED');
  assert.equal(successorCalled, true);
});

test('已取消的 JSON 读取等待者会移出全局队列', async () => {
  const book = await store.createBook({ premise: '取消排队读取' });
  const canceledBeforeRead = new AbortController();
  canceledBeforeRead.abort(new Error('CLIENT_ABORTED'));
  await assert.rejects(
    () => store.readBook(book.id, { signal: canceledBeforeRead.signal }),
    /CLIENT_ABORTED/,
  );

  let releaseFirst;
  let releaseSecond;
  let markFirstStarted;
  let markSecondStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const secondStarted = new Promise((resolve) => { markSecondStarted = resolve; });
  const first = store.withJsonReadSlot(async () => {
    markFirstStarted();
    await new Promise((resolve) => { releaseFirst = resolve; });
  });
  const second = store.withJsonReadSlot(async () => {
    markSecondStarted();
    await new Promise((resolve) => { releaseSecond = resolve; });
  });
  await Promise.all([firstStarted, secondStarted]);

  const controller = new AbortController();
  let queuedTaskCalled = false;
  const queued = store.withJsonReadSlot(async () => {
    queuedTaskCalled = true;
  }, { signal: controller.signal });
  controller.abort(new Error('CLIENT_ABORTED'));

  await assert.rejects(queued, /CLIENT_ABORTED/);
  assert.equal(queuedTaskCalled, false);

  releaseFirst();
  releaseSecond();
  await Promise.all([first, second]);
  await assert.doesNotReject(() => store.withJsonReadSlot(async () => {}));
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

test('createBook 通过暂存目录整书提交且不把内部标记带入作品', async () => {
  const book = await store.createBook({ premise: '原子建书', title: '完整作品' });

  assert.deepEqual(await readdir(join(root, 'books', book.id)), ['book.json']);
  assert.deepEqual(await readdir(join(root, '.imports')), []);
  assert.equal((await store.diagnoseStorage({ deep: true })).ok, true);
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

test('atomicWriteJson 改名失败时清理已刷盘的临时文件并保留目标目录', async () => {
  const target = join(root, 'occupied');
  mkdirSync(target);

  await assert.rejects(() => store.atomicWriteJson(target, { value: 'new' }));

  assert.equal((await stat(target)).isDirectory(), true);
  assert.deepEqual((await readdir(root)).sort(), ['occupied']);
});

test('atomicWriteJson 支持创建仅当前用户可读写的配置文件', async () => {
  const target = join(root, 'private.json');
  await store.atomicWriteJson(target, { apiKey: 'secret' }, { mode: 0o600 });

  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { apiKey: 'secret' });
});

test('新建作品目录和 JSON 默认仅当前用户可访问', {
  skip: process.platform === 'win32',
}, async () => {
  const book = await store.createBook({ premise: '私密故事', title: '私密作品' });
  const bookRoot = join(root, 'books', book.id);

  assert.equal((await stat(join(root, 'books'))).mode & 0o777, 0o700);
  assert.equal((await stat(bookRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(join(bookRoot, 'book.json'))).mode & 0o777, 0o600);
});

test('正常加载渐进收紧旧作品权限，完整性诊断仍保持只读', {
  skip: process.platform === 'win32',
}, async () => {
  const book = await store.createBook({ premise: '旧故事', title: '旧作品' });
  const section = await store.addSection(book.id, { title: '旧分部' });
  const chapter = await store.addChapter(book.id, section.id, { title: '旧章节' });
  const bookPath = join(root, 'books', book.id, 'book.json');
  const sectionPath = join(root, 'books', book.id, section.id, 'section.json');
  const chapterPath = join(root, 'books', book.id, section.id, `${chapter.id}.json`);
  const directories = [
    root,
    join(root, 'books'),
    join(root, 'books', book.id),
    join(root, 'books', book.id, section.id),
  ];
  for (const path of directories) chmodSync(path, 0o755);
  for (const path of [bookPath, sectionPath, chapterPath]) chmodSync(path, 0o644);

  assert.equal((await store.diagnoseStorage({ deep: true })).ok, true);
  for (const path of directories) {
    assert.equal((await stat(path)).mode & 0o777, 0o755);
  }
  for (const path of [bookPath, sectionPath, chapterPath]) {
    assert.equal((await stat(path)).mode & 0o777, 0o644);
  }

  await store.listBooks();
  for (const path of directories) {
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  }
  assert.equal((await stat(bookPath)).mode & 0o777, 0o600);
  assert.equal((await stat(sectionPath)).mode & 0o777, 0o600);
  assert.equal((await stat(chapterPath)).mode & 0o777, 0o644);

  await store.readChapter(book.id, section.id, chapter.id);
  assert.equal((await stat(chapterPath)).mode & 0o777, 0o600);
});

test('atomicWriteJson 不会写出超过对应本地文件上限的 JSON', async () => {
  const target = join(root, 'config.json');
  await assert.rejects(
    () => store.atomicWriteJson(target, { value: 'x'.repeat(MAX_CONFIG_JSON_BYTES) }),
    /STORAGE_FILE_TOO_LARGE/,
  );
  await assert.rejects(() => stat(target), { code: 'ENOENT' });
});

test('作品元数据上限覆盖全部合法版本历史且不放大备份传输边界', () => {
  // JSON.stringify 对控制字符或未配对代理项最多写成 6 字节转义。按所有
  // 受限文本都取该最坏值，再给字段名、数组标点和缩进留 1 MiB 余量。
  const worstCaseTextUnits = 5 * MAX_VERSION_HISTORY_ITEMS * MAX_VERSION_TEXT_CHARS
    + MAX_PREMISE_CHARS
    + MAX_STORED_CHARACTERS * (
      MAX_CHARACTER_NAME_CHARS + MAX_CHARACTER_ROLE_CHARS + MAX_CHARACTER_DESC_CHARS
    );
  const conservativeRequiredBytes = worstCaseTextUnits * 6 + 1024 * 1024;

  assert.ok(MAX_BOOK_JSON_BYTES >= conservativeRequiredBytes);
  assert.equal(MAX_BOOK_BACKUP_BYTES, 100 * 1024 * 1024);
  assert.ok(MAX_BOOK_JSON_BYTES > MAX_BOOK_BACKUP_BYTES);
});

test('listBooks 返回摘要', async () => {
  await store.createBook({ premise: 'p1', title: 'A' });
  await store.createBook({ premise: 'p2', title: 'B' });
  const list = await store.listBooks();
  assert.equal(list.length, 2);
  assert.ok(list.every((b) => b.id && b.title && b.updatedAt));
});

test('书架摘要和轻检流式扫描大型版本历史且不忽略后缀损坏', async () => {
  const book = await store.createBook({ premise: '大型摘要', title: '仍可见' });
  const section = await store.addSection(book.id, { title: '大型分部' });
  await store.addChapter(book.id, section.id, {});
  await store.addChapter(book.id, section.id, {});
  const repeated = 'x'.repeat(MAX_VERSION_TEXT_CHARS);
  const bookPath = join(root, 'books', book.id, 'book.json');
  const sectionPath = join(root, 'books', book.id, section.id, 'section.json');
  const storedBook = await store.readBook(book.id);
  const storedSection = await store.readSection(book.id, section.id);
  storedBook.outline = {
    versions: Array.from({ length: MAX_VERSION_HISTORY_ITEMS }, () => repeated),
    cursor: MAX_VERSION_HISTORY_ITEMS - 1,
  };
  storedSection.outline = {
    versions: Array.from({ length: MAX_VERSION_HISTORY_ITEMS }, () => repeated),
    cursor: MAX_VERSION_HISTORY_ITEMS - 1,
  };
  writeFileSync(bookPath, JSON.stringify(storedBook), 'utf8');
  writeFileSync(sectionPath, JSON.stringify(storedSection), 'utf8');

  const originalBufferConcat = Buffer.concat;
  Buffer.concat = (parts, length) => {
    if (Number(length) > 64 * 1024) throw new Error('FULL_BUFFER_CONCAT_FORBIDDEN');
    return originalBufferConcat(parts, length);
  };
  try {
    const fullyRead = await store.readBook(book.id);
    assert.equal(fullyRead.outline.versions.length, MAX_VERSION_HISTORY_ITEMS);
    assert.equal(fullyRead.outline.versions.at(-1), repeated);
  } finally {
    Buffer.concat = originalBufferConcat;
  }

  assert.deepEqual(await store.listBooks(), [{
    id: book.id,
    title: '仍可见',
    updatedAt: storedBook.updatedAt,
    sectionCount: 1,
    chapterCount: 2,
  }]);

  // 流式投影只会为键名和受限字段调用 JSON.parse；若轻检
  // 回退为整份解析，这个守卫会让它明确失败。
  const originalJsonParse = JSON.parse;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.length > 64 * 1024) {
      throw new Error('FULL_JSON_PARSE_FORBIDDEN');
    }
    return originalJsonParse(text, ...args);
  };
  try {
    const diagnostics = await store.diagnoseStorage();
    assert.equal(diagnostics.ok, true);
    assert.deepEqual(diagnostics.issues, []);
  } finally {
    JSON.parse = originalJsonParse;
  }

  writeFileSync(bookPath, `${JSON.stringify(storedBook)} trailing`, 'utf8');
  assert.deepEqual(await store.listBooks(), []);
  assert.ok((await store.diagnoseStorage()).issues.some((issue) =>
    issue.code === 'BOOK_METADATA_INVALID' && issue.bookId === book.id));
});

test('书架摘要扫描中途取消后不继续读取分部', async () => {
  const book = await store.createBook({ premise: '取消书架扫描' });
  await store.addSection(book.id, {});
  let checks = 0;
  const signal = {
    get aborted() {
      checks += 1;
      // 第六个取消点位于分部元数据读取完成后、汇总返回之前。
      return checks >= 6;
    },
    reason: new Error('CLIENT_ABORTED'),
  };

  await assert.rejects(() => store.listBooks({ signal }), /CLIENT_ABORTED/);
  assert.ok(checks >= 6);
  assert.equal((await store.listBooks())[0].id, book.id);
});

test('listBooks 忽略 books 下名称合法的普通文件', async () => {
  const book = await store.createBook({ premise: 'p', title: '正常作品' });
  writeFileSync(join(root, 'books', 'notes'), '这不是作品目录', 'utf8');

  const books = await store.listBooks();

  assert.deepEqual(books.map((item) => item.id), [book.id]);
  assert.equal((await store.diagnoseStorage()).ok, true);
});

test('正常书架和作品读写不跟随外部书籍目录链接', {
  skip: process.platform === 'win32',
}, async () => {
  const external = makeTestTempDir('novelbox-external-book-');
  const linkedBookId = 'book_linked';
  mkdirSync(join(root, 'books'), { recursive: true });
  writeFileSync(join(external, 'book.json'), JSON.stringify({
    id: linkedBookId, title: '外部秘密', updatedAt: new Date().toISOString(), sections: [],
  }), 'utf8');
  symlinkSync(external, join(root, 'books', linkedBookId), 'dir');

  assert.deepEqual(await store.listBooks(), []);
  await assert.rejects(() => store.readBook(linkedBookId), /STORAGE_PATH_UNSAFE/);
  await assert.rejects(
    () => store.writeBook(linkedBookId, { id: linkedBookId, sections: [] }),
    /STORAGE_PATH_UNSAFE/,
  );
  assert.equal(JSON.parse(await readFile(join(external, 'book.json'), 'utf8')).title, '外部秘密');
  assert.ok((await store.diagnoseStorage()).issues.some((issue) =>
    issue.code === 'BOOK_DIRECTORY_UNSAFE' && issue.bookId === linkedBookId));
});

test('元数据、分部和章节链接均不会越界读写', {
  skip: process.platform === 'win32',
}, async () => {
  const book = await store.createBook({ premise: 'p', title: '安全书' });
  const section = await store.addSection(book.id, { title: '安全部' });
  const chapter = await store.addChapter(book.id, section.id, { title: '安全章' });
  const bookRoot = join(root, 'books', book.id);
  const sectionRoot = join(bookRoot, section.id);
  const external = makeTestTempDir('novelbox-external-files-');
  const currentBook = await store.readBook(book.id);

  const externalBook = join(external, 'book.json');
  writeFileSync(externalBook, JSON.stringify({ ...currentBook, title: '外部书' }), 'utf8');
  unlinkSync(join(bookRoot, 'book.json'));
  symlinkSync(externalBook, join(bookRoot, 'book.json'), 'file');
  await assert.rejects(() => store.readBook(book.id), /STORAGE_PATH_UNSAFE/);
  await assert.rejects(() => store.writeBook(book.id, currentBook), /STORAGE_PATH_UNSAFE/);
  assert.equal(JSON.parse(await readFile(externalBook, 'utf8')).title, '外部书');
  assert.ok((await store.diagnoseStorage()).issues.some((issue) =>
    issue.code === 'BOOK_METADATA_UNSAFE' && issue.bookId === book.id));

  unlinkSync(join(bookRoot, 'book.json'));
  await store.atomicWriteJson(join(bookRoot, 'book.json'), currentBook);
  const externalSectionRoot = join(external, 'section');
  mkdirSync(externalSectionRoot);
  writeFileSync(join(externalSectionRoot, 'section.json'), JSON.stringify(section), 'utf8');
  rmSync(sectionRoot, { recursive: true });
  symlinkSync(externalSectionRoot, sectionRoot, 'dir');
  await assert.rejects(
    () => store.readReferencedSection(book.id, section.id), /STORAGE_PATH_UNSAFE/,
  );
  await assert.rejects(
    () => store.addChapter(book.id, section.id, {}), /STORAGE_PATH_UNSAFE/,
  );
  assert.deepEqual(JSON.parse(await readFile(join(externalSectionRoot, 'section.json'), 'utf8')).chapters, []);
  assert.ok((await store.diagnoseStorage()).issues.some((issue) =>
    issue.code === 'SECTION_METADATA_UNSAFE' && issue.sectionId === section.id));

  rmSync(sectionRoot);
  mkdirSync(sectionRoot);
  await store.atomicWriteJson(join(sectionRoot, 'section.json'), {
    ...section, chapters: [chapter.id],
  });
  const externalChapter = join(external, 'chapter.json');
  writeFileSync(externalChapter, JSON.stringify({ ...chapter, title: '外部章' }), 'utf8');
  symlinkSync(externalChapter, join(sectionRoot, `${chapter.id}.json`), 'file');
  await assert.rejects(
    () => store.readReferencedChapter(book.id, section.id, chapter.id),
    /STORAGE_PATH_UNSAFE/,
  );
  await assert.rejects(
    () => store.writeChapter(book.id, section.id, chapter.id, chapter),
    /STORAGE_PATH_UNSAFE/,
  );
  assert.equal(JSON.parse(await readFile(externalChapter, 'utf8')).title, '外部章');
  assert.ok((await store.diagnoseStorage()).issues.some((issue) =>
    issue.code === 'CHAPTER_FILE_UNSAFE' && issue.chapterId === chapter.id));
});

test('books 根目录链接时拒绝列表和创建，不写入外部位置', {
  skip: process.platform === 'win32',
}, async () => {
  const externalBooks = makeTestTempDir('novelbox-external-books-');
  symlinkSync(externalBooks, join(root, 'books'), 'dir');

  await assert.rejects(() => store.listBooks(), /STORAGE_PATH_UNSAFE/);
  await assert.rejects(
    () => store.createBook({ premise: 'p', title: '不应创建' }),
    /STORAGE_PATH_UNSAFE/,
  );
  assert.deepEqual(await store.diagnoseStorage(), {
    ok: false,
    mode: 'quick',
    scannedBooks: 0,
    totalBooks: 0,
    truncated: false,
    issueLimit: MAX_STORAGE_DIAGNOSTIC_ISSUES,
    issues: [{ code: 'BOOKS_DIRECTORY_UNSAFE', bookId: 'data/books' }],
  });
  assert.deepEqual(await readdir(externalBooks), []);
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

test('单本 book.json 形态异常由诊断报告且不阻断其它健康作品', async () => {
  const ok = await store.createBook({ premise: 'ok', title: '正常书' });
  const malformedId = 'book_invalid_shape';
  mkdirSync(join(root, 'books', malformedId, 'book.json'), { recursive: true });

  const list = await store.listBooks();
  assert.deepEqual(list.map((book) => book.id), [ok.id]);

  const diagnostics = await store.diagnoseStorage();
  assert.equal(diagnostics.ok, false);
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'BOOK_METADATA_INVALID_SHAPE' && issue.bookId === malformedId));
});

test('自动轻检报告会让作品从书架摘要消失的字段损坏', async () => {
  const ok = await store.createBook({ premise: 'ok', title: '正常书' });
  const damagedTitle = await store.createBook({ premise: '标题损坏' });
  const damagedUpdatedAt = await store.createBook({ premise: '时间损坏' });
  const damagedUpdatedAtString = await store.createBook({ premise: '时间字符串损坏' });
  for (const [book, field, value] of [
    [damagedTitle, 'title', { invalid: true }],
    [damagedUpdatedAt, 'updatedAt', ['invalid']],
    [damagedUpdatedAtString, 'updatedAt', 'not-a-date'],
  ]) {
    const path = join(root, 'books', book.id, 'book.json');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    stored[field] = value;
    writeFileSync(path, JSON.stringify(stored), 'utf8');
  }

  assert.deepEqual((await store.listBooks()).map((book) => book.id), [ok.id]);

  for (const deep of [false, true]) {
    const diagnostics = await store.diagnoseStorage({ deep });
    assert.equal(diagnostics.ok, false);
    for (const damaged of [damagedTitle, damagedUpdatedAt, damagedUpdatedAtString]) {
      assert.equal(diagnostics.issues.filter((issue) =>
        issue.code === 'BOOK_DATA_INVALID' && issue.bookId === damaged.id).length, 1);
    }
  }
});

test('自动轻检报告会让作品树无法打开的分部标题损坏', async () => {
  const book = await store.createBook({ premise: '分部标题损坏' });
  const section = await store.addSection(book.id, { title: '原标题' });
  const sectionPath = join(root, 'books', book.id, section.id, 'section.json');
  const stored = JSON.parse(await readFile(sectionPath, 'utf8'));
  stored.title = { invalid: true };
  stored.summary = '大型聚合'.repeat(30_000);
  writeFileSync(sectionPath, JSON.stringify(stored), 'utf8');

  const originalJsonParse = JSON.parse;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.length > 64 * 1024) {
      throw new Error('FULL_SECTION_JSON_PARSE_FORBIDDEN');
    }
    return originalJsonParse(text, ...args);
  };
  try {
    const diagnostics = await store.diagnoseStorage();
    assert.equal(diagnostics.ok, false);
    assert.equal(diagnostics.issues.filter((issue) =>
      issue.code === 'SECTION_DATA_INVALID'
      && issue.bookId === book.id
      && issue.sectionId === section.id).length, 1);
  } finally {
    JSON.parse = originalJsonParse;
  }
  const deepDiagnostics = await store.diagnoseStorage({ deep: true });
  assert.equal(deepDiagnostics.issues.filter((issue) =>
    issue.code === 'SECTION_DATA_INVALID'
    && issue.bookId === book.id
    && issue.sectionId === section.id).length, 1);
  await assert.rejects(() => store.readBookStructure(book.id), /STORAGE_DATA_INVALID/);
});

test('本地 JSON 的非法 UTF-8 不会被静默替换，深度诊断明确报告且不改盘', async () => {
  const book = await store.createBook({ premise: '字节损坏检测' });
  const section = await store.addSection(book.id, {});
  const chapter = await store.addChapter(book.id, section.id, {});
  const path = `section:${section.id}:chapter:${chapter.id}`;
  await store.versionSet(book.id, path, '可信正文');
  const chapterPath = join(
    root, 'books', book.id, section.id, `${chapter.id}.json`,
  );
  const damaged = await readFile(chapterPath);
  const textOffset = damaged.indexOf(Buffer.from('可信正文'));
  assert.ok(textOffset >= 0);
  damaged[textOffset] = 0xff;
  writeFileSync(chapterPath, damaged);

  await assert.rejects(
    () => store.readChapter(book.id, section.id, chapter.id),
    (error) => error instanceof SyntaxError && /invalid UTF-8/.test(error.message),
  );
  const diagnostics = await store.diagnoseStorage({ deep: true });
  assert.equal(diagnostics.ok, false);
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'CHAPTER_FILE_INVALID' && issue.chapterId === chapter.id));
  assert.equal((await readFile(chapterPath))[textOffset], 0xff);
});

test('异常大的书籍文件不会被载入内存，并由书架诊断明确报告', async () => {
  const ok = await store.createBook({ premise: 'ok', title: '正常书' });
  const hugeId = 'book_huge';
  const hugeDir = join(root, 'books', hugeId);
  const hugePath = join(hugeDir, 'book.json');
  mkdirSync(hugeDir, { recursive: true });
  writeFileSync(hugePath, '{}', 'utf8');
  truncateSync(hugePath, MAX_BOOK_JSON_BYTES + 1);

  assert.deepEqual((await store.listBooks()).map((book) => book.id), [ok.id]);
  await assert.rejects(() => store.readBook(hugeId), /STORAGE_FILE_TOO_LARGE/);
  const diagnostics = await store.diagnoseStorage();
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'BOOK_METADATA_TOO_LARGE' && issue.bookId === hugeId));
});

test('diagnoseStorage 对完整数据返回健康结果', async () => {
  const book = await store.createBook({ premise: 'ok', title: '正常书' });
  const section = await store.addSection(book.id, {});
  await store.addChapter(book.id, section.id, {});

  const diagnostics = await store.diagnoseStorage();
  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.mode, 'quick');
  assert.equal(diagnostics.scannedBooks, 1);
  assert.deepEqual(diagnostics.issues, []);
});

test('深检大型书部章数据不深克隆刚解析的完整对象', async () => {
  const book = await store.createBook({ premise: '低峰值深检', title: '大型完整数据' });
  const section = await store.addSection(book.id, { title: '大型分部' });
  const chapter = await store.addChapter(book.id, section.id, { title: '大型章节' });
  const repeated = 'x'.repeat(Math.min(MAX_VERSION_TEXT_CHARS, 150_000));

  const storedBook = await store.readBook(book.id);
  storedBook.outline = { versions: [repeated, repeated], cursor: 1 };
  await store.writeBook(book.id, storedBook);
  const storedSection = await store.readSection(book.id, section.id);
  storedSection.summary = repeated;
  await store.writeSection(book.id, section.id, storedSection);
  const storedChapter = await store.readChapter(book.id, section.id, chapter.id);
  storedChapter.body = { versions: [repeated, repeated], cursor: 1 };
  await store.writeChapter(book.id, section.id, chapter.id, storedChapter);

  const originalStructuredClone = globalThis.structuredClone;
  globalThis.structuredClone = (value, ...args) => {
    const containsLargeStoredJson = value?.outline?.versions?.some?.(
      (text) => text.length > 64 * 1024,
    ) || value?.body?.versions?.some?.((text) => text.length > 64 * 1024)
      || (typeof value?.summary === 'string' && value.summary.length > 64 * 1024);
    if (containsLargeStoredJson) throw new Error('LARGE_DIAGNOSTIC_CLONE_FORBIDDEN');
    return originalStructuredClone(value, ...args);
  };
  let diagnostics;
  try {
    diagnostics = await store.diagnoseStorage({ deep: true });
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }

  assert.equal(diagnostics.ok, true);
  assert.deepEqual(diagnostics.issues, []);
});

test('完整性检查在空书架也会报告配置原子写入残留', async () => {
  const uuid = '00000000-0000-4000-8000-000000000001';
  const configTemp = `config.json.123.1700000000000.${uuid}.tmp`;
  const ignored = `settings.json.123.1700000000000.${uuid}.tmp`;
  writeFileSync(join(root, configTemp), '未提交配置', 'utf8');
  writeFileSync(join(root, ignored), '普通文件', 'utf8');

  for (const deep of [false, true]) {
    const diagnostics = await store.diagnoseStorage({ deep });
    assert.deepEqual(diagnostics, {
      ok: false,
      mode: deep ? 'deep' : 'quick',
      scannedBooks: 0,
      totalBooks: 0,
      truncated: false,
      issueLimit: MAX_STORAGE_DIAGNOSTIC_ISSUES,
      issues: [{
        code: 'ATOMIC_WRITE_TEMP_PENDING', bookId: 'data', path: configTemp,
      }],
    });
  }
  assert.equal(await readFile(join(root, configTemp), 'utf8'), '未提交配置');
  assert.equal(await readFile(join(root, ignored), 'utf8'), '普通文件');
});

test('完整性检查报告正式配置文件损坏与字段越界但不泄露 Key', async () => {
  const path = join(root, 'config.json');

  writeFileSync(path, '{bad json', 'utf8');
  let diagnostics = await store.diagnoseStorage();
  assert.deepEqual(diagnostics.issues, [{
    code: 'CONFIG_METADATA_INVALID', bookId: 'data/config.json',
  }]);

  writeFileSync(path, JSON.stringify({
    baseUrl: 'http://remote.example/v1', model: 'm', apiKey: 'sk-never-expose-this',
  }), 'utf8');
  diagnostics = await store.diagnoseStorage({ deep: true });
  assert.deepEqual(diagnostics.issues, [{
    code: 'CONFIG_DATA_INVALID', bookId: 'data/config.json',
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /never-expose|remote\.example/);

  writeFileSync(path, JSON.stringify({
    baseUrl: '', model: '', apiKey: '', extra: 'compatible-unknown-field',
  }), 'utf8');
  assert.equal((await store.diagnoseStorage()).ok, true);

  writeFileSync(path, '{}', 'utf8');
  truncateSync(path, MAX_CONFIG_JSON_BYTES + 1);
  diagnostics = await store.diagnoseStorage();
  assert.deepEqual(diagnostics.issues, [{
    code: 'CONFIG_METADATA_TOO_LARGE', bookId: 'data/config.json',
  }]);

  unlinkSync(path);
  mkdirSync(path);
  diagnostics = await store.diagnoseStorage();
  assert.deepEqual(diagnostics.issues, [{
    code: 'CONFIG_METADATA_INVALID_SHAPE', bookId: 'data/config.json',
  }]);
});

test('完整性检查不跟随正式配置文件链接', {
  skip: process.platform === 'win32',
}, async () => {
  const external = join(makeTestTempDir('novelbox-config-diagnostic-'), 'outside.json');
  writeFileSync(external, JSON.stringify({ apiKey: 'sk-external-secret' }), 'utf8');
  symlinkSync(external, join(root, 'config.json'), 'file');

  const diagnostics = await store.diagnoseStorage();

  assert.deepEqual(diagnostics.issues, [{
    code: 'CONFIG_METADATA_UNSAFE', bookId: 'data/config.json',
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /external-secret/);
  assert.match(await readFile(external, 'utf8'), /external-secret/);
});

test('完整性检查暴露原子写入崩溃残留但不删除或误报普通临时文件', async () => {
  const book = await store.createBook({ premise: '原子残留诊断' });
  const section = await store.addSection(book.id, {});
  const uuid = '00000000-0000-4000-8000-000000000001';
  const bookTemp = `book.json.123.1700000000000.${uuid}.tmp`;
  const sectionTemp = `section.json.456.1700000000001.${uuid}.tmp`;
  const ignored = `notes.txt.789.1700000000002.${uuid}.tmp`;
  const bookRoot = join(root, 'books', book.id);
  const sectionRoot = join(bookRoot, section.id);
  writeFileSync(join(bookRoot, bookTemp), '未提交作品数据', 'utf8');
  writeFileSync(join(sectionRoot, sectionTemp), '未提交分部数据', 'utf8');
  writeFileSync(join(bookRoot, ignored), '普通文件', 'utf8');

  for (const deep of [false, true]) {
    const diagnostics = await store.diagnoseStorage({ deep });
    assert.equal(diagnostics.ok, false);
    assert.deepEqual(diagnostics.issues.filter((issue) =>
      issue.code === 'ATOMIC_WRITE_TEMP_PENDING'), [
      { code: 'ATOMIC_WRITE_TEMP_PENDING', bookId: book.id, path: bookTemp },
      {
        code: 'ATOMIC_WRITE_TEMP_PENDING', bookId: book.id,
        sectionId: section.id, path: sectionTemp,
      },
    ]);
  }
  assert.equal(await readFile(join(bookRoot, bookTemp), 'utf8'), '未提交作品数据');
  assert.equal(await readFile(join(sectionRoot, sectionTemp), 'utf8'), '未提交分部数据');
  assert.equal(await readFile(join(bookRoot, ignored), 'utf8'), '普通文件');
});

test('完整性检查不跟随伪装成原子写入残留的链接', {
  skip: process.platform === 'win32',
}, async () => {
  const book = await store.createBook({ premise: '原子残留链接' });
  const external = join(makeTestTempDir('novelbox-atomic-temp-'), 'outside.json');
  writeFileSync(external, '外部内容', 'utf8');
  const name = 'book.json.123.1700000000000.00000000-0000-4000-8000-000000000001.tmp';
  symlinkSync(external, join(root, 'books', book.id, name), 'file');

  const diagnostics = await store.diagnoseStorage();

  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'ATOMIC_WRITE_TEMP_UNSAFE'
      && issue.bookId === book.id && issue.path === name));
  assert.equal(await readFile(external, 'utf8'), '外部内容');
});

test('正式元数据同时损坏时仍会报告同目录原子写入残留', async () => {
  const book = await store.createBook({ premise: '组合故障' });
  const section = await store.addSection(book.id, {});
  const currentSection = await store.readSection(book.id, section.id);
  const uuid = '00000000-0000-4000-8000-000000000001';
  const bookTemp = `book.json.123.1700000000000.${uuid}.tmp`;
  const sectionTemp = `section.json.456.1700000000001.${uuid}.tmp`;
  const bookRoot = join(root, 'books', book.id);
  const sectionRoot = join(bookRoot, section.id);
  writeFileSync(join(bookRoot, bookTemp), '可取证作品临时数据', 'utf8');
  writeFileSync(join(sectionRoot, sectionTemp), '可取证分部临时数据', 'utf8');

  writeFileSync(join(sectionRoot, 'section.json'), '{ damaged section', 'utf8');
  for (const deep of [false, true]) {
    const diagnostics = await store.diagnoseStorage({ deep });
    assert.ok(diagnostics.issues.some((issue) =>
      issue.code === 'SECTION_METADATA_INVALID' && issue.sectionId === section.id));
    assert.ok(diagnostics.issues.some((issue) =>
      issue.code === 'ATOMIC_WRITE_TEMP_PENDING'
        && issue.sectionId === section.id && issue.path === sectionTemp));
  }

  writeFileSync(join(sectionRoot, 'section.json'), JSON.stringify(currentSection), 'utf8');
  writeFileSync(join(bookRoot, 'book.json'), '{ damaged book', 'utf8');
  for (const deep of [false, true]) {
    const diagnostics = await store.diagnoseStorage({ deep });
    assert.ok(diagnostics.issues.some((issue) =>
      issue.code === 'BOOK_METADATA_INVALID' && issue.bookId === book.id));
    assert.ok(diagnostics.issues.some((issue) =>
      issue.code === 'ATOMIC_WRITE_TEMP_PENDING'
        && issue.bookId === book.id && issue.path === bookTemp));
  }

  assert.equal(await readFile(join(bookRoot, bookTemp), 'utf8'), '可取证作品临时数据');
  assert.equal(await readFile(join(sectionRoot, sectionTemp), 'utf8'), '可取证分部临时数据');
});

test('diagnoseStorage 异常明细超限时有界停止并显式标记截断', async () => {
  const book = await store.createBook({ premise: '大量异常诊断' });
  const section = await store.addSection(book.id, {});
  section.chapters = Array.from(
    { length: MAX_STORAGE_DIAGNOSTIC_ISSUES + 37 },
    (_, index) => `missing-${index}`,
  );
  writeFileSync(
    join(root, 'books', book.id, section.id, 'section.json'),
    JSON.stringify(section),
    'utf8',
  );

  for (const deep of [false, true]) {
    const diagnostics = await store.diagnoseStorage({ deep });
    assert.equal(diagnostics.ok, false);
    assert.equal(diagnostics.truncated, true);
    assert.equal(diagnostics.issueLimit, MAX_STORAGE_DIAGNOSTIC_ISSUES);
    assert.equal(diagnostics.issues.length, MAX_STORAGE_DIAGNOSTIC_ISSUES);
    assert.equal(diagnostics.scannedBooks, 1);
    assert.equal(diagnostics.totalBooks, 1);
    assert.ok(diagnostics.issues.every((issue) => issue.code === 'CHAPTER_FILE_MISSING'));
    assert.ok(Buffer.byteLength(JSON.stringify(diagnostics), 'utf8') < 100_000);
  }
});

test('diagnoseStorage 对异常过多的作品目录子项停止有界枚举', async () => {
  const book = await store.createBook({ premise: '目录基数防护' });
  const rootDir = join(root, 'books', book.id);
  // book.json 占一项，再创建 maxEntries 个目录，使第 maxEntries + 1 项触发上限。
  for (let index = 0; index < MAX_BOOK_DIRECTORY_ENTRIES; index += 1) {
    mkdirSync(join(rootDir, `orphan-${index}`));
  }

  const diagnostics = await store.diagnoseStorage();

  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.truncated, false);
  assert.deepEqual(diagnostics.issues, [{
    code: 'BOOK_DIRECTORY_LIMIT_EXCEEDED', bookId: book.id,
  }]);
});

test('目录无法枚举时快检和深检都不会把不完整扫描报告为健康', {
  skip: process.platform === 'win32',
}, async () => {
  const unreadableBook = await store.createBook({ premise: '作品目录不可枚举' });
  const bookSection = await store.addSection(unreadableBook.id, {});
  await store.addChapter(unreadableBook.id, bookSection.id, {});
  const unreadableSectionBook = await store.createBook({ premise: '分部目录不可枚举' });
  const unreadableSection = await store.addSection(unreadableSectionBook.id, {});
  await store.addChapter(unreadableSectionBook.id, unreadableSection.id, {});
  const bookRoot = join(root, 'books', unreadableBook.id);
  const sectionRoot = join(
    root, 'books', unreadableSectionBook.id, unreadableSection.id,
  );

  chmodSync(bookRoot, 0o100);
  chmodSync(sectionRoot, 0o100);
  try {
    for (const deep of [false, true]) {
      const diagnostics = await store.diagnoseStorage({ deep });
      assert.equal(diagnostics.ok, false);
      assert.ok(diagnostics.issues.some((issue) =>
        issue.code === 'BOOK_DIRECTORY_UNREADABLE'
          && issue.bookId === unreadableBook.id));
      assert.ok(diagnostics.issues.some((issue) =>
        issue.code === 'SECTION_DIRECTORY_UNREADABLE'
          && issue.bookId === unreadableSectionBook.id
          && issue.sectionId === unreadableSection.id));
    }
  } finally {
    chmodSync(bookRoot, 0o700);
    chmodSync(sectionRoot, 0o700);
  }
});

test('作品根目录无法枚举时诊断返回结构化风险而不是自身失败', {
  skip: process.platform === 'win32',
}, async () => {
  const book = await store.createBook({ premise: '作品根目录不可枚举' });
  const booksRoot = join(root, 'books');

  chmodSync(booksRoot, 0o100);
  try {
    for (const deep of [false, true]) {
      const diagnostics = await store.diagnoseStorage({ deep });
      assert.deepEqual(diagnostics, {
        ok: false,
        mode: deep ? 'deep' : 'quick',
        scannedBooks: 0,
        totalBooks: 0,
        truncated: false,
        issueLimit: MAX_STORAGE_DIAGNOSTIC_ISSUES,
        issues: [{
          code: 'BOOKS_DIRECTORY_UNREADABLE', bookId: 'data/books',
        }],
      });
    }
  } finally {
    chmodSync(booksRoot, 0o700);
  }

  assert.equal((await store.listBooks()).some((entry) => entry.id === book.id), true);
});

test('diagnoseStorage 报告损坏书、缺失章节和孤立文件但不改盘', async () => {
  const book = await store.createBook({ premise: 'ok', title: '正常书' });
  const section = await store.addSection(book.id, {});
  await store.addChapter(book.id, section.id, {});

  const sectionPath = join(root, 'books', book.id, section.id, 'section.json');
  const sectionJson = JSON.parse(await readFile(sectionPath, 'utf8'));
  sectionJson.chapters.push('chapter-99');
  writeFileSync(sectionPath, JSON.stringify(sectionJson), 'utf8');
  writeFileSync(
    join(root, 'books', book.id, section.id, 'chapter-88.json'),
    JSON.stringify({ id: 'chapter-88' }),
    'utf8',
  );

  const badDir = join(root, 'books', 'book_bad');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'book.json'), '{ bad json', 'utf8');

  const diagnostics = await store.diagnoseStorage();
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.scannedBooks, 2);
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'BOOK_METADATA_INVALID' && issue.bookId === 'book_bad'));
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'CHAPTER_FILE_MISSING' && issue.chapterId === 'chapter-99'));
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'CHAPTER_FILE_ORPHANED' && issue.chapterId === 'chapter-88'));
  assert.equal(await readFile(join(badDir, 'book.json'), 'utf8'), '{ bad json');
});

test('快速诊断不读取完整章节正文，深度诊断显式检查 JSON 与内容边界', async () => {
  const book = await store.createBook({ premise: '诊断模式' });
  const section = await store.addSection(book.id, {});
  const chapter = await store.addChapter(book.id, section.id, {});
  const chapterPath = join(root, 'books', book.id, section.id, `${chapter.id}.json`);

  writeFileSync(chapterPath, '{ invalid chapter json', 'utf8');
  const quick = await store.diagnoseStorage();
  assert.equal(quick.mode, 'quick');
  assert.equal(quick.ok, true);

  const invalidJson = await store.diagnoseStorage({ deep: true });
  assert.equal(invalidJson.mode, 'deep');
  assert.equal(invalidJson.ok, false);
  assert.ok(invalidJson.issues.some((issue) =>
    issue.code === 'CHAPTER_FILE_INVALID' && issue.chapterId === chapter.id));

  writeFileSync(chapterPath, JSON.stringify({
    ...chapter,
    body: { versions: ['x'.repeat(MAX_VERSION_TEXT_CHARS + 1)], cursor: 0 },
  }), 'utf8');
  const oversized = await store.diagnoseStorage({ deep: true });
  assert.ok(oversized.issues.some((issue) =>
    issue.code === 'CHAPTER_DATA_INVALID' && issue.chapterId === chapter.id));

  truncateSync(chapterPath, MAX_CHAPTER_JSON_BYTES + 1);
  const tooLarge = await store.diagnoseStorage({ deep: true });
  assert.ok(tooLarge.issues.some((issue) =>
    issue.code === 'CHAPTER_FILE_TOO_LARGE' && issue.chapterId === chapter.id));
  await assert.rejects(
    () => store.readChapter(book.id, section.id, chapter.id),
    /STORAGE_FILE_TOO_LARGE/,
  );
});

test('diagnoseStorage 报告非法超长作品目录而不是忽略或整体失败', async () => {
  const invalidId = 'b'.repeat(MAX_ID_CHARS + 1);
  mkdirSync(join(root, 'books', invalidId), { recursive: true });
  writeFileSync(join(root, 'books', invalidId, 'book.json'), '{}', 'utf8');

  const diagnostics = await store.diagnoseStorage();
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.scannedBooks, 0);
  assert.deepEqual(diagnostics.issues, [{
    code: 'BOOK_DIRECTORY_ID_INVALID', bookId: invalidId,
  }]);
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

test('safeId 拒绝会覆盖分部元数据或映射为 Windows 设备的保留名', () => {
  for (const id of ['section', 'SECTION', 'con', 'NUL', 'com1', 'Lpt9']) {
    assert.throws(() => store.safeId(id), /BAD_ID/);
  }
  assert.equal(store.safeId('section-1'), 'section-1');
  assert.equal(store.safeId('com10'), 'com10');
});

test('readSection 遇到非法 sectionId 抛 BAD_ID', async () => {
  const book = await store.createBook({ premise: 'p', title: 't' });
  await assert.rejects(() => store.readSection(book.id, '../evil'), /BAD_ID/);
  await assert.rejects(() => store.readChapter(book.id, 'section-01', '../evil'), /BAD_ID/);
});

test('存储层拒绝超长 ID、故事设想、标题和版本正文', async () => {
  assert.throws(() => store.safeId('a'.repeat(MAX_ID_CHARS + 1)), /BAD_ID/);
  await assert.rejects(
    () => store.createBook({ premise: 'p'.repeat(MAX_PREMISE_CHARS + 1) }),
    /PREMISE_TOO_LARGE/,
  );
  await assert.rejects(
    () => store.createBook({ premise: 'p', title: 't'.repeat(MAX_TITLE_CHARS + 1) }),
    /TITLE_TOO_LARGE/,
  );

  const book = await store.createBook({ premise: 'p' });
  await assert.rejects(
    () => store.versionSet(book.id, 'outline', 'x'.repeat(MAX_VERSION_TEXT_CHARS + 1)),
    /TEXT_TOO_LARGE/,
  );
  assert.deepEqual((await store.readBook(book.id)).outline.versions, ['']);
});
